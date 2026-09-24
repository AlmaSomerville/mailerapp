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

const key = (k) => `dogwise:alert:${k}`;

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
export async function checkAlerts({ waiting, allocated, sentBy, windowBy, paused = [], errors = 0 }) {
  if (!URL_ || !TOKEN || !WEBHOOK) return { alerted: [], recovered: [] };

  const alerted = [];
  const recovered = [];
  const pausedSet = new Set(paused);

  for (const [campaign, count] of Object.entries(waiting || {})) {
    if (!count || pausedSet.has(campaign)) continue;   // paused is deliberate, not a fault

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
        const mins = AFTER_RUNS * 5;
        const body = problem === 'starved'
          ? `${campaign}: ${count} contacts waiting, but the allocator gave it no slots for ${mins} minutes. This should not be possible — check lib/allocate.js.`
          : `${campaign}: ${count} contacts waiting, ${got} picked up, nothing sent for ${mins} minutes. Not a send-window deferral, so something is failing.`;
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
