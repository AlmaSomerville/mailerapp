// api/cron.js — the send loop. Runs every 5 min via vercel.json cron.
// Reply detection and engagement rules are in api/sweep.js, every 15 min.
import { getCampaigns } from '../lib/store.js';
import { buildOwnerMap, getContactLive, getContactsLive, getOwnerAndDealNameMany, getDueCount } from '../lib/hubspot.js';
import { allocate } from '../lib/allocate.js';
import { checkAlerts, rememberWaiting, readWaiting } from '../lib/alert.js';
import { processContact } from '../lib/process.js';
// NOTE: the send window is no longer global — it's per-campaign and evaluated in each
// recipient's timezone inside processContact(). The old global gate has been removed so
// it can't block, say, a Colorado lead at 6pm ET across the whole run.

const MAX_PER_RUN = parseInt(process.env.MAX_PER_RUN || '40', 10);

// Leave the function before Vercel's 120s maxDuration kills it mid-contact, so a
// slow run reports what it did instead of vanishing. Whatever is left stays due
// and the next tick picks it up.
const TIME_BUDGET_MS = parseInt(process.env.CRON_TIME_BUDGET_MS || '95000', 10);

export default async function handler(req, res) {
  // Vercel cron sends Authorization: Bearer <CRON_SECRET> automatically when CRON_SECRET is set.
  const auth = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const summary = { sent: 0, deferred: 0, completed: 0, errors: [] };

  try {
    const startedAt = Date.now();
    const [ownerMap, campaigns] = await Promise.all([buildOwnerMap(), getCampaigns()]);

    // Fair share across campaigns rather than one global queue ordered by
    // dw_next_send. A released backlog can no longer occupy every slot and
    // starve today's leads — see lib/allocate.js.
    const { contacts, perCampaign, paused, searches, starved } = await allocate(campaigns, MAX_PER_RUN);
    summary.allocated = perCampaign;
    summary.searches = searches;
    if (starved?.length) summary.starved = starved;
    if (paused.length) summary.paused = paused;

    // Prefetch. The per-contact live read and deal lookup cost three paced HubSpot
    // calls each — roughly 540ms of pure queue time per contact, which capped a run
    // long before any rate limit did. Batched at 100 per call, 80 contacts cost
    // about 4 calls instead of 240.
    const ids = contacts.map((c) => c.id);
    let freshById = new Map();
    let dealById = new Map();
    try {
      [freshById, dealById] = await Promise.all([
        getContactsLive(ids),
        getOwnerAndDealNameMany(ids)
      ]);
    } catch { /* fall through to the per-contact reads below */ }

    const senderCounts = {};
    // Per-campaign outcomes, so alerting can tell a stall from a send-window
    // deferral. Without that distinction it would fire every night.
    const sentBy = {};
    const windowBy = {};
    for (const contact of contacts) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        summary.note = 'time budget reached — remainder carries to the next run';
        break;
      }
      const email = contact.properties?.email || contact.id;
      try {
        // Search results can be stale — act on a live read: from the batch above
        // where we have it, or a direct read if that contact was missed.
        const fresh = freshById.get(String(contact.id)) || await getContactLive(contact.id);
        const pre = dealById.has(String(contact.id)) ? { deal: dealById.get(String(contact.id)) } : null;
        const r = await processContact(fresh, campaigns, ownerMap, pre);
        const ck = fresh.properties?.dw_campaign || contact.properties?.dw_campaign || '?';
        if (r.status === 'sent') { summary.sent++; sentBy[ck] = (sentBy[ck] || 0) + 1; }
        else if (r.status === 'completed') { summary.completed++; if (r.detail) { summary.sent++; sentBy[ck] = (sentBy[ck] || 0) + 1; } }
        else if (r.status === 'skipped') {
          summary.deferred++;
          (summary.skips ||= []).push({ email, reason: r.detail });
          // A send-window deferral is the system working, not a fault.
          if (/deferred/i.test(r.detail || '')) windowBy[ck] = (windowBy[ck] || 0) + 1;
        }
        else summary.errors.push({ email, error: r.detail });
      } catch (err) {
        summary.errors.push({ email, error: err.message });
      }
    }

    // ── Reply sweep:
    //   waiting contacts (future step pending) → reply cancels the sequence
    //   completed contacts (within 14 days of last send) → reply is logged for stats only
    // Reply detection and engagement rules now live in api/sweep.js on their own
    // 15-minute cron. They did a Gmail lookup per contact across up to 200
    // contacts with no time budget, which is what pushed runs to 100s once
    // sending got fast. Sending keeps the 5-minute schedule and the full window.

    // Backlog visibility, one campaign per run on rotation. Counting every
    // campaign each run cost more HubSpot searches than the sends did, and the
    // search endpoint rate-limits hard enough that it timed the whole run out.
    try {
      const keys = Object.keys(campaigns);
      if (keys.length) {
        const which = keys[Math.floor(Date.now() / 300000) % keys.length];
        await rememberWaiting(which, await getDueCount(which));
      }
      summary.waiting = await readWaiting(keys);
      summary.searches = (summary.searches || 0) + 1;
    } catch { /* never fail a run over a count */ }

    // Push if a campaign has stopped moving. Fires once per incident, only after
    // the condition has held for ALERT_AFTER_RUNS runs, and announces recovery.
    try {
      const a = await checkAlerts({
        waiting: summary.waiting || {},
        allocated: perCampaign,
        sentBy,
        windowBy,
        paused,
        tiers: Object.fromEntries(Object.entries(campaigns).map(([k, c]) => [k, c?.priority || 'normal'])),
        verifyCount: (k) => getDueCount(k).catch(() => null),
        errors: summary.errors.length
      });
      if (a.alerted.length || a.recovered.length) summary.alerts = a;
    } catch { /* never fail a run over an alert */ }

    summary.ms = Date.now() - startedAt;
    return res.status(200).json(summary);
  } catch (err) {
    return res.status(500).json({ fatal: err.message, ...summary });
  }
}
