// lib/checklist.js — "checklist campaign" engine for post-sale onboarding.
// Assembles each email from blocks based on what's still missing on the DEAL,
// with tone + cadence driven by days until program_start_date.
import { getPrimaryDeal, updateContact, logEmailToTimeline, createTask } from './hubspot.js';
import { sendAsOwner } from './gmail.js';
import { personalize, renderHtml, toPlainText, inSendWindow, appBaseUrl } from './util.js';
import { bookingLinkFor } from './settings.js';
import { logEvent, bumpStat, rememberSend, rememberLastSend, rememberEngagement } from './activity.js';
import { rewriteLinks } from './links.js';
import { indexSend, registerLinks, bump as bumpMetric } from './metrics.js';

const DEAL_PROPS = [
  'dealname', 'hubspot_owner_id', 'forms', 'vaccines_in_order_', 'missing_vaccines',
  'payment_status', 'amount_outstanding', 'remaining_balance_link', 'program_start_date'
];

const TASK_DEDUPE_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TASK_DEDUPE_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function onceEver(key) {
  if (!TASK_DEDUPE_URL) return true;
  const res = await fetch(TASK_DEDUPE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TASK_DEDUPE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', key, '1', 'NX', 'EX', String(60 * 86400)])
  });
  return res.ok && (await res.json()).result === 'OK';
}

function parseStartDate(v) {
  if (!v) return null;
  const ms = /^\d+$/.test(String(v)) ? parseInt(v, 10) : Date.parse(v);
  return isNaN(ms) ? null : ms;
}

function daysUntil(ms) {
  return Math.ceil((ms - Date.now()) / 86400000);
}

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function fmtMoney(v) {
  const n = parseFloat(v);
  return isNaN(n) ? '' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Determine what's missing on the deal. Returns array of block keys, plus context. */
export function computeMissing(dp) {
  const missing = [];
  const forms = String(dp.forms || '');
  if (!forms.includes('Client Intake Form')) missing.push('intake_form');
  if (!forms.includes('Client Manager Form')) missing.push('manager_form');
  if (String(dp.payment_status) === 'Remaining Balance Due') missing.push('balance');
  if (String(dp.vaccines_in_order_) === 'false') {
    const v = String(dp.missing_vaccines || '');
    if (v.includes('DHLPP')) missing.push('vaccine_dhlpp');
    if (v.includes('Bordetella')) missing.push('vaccine_bordetella');
    if (v.includes('Rabies')) missing.push('vaccine_rabies');
  }
  return missing;
}

export function urgencyFor(daysLeft, cadence) {
  if (daysLeft == null) return 'relaxed';
  if (daysLeft <= (cadence.urgentThreshold ?? 2)) return 'urgent';
  if (daysLeft <= (cadence.approachingThreshold ?? 13)) return 'approaching';
  return 'relaxed';
}

export function nextGapDays(urgency, cadence) {
  if (urgency === 'urgent') return cadence.urgentDays ?? 1;
  if (urgency === 'approaching') return cadence.approachingDays ?? 2;
  return cadence.relaxedDays ?? 4;
}

/**
 * Process one contact enrolled in a checklist campaign.
 * Step 1 = the always-sent hello (checklist included if anything missing).
 * Steps 2+ = reminders, only while something is missing.
 */
export async function processChecklist(contact, campaign, ownerMap) {
  const p = contact.properties || {};
  const email = p.email;
  if (!email) return { status: 'error', detail: 'contact has no email' };
  if (String(p.hs_email_optout) === 'true') return { status: 'skipped', detail: 'opted out' };

  const due = parseInt(p.dw_next_send || '', 10);
  if (isNaN(due) || due > Date.now()) return { status: 'skipped', detail: 'not due' };

  const step = Math.max(1, parseInt(p.dw_campaign_step || '1', 10));
  const cadence = campaign.cadence || {};

  // Resolve sender: campaign sendAs (Anita) or fall back to deal owner
  const customItems = Array.isArray(campaign.customItems) ? campaign.customItems.filter(i => i?.property) : [];
  const allProps = [...DEAL_PROPS, ...customItems.map(i => i.property)];
  let deal = null, customBroken = false;
  try {
    deal = await getPrimaryDeal(contact.id, allProps);
  } catch (e) {
    // A mistyped custom property makes HubSpot reject the whole read — retry without them
    deal = await getPrimaryDeal(contact.id, DEAL_PROPS);
    customBroken = true;
  }
  if (!deal) return { status: 'error', detail: 'no associated deal for checklist campaign' };
  const dp = deal.properties || {};

  let owner = null, ownerId = null;
  if (campaign.sendAs) {
    const match = Object.entries(ownerMap).find(([, o]) => o.email?.toLowerCase() === campaign.sendAs.toLowerCase());
    if (match) { ownerId = match[0]; owner = match[1]; }
    else owner = { email: campaign.sendAs, firstName: campaign.sendAsName || '', lastName: '' };
  } else {
    ownerId = dp.hubspot_owner_id || null;
    owner = ownerId ? ownerMap[String(ownerId)] : null;
  }
  if (!owner?.email) return { status: 'error', detail: 'no sender resolvable for checklist campaign' };

  // What's missing right now?
  let missing = computeMissing(dp);

  // Custom check items (dashboard-defined)
  const customBlocks = {};
  if (customBroken) {
    await logEvent({ type: 'error', contact: email, campaign: p.dw_campaign, detail: 'custom check item has an invalid deal property name — custom items skipped this send (check internal names in the campaign editor)' });
  } else {
    customItems.forEach((item, i) => {
      const v = String(dp[item.property] ?? '').trim();
      const mode = item.mode || 'empty';
      const target = String(item.value ?? '').trim();
      const isMissing =
        mode === 'empty' ? v === '' :
        mode === 'equals' ? v === target :
        mode === 'not_contains' ? !v.includes(target) : false;
      if (isMissing && item.block?.trim()) {
        const key = `custom_${i}`;
        missing.push(key);
        customBlocks[key] = item.block;
      }
    });
  }

  // Balance edge case: due but no payment link → task for the sender (once per deal), drop the block
  if (missing.includes('balance') && !String(dp.remaining_balance_link || '').trim()) {
    missing = missing.filter(m => m !== 'balance');
    if (await onceEver(`dwm:task:balancelink:${deal.id}`)) {
      try {
        await createTask({
          dealId: deal.id, ownerId,
          subject: `Send remaining balance email manually — no payment link on deal "${dp.dealname || deal.id}"`,
          body: `Contact ${email} owes ${fmtMoney(dp.amount_outstanding) || 'an outstanding balance'} but the deal has no remaining_balance_link. Paste the Stripe link on the deal (property: remaining_balance_link) and the automated reminders will include it — or send the balance email yourself.`,
          dueInDays: 0
        });
        await logEvent({ type: 'error', contact: email, campaign: p.dw_campaign, sender: owner.email, detail: 'balance due but no payment link — task created for manual follow-up' });
      } catch (e) {
        await logEvent({ type: 'error', contact: email, campaign: p.dw_campaign, detail: `couldn't create balance task (check tasks scope): ${e.message}` });
      }
    }
  }

  // Nothing missing?
  if (missing.length === 0 && step > 1) {
    // Checklist complete — stop quietly
    await updateContact(contact.id, { dw_next_send: '', dw_campaign_step: String(step) });
    await logEvent({ type: 'sent', contact: email, campaign: p.dw_campaign, step, sender: owner.email, detail: 'checklist complete — sequence finished (no email sent)' });
    return { status: 'completed', detail: 'checklist complete' };
  }

  // Urgency + date context
  const startMs = parseStartDate(dp.program_start_date);
  const daysLeft = startMs != null ? daysUntil(startMs) : null;
  const urgency = urgencyFor(daysLeft, cadence);

  const vars = {
    firstname: p.firstname, lastname: p.lastname, email,
    sender_firstname: owner.firstName, sender_lastname: owner.lastName,
    sender_booking_link: await bookingLinkFor(owner.email),
    'deal.amount_outstanding': fmtMoney(dp.amount_outstanding),
    'deal.program_start_date': startMs != null ? fmtDate(startMs) : 'your start date',
    'deal.dealname': dp.dealname || '',
    'deal.remaining_balance_link': String(dp.remaining_balance_link || '').trim(),
    days_left: daysLeft != null ? String(daysLeft) : ''
  };

  // Assemble the email
  const blocks = campaign.blocks || {};
  const intros = campaign.intros || {};
  let subject, bodyParts = [];

  if (step === 1) {
    subject = campaign.firstEmail?.subject || 'Welcome aboard!';
    bodyParts.push(campaign.firstEmail?.body || '');
    if (missing.length > 0) {
      bodyParts.push(campaign.checklistLeadIn || "Here's what we still need before the big day:");
    }
  } else {
    const intro = intros[urgency] || intros.relaxed || {};
    subject = intro.subject || 'A few things before {{firstname}}\'s start date';
    bodyParts.push(intro.body || '');
  }

  for (const key of missing) {
    const text = blocks[key] || customBlocks[key];
    if (text) bodyParts.push(text);
  }

  if (campaign.signoff) bodyParts.push(campaign.signoff);

  const rawBody = personalize(bodyParts.filter(Boolean).join('\n\n'), vars);
  const finalSubject = personalize(subject, vars);

  const sendId = `${contact.id}.${step}.${Date.now().toString(36)}`;
  const appUrl = appBaseUrl();

  // Click tracking, matching lib/process.js's marketing-design path: rewrite AFTER
  // personalize() has already substituted real URLs (the balance link, booking link,
  // etc.), never before, and never on the plain-text part sent to Gmail — the pixel and
  // tracked links only belong in the HTML.
  const rendered = renderHtml(rawBody);
  const { html: trackedHtml, links } = rewriteLinks({ html: rendered, sendId, appUrl });
  if (links.length) await registerLinks(sendId, links);

  const html = trackedHtml + `<img src="${appUrl}/api/px?e=${sendId}" width="1" height="1" alt="" style="display:none">`;

  await sendAsOwner({
    senderEmail: owner.email,
    senderName: [owner.firstName, owner.lastName].filter(Boolean).join(' '),
    to: email,
    subject: finalSubject,
    body: toPlainText(rawBody),
    html
  });

  const base = { contact: email, campaign: p.dw_campaign, step, sender: owner.email, channel: 'email' };
  await rememberSend(sendId, base);
  await indexSend(p.dw_campaign, sendId);   // lets 'hasn't opened/clicked in Nh' trigger rules find this send
  await rememberLastSend(contact.id, p.dw_campaign);
  await logEvent({ type: 'sent', ...base, subject: finalSubject });
  await bumpStat(p.dw_campaign, 'sent');
  await bumpStat(p.dw_campaign, 'sent_email');
  // Reports reads this daily per-step counter, not bumpStat's all-time total — without
  // it, Activity showed the real send while Reports showed zero for the same campaign.
  await bumpMetric({ campaign: p.dw_campaign, step, metric: 'sent' });

  try {
    const emailId = await logEmailToTimeline({
      contactId: contact.id, ownerId, subject: finalSubject,
      body: toPlainText(rawBody), html: trackedHtml,   // real formatting, same as marketing designs
      campaign: p.dw_campaign, step
    });
    if (emailId) await rememberEngagement(sendId, emailId, toPlainText(rawBody), trackedHtml);
    else await logEvent({ type: 'error', ...base, detail: 'email sent but not logged to HubSpot timeline (no engagement id returned)' });
  } catch (e) {
    await logEvent({ type: 'error', ...base, detail: `email sent but timeline logging failed: ${e.message}` });
  }

  // Schedule the next check — cadence recomputed from the start date every time
  const gap = nextGapDays(urgency, cadence);
  await updateContact(contact.id, {
    dw_campaign_step: String(step + 1),
    dw_next_send: String(Date.now() + gap * 86400000)
  });

  return { status: 'sent', detail: `checklist step ${step} (${urgency}, ${missing.length} item(s)) → ${email} as ${owner.email}` };
}
