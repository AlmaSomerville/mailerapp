// api/sweep.js — reply detection and engagement rules, on their own schedule.
// Replies are not urgent to the minute. Sending is. So sending keeps the
// 5-minute cron and the full window; this runs every 15.
import { getCampaigns } from '../lib/store.js';
import { buildOwnerMap, getWaitingContacts, getCompletedContacts, getDealOwnerId, updateContact } from '../lib/hubspot.js';
import { runTriggers, runSweep } from '../lib/triggers.js';
import { hasMailFrom } from '../lib/gmail.js';
import { logEvent, bumpStat, getLastSend, shouldReplyCheck } from '../lib/activity.js';

const TIME_BUDGET_MS = parseInt(process.env.SWEEP_TIME_BUDGET_MS || '95000', 10);
const REPLY_WINDOW_MS = 14 * 86400000;

export default async function handler(req, res) {
  const auth = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const startedAt = Date.now();
  const summary = { replied: 0, checked: 0, errors: [] };

  try {
    const [campaigns, ownerMap] = await Promise.all([getCampaigns(), buildOwnerMap()]);

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
      for (const w of waiting) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) { summary.note = 'time budget reached'; break; }
        summary.checked++;
        try { await checkReply(w, { unenroll: true }); } catch { /* keep sweeping */ }
      }
      for (const d of completed) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) { summary.note = 'time budget reached'; break; }
        summary.checked++;
        try { await checkReply(d, { unenroll: false }); } catch { /* keep sweeping */ }
      }
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

    summary.ms = Date.now() - startedAt;
    return res.status(200).json(summary);
  } catch (err) {
    summary.ms = Date.now() - startedAt;
    return res.status(500).json({ ...summary, fatal: err.message });
  }
}
