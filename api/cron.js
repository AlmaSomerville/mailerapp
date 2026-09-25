// api/cron.js — the sweep. Runs every 5 min via vercel.json cron.
import { getCampaigns } from '../lib/store.js';
import { buildOwnerMap, getContactLive, getWaitingContacts, getCompletedContacts, getDealOwnerId, updateContact, getDueCount } from '../lib/hubspot.js';
import { allocate } from '../lib/allocate.js';
import { checkAlerts, rememberWaiting, readWaiting } from '../lib/alert.js';
import { processContact } from '../lib/process.js';
import { runTriggers, runSweep } from '../lib/triggers.js';
import { hasMailFrom } from '../lib/gmail.js';
import { logEvent, bumpStat, getLastSend, shouldReplyCheck } from '../lib/activity.js';
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
        // Search results can be stale — re-fetch live before acting
        const fresh = await getContactLive(contact.id);
        const r = await processContact(fresh, campaigns, ownerMap);
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
    summary.replied = 0;
    const REPLY_WINDOW_MS = 14 * 86400000;

    async function checkReply(rec, { unenroll }) {
      if (campaigns[rec.properties?.dw_campaign]?.type === 'checklist') return; // onboarding stops only when the checklist is done
      if (!(await shouldReplyCheck(rec.id, 4))) return; // each contact checked at most every 4h
      // Scoped to the contact's current campaign, matching lib/process.js. Unscoped, a
      // reply to an older sequence would unenrol them from the one they are in now.
      const lastSend = await getLastSend(rec.id, rec.properties?.dw_campaign);
      if (!lastSend) return;                                    // pre-tracking sends: no window, skip
      if (!unenroll && Date.now() - lastSend > REPLY_WINDOW_MS) return; // completed: stop watching after 14d
      const email = rec.properties?.email;
      if (!email) return;
      const ownerId = await getDealOwnerId(rec.id);
      const owner = ownerId ? ownerMap[String(ownerId)] : null;
      if (!owner?.email) return;
      const replied = await hasMailFrom(owner.email, email, lastSend);
      if (replied !== true) return;

      if (unenroll) await updateContact(rec.id, { dw_campaign: '', dw_next_send: '' });
      await logEvent({
        type: 'replied', contact: email, campaign: rec.properties?.dw_campaign,
        step: Math.max(1, parseInt(rec.properties?.dw_campaign_step || '2', 10) - 1), sender: owner.email,
        detail: unenroll ? 'sequence stopped — reply detected by sweep' : 'reply after sequence completed'
      });
      await bumpStat(rec.properties?.dw_campaign, 'replied');
      summary.replied++;
    }

    try {
      const [waiting, completed] = await Promise.all([getWaitingContacts(100), getCompletedContacts(100)]);
      for (const w of waiting)  { try { await checkReply(w, { unenroll: true  }); } catch { /* keep sweeping */ } }
      for (const d of completed) { try { await checkReply(d, { unenroll: false }); } catch { /* keep sweeping */ } }
    } catch (e) {
      summary.errors.push({ warn: `reply sweep: ${e.message}` });
    }

    // Engagement rules: the pixel and click endpoints only enqueue, so evaluation happens here.

    try {

      const t = await runTriggers(50);

      if (t.processed) summary.triggers = t;

      // Delayed rules ("hasn't opened in 24h") have no event to react to, so they are
      // evaluated by sweeping the send index for sends now old enough to judge.

      const sw = await runSweep();

      if (sw.checked || sw.fired || sw.errors.length) summary.sweep = sw;

    } catch (e) {

      summary.errors.push(`triggers: ${e.message}`);

    }

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
