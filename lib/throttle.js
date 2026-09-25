const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!res.ok) throw new Error(`Redis error ${res.status}`);
  return (await res.json()).result;
}

const DAILY_CAP = parseInt(process.env.MARKETING_DAILY_CAP || '400', 10);
const PER_TICK = parseInt(process.env.MARKETING_PER_TICK || '20', 10);

/**
 * Warm-up ramp. A brand-new sending pattern should start small and grow, or the first
 * big send defines your reputation before you have any positive engagement history.
 * Set MARKETING_WARMUP_START=2026-08-01 and the cap climbs from 25/day to the full
 * DAILY_CAP over about two weeks. Leave it unset to skip the ramp entirely.
 */
const RAMP = [25, 40, 60, 90, 130, 180, 240, 300, 360];

export function effectiveDailyCap(now = new Date()) {
  const start = process.env.MARKETING_WARMUP_START;
  if (!start) return DAILY_CAP;
  const t0 = Date.parse(start + 'T00:00:00Z');
  if (isNaN(t0)) return DAILY_CAP;
  const days = Math.floor((now.getTime() - t0) / 86400000);
  if (days < 0) return RAMP[0];
  if (days >= RAMP.length) return DAILY_CAP;
  return Math.min(DAILY_CAP, RAMP[days]);
}

function dayKey(sender, now) {
  const d = now.toISOString().slice(0, 10);
  return `dogwise:cap:${sender.toLowerCase()}:${d}`;
}

function tickKey(sender, now) {
  const bucket = Math.floor(now.getTime() / (5 * 60 * 1000));
  return `dogwise:pace:${sender.toLowerCase()}:${bucket}`;
}

/**
 * May `senderEmail` send one more marketing email right now?
 * Read-only — call recordMarketingSend() after a send actually succeeds.
 * Fails OPEN: if Redis is unreachable we allow the send rather than stall the sequence.
 *
 * @returns {Promise<{ok:boolean, reason?:string, sentToday?:number, cap?:number}>}
 */
export async function marketingGate(senderEmail, now = new Date()) {
  if (!URL_ || !TOKEN) return { ok: true };
  try {
    const cap = effectiveDailyCap(now);
    const [dayRaw, tickRaw] = await Promise.all([
      redis(['GET', dayKey(senderEmail, now)]),
      redis(['GET', tickKey(senderEmail, now)])
    ]);
    const sentToday = parseInt(dayRaw || '0', 10);
    const sentTick = parseInt(tickRaw || '0', 10);

    if (sentToday >= cap) {
      return { ok: false, reason: `daily marketing cap reached for ${senderEmail} (${sentToday}/${cap})`, sentToday, cap };
    }
    if (sentTick >= PER_TICK) {
      return { ok: false, reason: `pacing — ${senderEmail} already sent ${sentTick} marketing emails in this 5-minute window`, sentToday, cap };
    }
    return { ok: true, sentToday, cap };
  } catch {
    return { ok: true }; // fail open
  }
}

/** Record one successful marketing send. Never throws. */
export async function recordMarketingSend(senderEmail, now = new Date()) {
  if (!URL_ || !TOKEN) return;
  try {
    const dk = dayKey(senderEmail, now), tk = tickKey(senderEmail, now);
    await redis(['INCR', dk]);
    await redis(['EXPIRE', dk, 172800]);   // 48h — survives timezone boundaries
    await redis(['INCR', tk]);
    await redis(['EXPIRE', tk, 900]);      // 15m
  } catch { /* counting is best-effort; never block a send on it */ }
}

/** For the dashboard: today's marketing volume per sender. */
export async function todayVolume(senderEmails, now = new Date()) {
  if (!URL_ || !TOKEN) return {};
  const out = {};
  const cap = effectiveDailyCap(now);
  await Promise.all((senderEmails || []).map(async e => {
    try {
      const v = await redis(['GET', dayKey(e, now)]);
      out[e] = { sent: parseInt(v || '0', 10), cap };
    } catch { out[e] = { sent: 0, cap }; }
  }));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// SMS pacing.
//
// This replaces the old SMS_STALE_MS guard in lib/process.js, which skipped any
// text more than two hours overdue and then called advance() — destroying the
// message rather than delaying it. It could not tell a provider outage from a
// queue backlog, so a slow queue silently ate the texts the guard existed to
// protect.
//
// Same shape as marketingGate above, and for the same reason: over-cap sends are
// DEFERRED, not dropped. process.js leaves dw_next_send alone and the next tick
// retries. If Quo goes down, sends fail, contacts stay due, and this meters the
// recovery on its own — the flood protection the old guard wanted, without
// paying for it in lost texts.
//
// Redis-backed rather than in-process, so the cap holds even if Vercel runs more
// than one invocation in a tick.

// Carriers throttle per NUMBER, not per account, and it is a single number that
// gets spam-filtered when it bursts. So the cap that matters is per line; the
// global one is only a backstop against a runaway loop.
//
// A filtered number is the failure worth avoiding here: Quo accepts the message,
// the carrier drops it, and nothing reports an error. Slow is recoverable.
// Filtered is invisible.


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

const SMS_PER_TICK = parseInt(process.env.SMS_PER_TICK || '10', 10);            // per line, per 5 min
const SMS_GLOBAL_PER_TICK = parseInt(process.env.SMS_GLOBAL_PER_TICK || '60', 10); // all lines, per 5 min
const SMS_DAILY_CAP = parseInt(process.env.SMS_DAILY_CAP || '0', 10);           // per line, 0 = none

function smsDayKey(line, now) {
  return `dogwise:sms:day:${line || 'all'}:${now.toISOString().slice(0, 10)}`;
}

function smsTickKey(line, now) {
  const bucket = Math.floor(now.getTime() / (5 * 60 * 1000));
  return `dogwise:sms:pace:${line || 'all'}:${bucket}`;
}

/**
 * May one more text go out from this line right now?
 * Read-only — call recordSmsSend(line) after a send actually succeeds.
 * Fails OPEN, like marketingGate: if Redis is unreachable, send rather than stall.
 *
 * @param line  the Quo phone-number id (PN…) this text would go out on
 */
export async function smsGate(line, now = new Date()) {
  if (!URL_ || !TOKEN) return { ok: true };
  try {
    const reads = await pipe([
      ['GET', smsTickKey(line, now)],
      ['GET', smsTickKey('', now)],
      ['GET', smsDayKey(line, now)]
    ]);
    const [lineRaw, globalRaw, dayRaw] = reads || [null, null, null];
    const sentLine = parseInt(lineRaw || '0', 10);
    const sentGlobal = parseInt(globalRaw || '0', 10);
    const sentToday = parseInt(dayRaw || '0', 10);

    if (SMS_DAILY_CAP > 0 && sentToday >= SMS_DAILY_CAP) {
      return { ok: false, reason: `deferred — daily SMS cap reached on this line (${sentToday}/${SMS_DAILY_CAP})` };
    }
    if (sentLine >= SMS_PER_TICK) {
      return { ok: false, reason: `deferred — SMS pacing, this line already sent ${sentLine} in the last 5 minutes` };
    }
    if (sentGlobal >= SMS_GLOBAL_PER_TICK) {
      return { ok: false, reason: `deferred — SMS pacing, ${sentGlobal} texts across all lines in the last 5 minutes` };
    }
    return { ok: true, sentLine, sentGlobal, sentToday };
  } catch {
    return { ok: true }; // fail open
  }
}

/** Record one successful text, against its line and the global counter. Never throws. */
export async function recordSmsSend(line, now = new Date()) {
  if (!URL_ || !TOKEN) return;
  try {
    const dk = smsDayKey(line, now);
    const cmds = [];
    for (const k of [smsTickKey(line, now), smsTickKey('', now)]) {
      cmds.push(['INCR', k], ['EXPIRE', k, 900]);        // 15m
    }
    if (SMS_DAILY_CAP > 0) cmds.push(['INCR', dk], ['EXPIRE', dk, 172800]);  // 48h
    await pipe(cmds);
  } catch { /* counting is best-effort; never block a send on it */ }
}

/** For the dashboard: today's volume per line. */
export async function smsTodayVolume(lines, now = new Date()) {
  if (!URL_ || !TOKEN) return {};
  const out = {};
  await Promise.all((lines || []).map(async (l) => {
    try {
      const v = await redis(['GET', smsDayKey(l, now)]);
      out[l] = { sent: parseInt(v || '0', 10), cap: SMS_DAILY_CAP };
    } catch { out[l] = { sent: 0, cap: SMS_DAILY_CAP }; }
  }));
  return out;
}
