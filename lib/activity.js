// lib/activity.js — send/open/reply event log in Upstash Redis
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const LIST = 'dwm:activity';

async function redis(cmd) {
  if (!URL_ || !TOKEN) return null;
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!res.ok) return null;
  return (await res.json()).result;
}


/**
 * Several commands, one round trip. Upstash's REST API charges a full HTTP
 * request per command otherwise, and at 150 contacts a run that was the dominant
 * cost of the whole cron — HubSpot is three batched calls now, Gmail and the SMS
 * provider are fast, and the rest was Redis chatter.
 */
async function pipe(cmds) {
  if (!URL_ || !TOKEN || !cmds.length) return null;
  try {
    const res = await fetch(`${URL_}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds)
    });
    if (!res.ok) return null;
    return (await res.json()).map(r => r?.result);
  } catch { return null; }
}

/** Log an event: { type: 'sent'|'opened'|'replied'|'error', contact, campaign, step, sender, detail } */
export async function logEvent(evt) {
  try {
    await pipe([
      ['LPUSH', LIST, JSON.stringify({ t: Date.now(), ...evt })],
      ['LTRIM', LIST, '0', '1999']
    ]);
  } catch { /* activity logging never blocks sends */ }
}

export async function getEvents(n = 300) {
  const raw = await redis(['LRANGE', LIST, '0', String(n - 1)]);
  return (raw || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

/** Store per-send metadata so the open pixel can identify the send without PII in the URL. */
export async function rememberSend(sendId, meta) {
  // sentAt lets api/px.js compute time-from-send-to-open without a second lookup.
  const withTime = { sentAt: Date.now(), ...meta };
  await redis(['SET', `dwm:send:${sendId}`, JSON.stringify(withTime), 'EX', String(90 * 86400)]);
}

export async function lookupSend(sendId) {
  const raw = await redis(['GET', `dwm:send:${sendId}`]);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/** True only the first time this send is opened (dedupes multi-opens). */
export async function markOpenedOnce(sendId) {
  const r = await redis(['SET', `dwm:open:${sendId}`, '1', 'NX', 'EX', String(90 * 86400)]);
  return r === 'OK';
}

/** Timestamp of the last send to a contact (for reply-search window). */
/**
 * Marker for "when did we last send to this contact IN THIS CAMPAIGN".
 *
 * This used to be per-contact only, which broke re-enrolment. Reply detection asks
 * "has anything come in since our last send?" — with a contact-wide marker, someone who
 * replied after an earlier sequence looked like they had just replied to the new one, so
 * the app unenrolled them within a minute of being added. It even overrode a human
 * enrolling them by hand. Scoping to the campaign means a fresh enrolment starts clean:
 * no send yet in this campaign, so nothing to have replied to.
 *
 * The old unscoped key is still written, so anything else reading it keeps working.
 */
export async function rememberLastSend(contactId, campaign) {
  const now = String(Date.now());
  const ttl = String(120 * 86400);
  await redis(['SET', `dwm:last:${contactId}`, now, 'EX', ttl]);
  if (campaign) await redis(['SET', `dwm:last:${contactId}:${campaign}`, now, 'EX', ttl]);
}

/** Pass the campaign to get the scoped marker. Without it, the legacy contact-wide one. */
export async function getLastSend(contactId, campaign) {
  const key = campaign ? `dwm:last:${contactId}:${campaign}` : `dwm:last:${contactId}`;
  const raw = await redis(['GET', key]);
  return raw ? parseInt(raw, 10) : null;
}

/** Persistent all-time counters, total + per-campaign. */
export async function bumpStat(campaign, type) {
  try {
    await redis(['HINCRBY', 'dwm:stats:total', type, '1']);
    if (campaign) {
      await redis(['HINCRBY', `dwm:stats:camp:${campaign}`, type, '1']);
      await redis(['SADD', 'dwm:stats:campaigns', campaign]);
    }
  } catch { /* stats never block */ }
}

export async function getAllTimeStats() {
  const toObj = arr => { const o = {}; for (let i = 0; i < (arr || []).length; i += 2) o[arr[i]] = parseInt(arr[i + 1], 10) || 0; return o; };
  const total = toObj(await redis(['HGETALL', 'dwm:stats:total']));
  const names = (await redis(['SMEMBERS', 'dwm:stats:campaigns'])) || [];
  const perCampaign = {};
  for (const name of names) perCampaign[name] = toObj(await redis(['HGETALL', `dwm:stats:camp:${name}`]));
  return { total, perCampaign };
}

/** True if this contact hasn't been reply-checked in the last `hours` (and marks it checked). */
export async function shouldReplyCheck(contactId, hours = 4) {
  const r = await redis(['SET', `dwm:rchk:${contactId}`, '1', 'NX', 'EX', String(hours * 3600)]);
  return r === 'OK';
}

// ── Per-step failure counter ────────────────────────────────────────────────
// A send that fails permanently (dead phone number, malformed address) used to return an
// error without advancing the sequence, so dw_next_send stayed in the past and the cron
// retried the same doomed send every five minutes, forever. These let a step give up.
const FAIL_TTL = 14 * 86400;

export async function bumpFailure(contactId, campaign, step) {
  const k = `dwm:fail:${contactId}:${campaign}:${step}`;
  const n = await redis(['INCR', k]);
  await redis(['EXPIRE', k, String(FAIL_TTL)]);
  return Number(n) || 1;
}

export async function clearFailures(contactId, campaign, step) {
  await redis(['DEL', `dwm:fail:${contactId}:${campaign}:${step}`]);
}

// ── Timeline engagement pointer ──────────────────────────────────────────────
// Ties a sendId to the HubSpot email-engagement record it was logged as, plus the
// original body, so api/px.js and api/c.js can PATCH the SAME record on an open/click
// instead of creating anything new.
export async function rememberEngagement(sendId, emailId, originalText, originalHtml) {
  if (!sendId || !emailId) return;
  // Stored PRISTINE, once, at send time. Every open/click rebuilds the summary from this
  // copy rather than re-reading the currently-live (already-patched) HubSpot record, so
  // repeated patches stay idempotent no matter how many times they fire.
  await redis(['SET', `dwm:eng:${sendId}`,
    JSON.stringify({
      emailId,
      originalText: String(originalText || '').slice(0, 4000),
      // Marketing designs are a full HTML document, not a short snippet — 4000 chars
      // would truncate mid-template. Capped higher, still bounded so a runaway template
      // can't blow past what's sane to store.
      originalHtml: originalHtml ? String(originalHtml).slice(0, 60000) : null
    }),
    'EX', String(90 * 86400)]);
}

export async function getEngagement(sendId) {
  const raw = await redis(['GET', `dwm:eng:${sendId}`]);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
