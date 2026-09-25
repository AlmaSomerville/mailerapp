const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const WEBHOOK = process.env.ALERT_WEBHOOK_URL || '';
const AFTER_RUNS = parseInt(process.env.ALERT_AFTER_RUNS || '6', 10);   // 6 × 5min = 30min
const ERROR_THRESHOLD = parseInt(process.env.ALERT_ERROR_THRESHOLD || '10', 10);

async function redis(cmd) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!res.ok) throw new Error(`Redis error ${res.status}`);
  return (await res.json()).result;
}

/**
 * Post to whatever is listening. The body carries several common key names so
 * one URL works for Slack, Discord, or a plain relay bridge without adapters.
 */
async function push(text) {
  if (!WEBHOOK) return false;
  try {
    await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text, message: text })
    });
    return true;
  } catch {
    return false;   // an alert that fails must never take the run down with it
  }
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

const key = (k) => `dogwise:alert:${k}`;

/**
 * Waiting counts are cached rather than recomputed every run, because counting
 * every campaign each time costs more HubSpot searches than the sends do. The
 * cron refreshes one campaign per run on rotation, so every campaign is a little
 * stale and none is expensive. Entries expire after two hours, so a campaign that
 * stops being counted stops being alerted on rather than firing on a stale number.
 */
export async function rememberWaiting(campaign, count) {
  if (!URL_ || !TOKEN) return;
  try {
    await pipe([
      ['SET', key(`waiting:${campaign}`), String(count)],
      ['EXPIRE', key(`waiting:${campaign}`), 21600]
    ]);
  } catch { /* best effort */ }
}

export async function readWaiting(campaignKeys) {
  if (!URL_ || !TOKEN) return {};
  // One MGET rather than one GET per campaign. With ~35 campaigns that was 35
  // HTTP round trips every run, to read numbers that were already cached.
  const keys = campaignKeys || [];
  if (!keys.length) return {};
  const out = {};
  try {
    const vals = await pipe([['MGET', ...keys.map(k => key(`waiting:${k}`))]]);
    const row = vals?.[0] || [];
    keys.forEach((k, i) => {
      if (row[i] !== null && row[i] !== undefined) out[k] = parseInt(row[i], 10);
    });
  } catch { /* best effort */ }
  return out;
}

/**
 * Call at the end of a cron run. Never throws.
 *
 * @param waiting    { campaign: count } from getDueCounts
 * @param allocated  { campaign: count } from allocate()
 * @param sentBy     { campaign: count } sends this run
 * @param windowBy   { campaign: count } contacts deferred by their send window
 * @param paused     string[] of paused campaign keys
 * @param errors     number of errors this run
 */
export async function checkAlerts({ waiting, allocated, sentBy, windowBy, paused = [], tiers = {}, errors = 0, verifyCount = null }) {
  if (!URL_ || !TOKEN || !WEBHOOK) return { alerted: [], recovered: [] };

  const alerted = [];
  const recovered = [];
  const pausedSet = new Set(paused);

  for (const [campaign, cached] of Object.entries(waiting || {})) {
    let count = cached;
    if (!count || pausedSet.has(campaign)) continue;   // paused is deliberate, not a fault

    // A passive campaign waiting is the tier system working, not a fault. It takes
    // leftover capacity by design, so it will sit idle whenever live and normal
    // campaigns are busy. Alerting on it trained everyone to ignore the channel.
    if (tiers[campaign] === 'passive') continue;

    const got = allocated?.[campaign] || 0;
    const sent = sentBy?.[campaign] || 0;
    const windowed = windowBy?.[campaign] || 0;

    let problem = null;
    if (got === 0) problem = 'starved';
    else if (sent === 0 && windowed === 0) problem = 'stalled';

    try {
      if (!problem) {
        // Healthy. If we were mid-incident, say so and clear.
        const streak = parseInt(await redis(['GET', key(`streak:${campaign}`)]) || '0', 10);
        if (streak >= AFTER_RUNS) {
          await push(`Recovered: ${campaign} is sending again (${sent} this run, ${count} still waiting).`);
          recovered.push(campaign);
        }
        if (streak) await redis(['DEL', key(`streak:${campaign}`)]);
        continue;
      }

      const streak = parseInt(await redis(['INCR', key(`streak:${campaign}`)]) || '1', 10);
      await redis(['EXPIRE', key(`streak:${campaign}`), 86400]);

      // Fire on the run that crosses the threshold, and not again after it.
      if (streak === AFTER_RUNS) {
        // Waiting counts are cached and refreshed on rotation, so by now this
        // number can be hours old — a campaign that has since been fully served
        // still looks like it is waiting. Alerts are rare, so one live count here
        // is cheap and removes that entire class of false alarm.
        try {
          const live = verifyCount ? await verifyCount(campaign) : null;
          if (live === 0) {
            await redis(['DEL', key(`streak:${campaign}`)]);
            continue;
          }
          if (live !== null) count = live;
        } catch { /* fall through and alert on the cached number */ }

        const mins = AFTER_RUNS * 5;
        const live = tiers[campaign] === 'live';
        const body = problem === 'starved'
          ? `${campaign}${live ? ' (live leads)' : ''}: ${count} waiting, no slots for ${mins} minutes.` +
            (live
              ? ' Live campaigns are served first, so this means the run is full or the queue is failing.'
              : ' Likely queued behind higher-priority campaigns; worth a look if it persists.')
          : `${campaign}: ${count} waiting, ${got} picked up, nothing sent for ${mins} minutes. Not a send-window deferral, so something is failing.`;
        await push(`Mailer alert — ${body}`);
        alerted.push({ campaign, problem });
      }
    } catch { /* alerting must never break the run */ }
  }

  // Errors are run-wide rather than per campaign, and rate-limited to one an hour
  // so a systemic failure doesn't turn into a flood of its own.
  if (errors >= ERROR_THRESHOLD) {
    try {
      const recent = await redis(['GET', key('errors')]);
      if (!recent) {
        await push(`Mailer alert — ${errors} errors in a single run. Check the Vercel logs.`);
        await redis(['SET', key('errors'), '1']);
        await redis(['EXPIRE', key('errors'), 3600]);
        alerted.push({ campaign: '*', problem: 'errors' });
      }
    } catch { /* same */ }
  }

  return { alerted, recovered };
}
