// lib/process.js — sends the due step for one contact. Shared by the cron sweep and the
// instant webhook. A step is either EMAIL (subject + body, sent as the deal owner via
// Gmail) or SMS (body only, sent via OpenPhone). Per-step day scope and the per-campaign
// send window are both evaluated in the RECIPIENT'S timezone (resolved from their ZIP).
import { getDealOwnerId, getOwnerAndDealName, updateContact, updateDeal, logEmailToTimeline, getLoggedCallCount } from './hubspot.js';
import { sendAsOwner, hasMailFrom } from './gmail.js';
import { sendSms, hasInboundSince } from './sms.js';
import { personalize, renderHtml, toPlainText, daysFromNow, appBaseUrl } from './util.js';
import { bookingLinkFor, smsNumberFor, getPlaceholders, programLinkFor } from './settings.js';
import { registryVars } from './tokens.js';
import { resolveRegion, canSendNow, nextOpenAt } from './region.js';
import { logEvent, rememberSend, rememberLastSend, getLastSend, bumpStat, bumpFailure, clearFailures, rememberEngagement } from './activity.js';
import { bump as bumpMetric, registerLinks, indexSend, markReplied, optimalSendHour } from './metrics.js';
import { processChecklist } from './checklist.js';
import { rewriteLinks } from './links.js';
import { getDesign } from './designs.js';                    // ← ADD
import { assembleMarketingEmail } from './marketing.js';    // ← ADD

// Base URL now lives in lib/util.js so the three copies of this logic can't drift.
const appUrl = appBaseUrl;

/**
 * Deterministically assign one of a step's A/B variants to a contact. Same contact +
 * campaign + step always yields the same variant (a simple string hash, not storage),
 * so re-processing a contact never flips them between A and B mid-sequence. Splits by
 * `weight` if given (defaults to an even split across all variants).
 */
function pickVariant(contactId, campaignKey, stepIndex, variants) {
  const str = `${contactId}:${campaignKey}:${stepIndex}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  const weights = variants.map(v => Number(v.weight) > 0 ? Number(v.weight) : 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = (hash % 10000) / 10000 * total;
  for (let i = 0; i < variants.length; i++) {
    r -= weights[i];
    if (r <= 0) return variants[i];
  }
  return variants[variants.length - 1];
}


/**
 * Process a single contact record ({ id, properties }).
 * Returns { status: 'sent'|'completed'|'skipped'|'replied'|'error', detail? }
 *
 * WHY THIS WRAPPER EXISTS.
 * Everything from the campaign lookup through owner/region resolution and reply
 * detection runs BEFORE the skipStep/retryOrSkip helpers exist (they are defined lower
 * down, next to the SMS block, because they close over `base`/`advance` which are only
 * built once a step is known to be sendable). A throw anywhere in that earlier stretch —
 * a HubSpot API error, a bad association lookup, anything — used to propagate straight
 * out of processContact with dw_next_send untouched. The contact stayed due, the cron
 * picked it up again in 5 minutes, it failed identically, forever. That is what produced
 * a long, unbroken column of "error" rows with no channel and no From: failures from
 * before `base` (which carries sender/channel) was ever constructed.
 *
 * This bounds EVERY failure, wherever it originates, using the same per-step attempt
 * counter the send paths already use. After MAX_ATTEMPTS, dw_next_send is cleared so the
 * contact drops out of the due queue rather than spinning — a blunt stop rather than a
 * clean "skip to next step", because at this level we cannot assume how far execution got.
 * A human can re-enroll deliberately; nothing keeps retrying unattended overnight.
 */
export async function processContact(contact, campaigns, ownerMap) {
  const p = contact.properties || {};
  const campaignKey = p.dw_campaign || '';
  const stepGuess = Math.max(1, parseInt(p.dw_campaign_step || '1', 10));

  try {
    return await processContactCore(contact, campaigns, ownerMap);
  } catch (e) {
    const MAX_ATTEMPTS = Number(process.env.MAX_STEP_ATTEMPTS || 3);
    let n = 1;
    try { n = await bumpFailure(contact.id, campaignKey, stepGuess); } catch { /* counter itself failing must not block the halt below */ }

    if (n < MAX_ATTEMPTS) {
      await logEvent({ type: 'error', contact: p.email || contact.id, campaign: campaignKey, step: stepGuess,
        detail: `pipeline error (attempt ${n} of ${MAX_ATTEMPTS}): ${e.message}` }).catch(() => {});
      return { status: 'error', detail: e.message };
    }

    // Gave up. Clear rather than advance — we don't reliably know how far in this
    // contact got, so stopping cleanly beats guessing at the next step.
    try { await updateContact(contact.id, { dw_next_send: '' }); } catch { /* best effort */ }
    await logEvent({ type: 'error', contact: p.email || contact.id, campaign: campaignKey, step: stepGuess,
      detail: `pipeline error: ${e.message} — halted after ${n} attempts, dw_next_send cleared. Re-enroll manually once the cause is fixed.` }).catch(() => {});
    return { status: 'error', detail: `halted after ${n} attempts: ${e.message}` };
  }
}

async function processContactCore(contact, campaigns, ownerMap) {
  const p = contact.properties || {};
  const email = p.email;
  if (String(p.hs_email_optout) === 'true') return { status: 'skipped', detail: 'opted out' };
  if (!p.dw_campaign) return { status: 'skipped', detail: 'no campaign set' };

  // Only act if genuinely due NOW (guards against stale search results / duplicate triggers).
  const due = parseInt(p.dw_next_send || '', 10);
  if (isNaN(due) || due > Date.now()) return { status: 'skipped', detail: 'not due (stale or future dw_next_send)' };

  const campaign = campaigns[p.dw_campaign];
  if (!campaign) {
    await updateContact(contact.id, { dw_next_send: '' });
    return { status: 'error', detail: `unknown campaign "${p.dw_campaign}"` };
  }

  if (campaign.type === 'checklist') return processChecklist(contact, campaign, ownerMap);

  const stepIndex = Math.max(1, parseInt(p.dw_campaign_step || '1', 10)) - 1;
  const step = campaign.steps[stepIndex];
  if (!step) {
    await updateContact(contact.id, { dw_next_send: '', dw_campaign_step: String(campaign.steps.length) });
    return { status: 'completed' };
  }

  const channel = step.channel === 'sms' ? 'sms' : 'email';
  // Thrown, not returned. A plain return here leaves dw_next_send untouched and writes no
  // activity event, so the contact sits in the due queue forever, invisibly. With the 0
  // sentinel it sits at the very HEAD of the queue and eats a MAX_PER_RUN slot on every
  // single run; a few dozen of these starve everything behind them. Throwing hands it to
  // the bounded wrapper in processContact: logged each attempt, cleared after MAX_ATTEMPTS.
  if (channel === 'email' && !email) throw new Error('contact has no email');
  // A missing phone used to bail out here with an error and no advance, so the contact was
  // retried every 5 minutes forever. It is now handled in the SMS block below, where
  // advance() exists and the step can be skipped instead.

  // ── A/B testing: if this step has variants, pick one deterministically per contact
  //    (hash of contact+campaign+step, not random) so the same contact always sees the
  //    same variant even if this step gets reprocessed. `step` itself is left untouched —
  //    everything below reads subject/body/designId from `effectiveStep` instead.
  //    A plain/SMS step's variants carry subject+body; a marketing-design step's variants
  //    carry subject+designId (two different pre-built designs), never body. ──
  let variant = null;
  let effectiveStep = step;
  if (Array.isArray(step.variants) && step.variants.length) {
    variant = pickVariant(contact.id, p.dw_campaign, stepIndex, step.variants);
    effectiveStep = step.format === 'design'
      ? { ...step, subject: variant.subject, designId: variant.designId }
      : { ...step, subject: variant.subject, body: variant.body };
  }


  // ── Primary deal (newest owned): gives the sender's owner id AND the deal name, which
  //    often carries the lead's ZIP. Fetched once and reused for region resolution below. ──
  const primaryDeal = await getOwnerAndDealName(contact.id);

  // ── Sender: campaign-level override wins; otherwise the deal owner. ──
  let owner = null, ownerId = null;
  if (campaign.sendAs) {
    const match = Object.entries(ownerMap).find(([, o]) => o.email?.toLowerCase() === campaign.sendAs.toLowerCase());
    if (match) { ownerId = match[0]; owner = match[1]; }
    else owner = { email: campaign.sendAs, firstName: campaign.sendAsName || '', lastName: '' };
  } else {
    ownerId = primaryDeal.ownerId;
    owner = ownerId ? ownerMap[String(ownerId)] : null;
    // Same reasoning as the no-email guard above: a silent return here is a permanent,
    // invisible queue-head zombie. Throw so it is logged and bounded.
    if (!owner?.email) throw new Error(`no deal owner resolvable (ownerId: ${ownerId})`);
  }

  const base = { contact: email || p.phone, campaign: p.dw_campaign, step: variant ? `${stepIndex + 1}.${variant.id}` : stepIndex + 1, sender: owner.email, channel };

  // ── Region: stamped value → contact ZIP → ZIP in the deal's location field → ZIP in the deal
  //    name. `resolved` is false when no real ZIP was found; we then withhold SMS (below) and
  //    never stamp a guessed region. ──
  const { region, stamped, resolved } = await resolveRegion({
    stampedRegion: primaryDeal.leadRegion, zip: p.zip_code, fallbackZips: [primaryDeal.location, primaryDeal.dealName]
  });
  if (!stamped && resolved && primaryDeal.dealId) {
    // lead_region is a DEAL property — stamping it on the contact returns HTTP 400.
    try {
      await updateDeal(primaryDeal.dealId, { lead_region: region });
    } catch (e) {
      await logEvent({ type: 'error', ...base, detail: `region stamp failed on deal ${primaryDeal.dealId}: ${e.message}` });
    }
  }

  // ── Send window + allowed days, in the lead's local time. Outside → DEFER (leave dw_next_send
  //    untouched; the 5-min cron retries until the window/day opens). No status is written. ──
  const gate = canSendNow(region, campaign.window, step.days);
  if (!gate.ok) {
    // Reschedule rather than leaving dw_next_send in the past. Otherwise this contact
    // stays at the head of the ASCENDING due queue and starves contacts that CAN send.
    //
    // Capped, deliberately. Parking a contact at the real next opening (possibly 15 hours
    // away) means a later change to the send window never reaches it, because it is no
    // longer in the due queue to be re-evaluated. Any future timestamp is enough to end
    // the starvation, so we take the nearer of "next opening" and "45 minutes from now".
    // Load still drops ~9x versus re-reading every 5 minutes, and a window edit takes
    // effect within the hour.
    const MAX_DEFER_MS = Number(process.env.MAX_DEFER_MS || 45 * 60 * 1000);
    const at = Math.min(nextOpenAt(region, campaign.window, step.days), Date.now() + MAX_DEFER_MS);
    try { await updateContact(contact.id, { dw_next_send: String(at) }); } catch { /* retry next run */ }
    return { status: 'skipped', detail: `deferred — ${gate.reason}; retrying ${new Date(at).toISOString().slice(11, 16)} UTC` };
  }

  // ── Stop-if-called: a rep has logged a call, so back off the whole sequence. ──
  if (campaign.stopIfCalled) {
    const calls = await getLoggedCallCount(contact.id);
    if (calls > 0) {
      await updateContact(contact.id, { dw_campaign: '', dw_next_send: '' });
      await logEvent({ type: 'skipped', ...base, detail: `stopped — ${calls} logged call(s), a rep took over` });
      return { status: 'completed', detail: 'stopped — rep logged a call' };
    }
  }

  // Which numbers/replies matter: only touch OpenPhone if we have actually TEXTED this
  // contact in THIS campaign already.
  //
  // This used to be `campaign.steps.some(...)` — true if ANY step in the campaign is SMS,
  // including steps not yet reached. So a welcome sequence whose step 1 is email and step 2
  // is SMS paid for a GET /messages on every contact at step 2, before a single text had
  // been sent to them, to look for a reply to a message that did not exist. That is a full
  // OpenPhone round trip per contact per run that could never return anything, and with a
  // sequential loop inside a 120s function it is a direct hit on how many contacts a run
  // can clear.
  //
  // Looking only at steps ALREADY passed is not just cheaper, it is more correct: if we
  // have never texted them in this campaign, there is no outbound thread for them to have
  // replied to.
  const textedAlready = campaign.steps.slice(0, stepIndex).some(s => s.channel === 'sms');
  const smsNumberId = (channel === 'sms' || (textedAlready && ownerId)) ? await smsNumberFor(ownerId, region) : '';

  // ── Reply detection: if the lead has come back to us since our last send, stop the sequence. ──
  // Scoped to THIS campaign: a reply to an earlier sequence must not unenrol a contact
  // from a new one, which is what happened when this marker was contact-wide.
  const lastSend = await getLastSend(contact.id, base.campaign);
  if (lastSend) {
    if (email) {
      const repliedEmail = await hasMailFrom(owner.email, email, lastSend);
      if (repliedEmail === true) {
        await updateContact(contact.id, { dw_campaign: '', dw_next_send: '' });
        await logEvent({ type: 'replied', ...base, detail: 'sequence stopped — contact emailed the owner' });
        await bumpStat(base.campaign, 'replied');
        await bumpStat(base.campaign, 'replied_email');   // split so the two channels are distinguishable in Reports
        await markReplied(contact.id, base.campaign);
        await bumpMetric({ campaign: base.campaign, step: base.step, metric: 'replied' });
        return { status: 'replied', detail: `${email} replied to ${owner.email}; unenrolled` };
      }
    }
    if (textedAlready && smsNumberId && p.phone) {
      const repliedSms = await hasInboundSince({ phoneNumberId: smsNumberId, contactPhone: p.phone, sinceMs: lastSend });
      if (repliedSms === true) {
        await updateContact(contact.id, { dw_campaign: '', dw_next_send: '' });
        await logEvent({ type: 'replied', ...base, detail: 'sequence stopped — contact texted back' });
        await bumpStat(base.campaign, 'replied');
        await bumpStat(base.campaign, 'replied_sms');
        await markReplied(contact.id, base.campaign);
        await bumpMetric({ campaign: base.campaign, step: base.step, metric: 'replied' });
        return { status: 'replied', detail: `${p.phone} texted back; unenrolled` };
      }
    }
    // null from either check (can't verify) → proceed with the send
  }

  // Global placeholder registry (Settings) → resolved against this contact + deal + owner.
  const placeholders = await getPlaceholders();
  const senderFullName = [owner.firstName, owner.lastName].filter(Boolean).join(' ');
  const custom = registryVars(placeholders, {
    contact: p,
    deal: primaryDeal.properties || {},
    owner: { email: owner.email, firstname: owner.firstName, lastname: owner.lastName, fullname: senderFullName }
  });

  const vars = {
    ...custom,                       // built-ins below always win over the registry
    firstname: p.firstname,
    lastname: p.lastname,
    email: email,
    phone: p.phone,
    sender_firstname: owner.firstName,
    sender_lastname: owner.lastName,
    sender_fullname: senderFullName,
    sender_booking_link: await bookingLinkFor(owner.email),
    // Resolved once here, by NAME, against a map you maintain in one place — not a
    // property you'd otherwise have to remember to fill in correctly on every deal.
    program_link: await programLinkFor(primaryDeal.properties?.type_of_program_sold)
  };

  const isLast = stepIndex + 1 >= campaign.steps.length;

  // ── Advance Logic (Modified for immediate recursion on 0 days) ──
  const advance = async () => {
    const nextStepNum = stepIndex + 2;
    // Safely parse string "0" or number 0
    const isZeroDelay = step.delayDaysAfter == null || Number(step.delayDaysAfter) === 0;

    if (isLast) {
      await updateContact(contact.id, {
        dw_next_send: '',
        dw_campaign_step: String(nextStepNum)
      });
      return false; // Done, do not recurse
    } else if (isZeroDelay) {
      const pastTime = String(Date.now() - 60000); // due now
      // Update HubSpot so it's correct in the CRM
      await updateContact(contact.id, {
        dw_next_send: pastTime,
        dw_campaign_step: String(nextStepNum)
      });
      
      // Update local memory so the recursive call sees the new state
      p.dw_campaign_step = String(nextStepNum);
      p.dw_next_send = pastTime;
      return true; // Return TRUE to trigger immediate recursion
    } else {
      const delayMs = Number(step.delayDaysAfter) * 24 * 60 * 60 * 1000;
      let nextTime = Date.now() + delayMs;

      // Send-time optimization: nudge the scheduled hour to whichever UTC hour this
      // campaign's own opens have historically clustered around, once there's enough
      // data to trust. Only the hour-of-day moves; the delay (which day) is unchanged.
      const opt = campaign.sendOptimization;
      if (opt?.enabled) {
        const best = await optimalSendHour(base.campaign, opt.afterOpens || 20);
        if (best) {
          const d = new Date(nextTime);
          d.setUTCHours(best.hour, Math.floor(Math.random() * 20), 0, 0);
          if (d.getTime() > Date.now()) nextTime = d.getTime();
          // else: optimal hour already passed today relative to the base delay — keep
          // the original nextTime rather than jumping a full day earlier or later.
        }
      }

      await updateContact(contact.id, {
        dw_next_send: String(nextTime),
        dw_campaign_step: String(nextStepNum)
      });
      return false; // Future send, do not recurse
    }
  };

  // ── Giving up on a step ───────────────────────────────────────────────────
  // Permanent failures skip the step and move the sequence on. Transient ones are retried
  // a few times and then skipped anyway, so nothing can loop indefinitely.
  const MAX_ATTEMPTS = Number(process.env.MAX_STEP_ATTEMPTS || 3);

  const skipStep = async (detail, type = 'skipped') => {
    await logEvent({ type, ...base, detail });
    await clearFailures(contact.id, base.campaign, base.step);
    const rec = await advance();
    if (rec) return processContact(contact, campaigns, ownerMap);
    return { status: 'skipped', detail };
  };

  /** Retry a transient failure up to MAX_ATTEMPTS, then skip so it cannot loop. */
  const retryOrSkip = async (detail) => {
    const n = await bumpFailure(contact.id, base.campaign, base.step);
    if (n >= MAX_ATTEMPTS) {
      return skipStep(`${detail} — gave up after ${n} attempts, skipping this step`, 'error');
    }
    await logEvent({ type: 'error', ...base, detail: `${detail} (attempt ${n} of ${MAX_ATTEMPTS})` });
    return { status: 'error', detail };
  };

  // ── Systemic failures: hold briefly, then drop ────────────────────────────
  // A systemic fault is ours, not this contact's — credentials, billing, a missing design.
  // Holding is right at first: skipping immediately would silently drop the step for
  // everyone in the queue over what might be a ten-minute blip.
  //
  // Holding FOREVER is not. A held step leaves dw_next_send untouched, and getDueContacts
  // sorts dw_next_send ASCENDING with a MAX_PER_RUN cap — so every permanently-held contact
  // parks itself at the head of the queue and consumes a slot on every single run. Contacts
  // triggered with the dw_next_send = 0 sentinel are worse still: 0 sorts first of all, and
  // the SMS staleness guard deliberately exempts it, so nothing else can ever evict them.
  // Left alone, a one-owner credential fault grows until it starves the whole pipeline,
  // email included, for every owner.
  //
  // So: bounded. A few loud attempts, then skip the step and move the sequence on. The drop
  // is still logged as an 'error', not a 'skipped', so a real outage stays visible in the
  // activity log rather than disappearing into the skip pile.
  //
  // Email gets one more attempt than SMS: a missed email step is a touch the contact may
  // never get again, and delegation faults take longer to notice than a billing lapse.
  const SYSTEMIC_ATTEMPTS = {
    sms: Number(process.env.SYSTEMIC_ATTEMPTS_SMS || 2),
    email: Number(process.env.SYSTEMIC_ATTEMPTS_EMAIL || 3)
  };

  const holdOrDrop = async (detail, note) => {
    const limit = SYSTEMIC_ATTEMPTS[channel] ?? 2;
    const n = await bumpFailure(contact.id, base.campaign, base.step);
    if (n >= limit) {
      return skipStep(`${detail} — ${note}; dropped this ${channel} step after ${n} attempts`, 'error');
    }
    await logEvent({ type: 'error', ...base, detail: `${detail} — ${note} (attempt ${n} of ${limit})` });
    return { status: 'error', detail };
  };

  /**
   * Three classes, because they deserve different treatment:
   *
   *   'contact'  400/404/422 — this contact's data is bad (dead number, malformed address).
   *              Skip the step. Retrying is pointless and it only affects this one person.
   *   'systemic' 401/402/403 — OUR credentials, billing, or config. Held for a few attempts
   *              (see holdOrDrop) so a brief fault costs nobody a step, then dropped.
   *   'transient' 408/429/5xx/network — retry a few times, then skip so nothing loops.
   */
  // Google's OAuth library (google-auth-library) throws its own error text with NO
  // "(NNN)" status code embedded — unlike HubSpot/OpenPhone's formatted errors, which the
  // status-based check below was built around. A broken domain-wide delegation (wrong
  // scopes, a suspended or removed mailbox, a rotated service-account key never
  // re-authorized) therefore fell through to "transient", got retried 3 times, and was
  // then silently skipped — treating a genuinely systemic credential failure exactly like
  // a random network blip. Every other contact assigned to that same owner would fail
  // the identical way, invisibly, since a "skip" writes no lasting signal anywhere.
  const CREDENTIAL_ERROR = /unauthorized_client|invalid_client|invalid_grant|insufficient.*scope|access_denied|Client is unauthorized/i;

  const classify = (status, message = '') => {
    if (CREDENTIAL_ERROR.test(message)) return 'systemic';
    if ([401, 402, 403].includes(status)) return 'systemic';
    if ([400, 404, 422].includes(status)) return 'contact';
    return 'transient';
  };

  // ═══════════════ SMS ═══════════════
  if (channel === 'sms') {
    // Short-term guard against OpenPhone outage floods: if this step has been sitting due
    // for longer than SMS_STALE_MS, whatever the reason (OpenPhone was erroring, the cron
    // was paused, etc.), the moment has likely passed — staff may well have already handled
    // this contact by hand. Skip rather than send, so a backlog that built up during an
    // outage doesn't fire all at once the instant OpenPhone comes back. Adjust or set to 0
    // to disable. `due` was parsed near the top of processContactCore from dw_next_send.
    // due === 0 (or blank/negative) is the "send immediately" trigger HubSpot workflows use
    // (set dw_next_send to 0 to fire a step right now) — not a stale scheduled timestamp, so
    // it's exempt from staleness no matter how long it's been sitting at 0.
    const SMS_STALE_MS = Number(process.env.SMS_STALE_MS ?? 2 * 60 * 60 * 1000); // default 2h
    if (SMS_STALE_MS > 0 && due > 0 && (Date.now() - due) > SMS_STALE_MS) {
      const overdueMin = Math.round((Date.now() - due) / 60000);
      await logEvent({ type: 'skipped', ...base, detail: `SMS withheld — ${overdueMin} min overdue (likely stale after an outage/pause); skipping to avoid a late blast` });
      const rec = await advance();
      if (rec) return processContact(contact, campaigns, ownerMap);
      return { status: 'skipped', detail: `SMS stale — ${overdueMin} min overdue, skipped` };
    }
    // Never text from a guessed number. Require a region resolved from a real ZIP (contact or
    // deal name); otherwise skip THIS step and move the sequence on — don't send.
    if (!resolved) {
      await logEvent({ type: 'skipped', ...base, detail: 'SMS withheld — no ZIP in contact or deal name; region unknown' });
      const rec = await advance();
      if (rec) return processContact(contact, campaigns, ownerMap);
      return { status: 'skipped', detail: 'SMS withheld — region unknown' };
    }
    if (!p.phone) {
      // No number to text. Nothing will change on a retry, so skip the step.
      return skipStep('SMS withheld — contact has no phone number (check `phone` vs `mobilephone`)');
    }
    if (!ownerId) {
      // Could be fixed by assigning a deal owner, so retry a few times before skipping.
      return retryOrSkip('SMS withheld — no deal owner id, so no number map lookup possible');
    }
    if (!smsNumberId) {
      // Owner has no number mapped for THIS region — don't fall back to another region's line; skip.
      await logEvent({ type: 'skipped', ...base, detail: `SMS withheld — no ${region} number configured for owner ${ownerId}` });
      const rec = await advance();
      if (rec) return processContact(contact, campaigns, ownerMap);
      return { status: 'skipped', detail: `SMS withheld — no ${region} number for owner ${ownerId}` };
    }
    const content = personalize(effectiveStep.body, vars);
    const r = await sendSms({ from: smsNumberId, to: p.phone, content });
    if (!r.ok) {
      // Name the LINE, not just the person. `base` carries sender and channel but not
      // region or the PN id, so a 403 used to tell you which owner failed and nothing
      // about which of their four or five numbers it was — and OpenPhone authorises per
      // number, so the line is the whole question. One cron cycle with this in place is
      // enough to tell "this owner is broken" apart from "these two lines are broken".
      const via = `${region} line ${smsNumberId}`;
      // A rejected number (400) is permanent: the same text will fail identically forever.
      const kind = classify(r.status, r.error);
      if (kind === 'contact') return skipStep(`${r.error} — number rejected on ${via}, skipping this step`, 'error');
      if (kind === 'systemic') {
        // Config problem, not this contact: hold briefly so a blip costs nobody a step,
        // then drop it so a permanent one can't camp at the head of the due queue.
        // OpenPhone authorises per phone NUMBER, and every API send is attributed to the
        // user the key was created under — not to the owner named in `sender`. So a 403
        // here usually means THAT user isn't a member of this particular line, which is
        // why it can hit a few lines while every other number on the same key sends fine.
        return holdOrDrop(r.error, `${via} — the API key's OpenPhone user may not be a member of this line`);
      }
      return retryOrSkip(`${r.error} — on ${via}`);
    }
    await clearFailures(contact.id, base.campaign, base.step);
    // Texts get a sendId and an index entry too. There is no pixel or link tracking in an
    // SMS, but "hasn't replied in N hours" rules need the send to be findable by the sweep.
    const smsSendId = `${contact.id}.${stepIndex + 1}.${Date.now().toString(36)}`;
    await rememberSend(smsSendId, base);
    await indexSend(base.campaign, smsSendId);
    await rememberLastSend(contact.id, base.campaign);
    await logEvent({ type: 'sent', ...base, detail: `SMS via ${region} line ${smsNumberId}` });
    await bumpStat(base.campaign, 'sent');
    await bumpMetric({ campaign: base.campaign, step: base.step, metric: 'sent' });
    
    // Check if we need to fire the next step right now
    const shouldRecurse = await advance();
    if (shouldRecurse) {
      return processContact(contact, campaigns, ownerMap);
    }
    
    return { status: isLast ? 'completed' : 'sent', detail: `SMS step ${stepIndex + 1} → ${p.phone} (${region})` };
  }

  // ═══════════════ EMAIL ═══════════════
  const subject = personalize(effectiveStep.subject, vars);
  const sendId = `${contact.id}.${stepIndex + 1}.${Date.now().toString(36)}`;

  let html;
  let text;   // plain-text part for Gmail + timeline

  if (step.format === 'design' && effectiveStep.designId) {
    // Marketing design path — uses the pre-rendered HTML from the builder. With A/B
    // variants, effectiveStep.designId is whichever design this contact was assigned.
    const record = await getDesign(effectiveStep.designId);
    if (!record?.html) {
      // Third unbounded loop, same shape as the two credential branches: this returned an
      // error without advancing or counting, so a campaign pointing at a deleted design
      // retried every contact on that step every 5 minutes indefinitely. It is systemic
      // (everyone on this step fails identically), so it gets the same bounded treatment.
      return holdOrDrop(`design "${effectiveStep.designId}" missing or has no HTML`, 'campaign references a design that no longer exists');
    }
    const assembled = assembleMarketingEmail({
      record,
      vars,
      sendId,
      appUrl: appUrl(),
      footer: true,
      senderAddress: process.env.SENDER_ADDRESS || '',
      senderName: process.env.SENDER_NAME || 'Dogwise Academy'
    });
    html = assembled.html;
    text = assembled.text;
    // Store the link registry so /api/c can resolve an index to a URL server-side.
    if (assembled.links?.length) await registerLinks(sendId, assembled.links);
  } else {
    // Plain-text / markdown path. Links now get click tracking too, same as
    // checklist and marketing-design sends — see lib/links.js for why this is
    // safe (bare-URL anchor text is still left unrewritten).
    const rawBody = personalize(effectiveStep.body || '', vars);
    text = toPlainText(rawBody);
    const rendered = renderHtml(rawBody);
    const { html: trackedHtml, links } = rewriteLinks({ html: rendered, sendId, appUrl: appUrl() });
    if (links.length) await registerLinks(sendId, links);
    html = trackedHtml +
      `<img src="${appUrl()}/api/px?e=${sendId}" width="1" height="1" alt="" style="display:none">`;
  }

  try {
    await sendAsOwner({
      senderEmail: owner.email,
      senderName: [owner.firstName, owner.lastName].filter(Boolean).join(' '),
      to: email,
      subject,
      body: text,
      html
    });
  } catch (e) {
    // Same reasoning as SMS: a 4xx from Gmail (bad address, bad delegation) will not fix
    // itself, and without advancing this contact would be retried every 5 minutes forever.
    const m = String(e.message || '').match(/\((\d{3})\)/);
    const kind = classify(m ? Number(m[1]) : 0, e.message);
    if (kind === 'contact') return skipStep(`${e.message} — skipping this step`, 'error');
    if (kind === 'systemic') {
      return holdOrDrop(e.message, 'Google delegation or scopes need attention');
    }
    return retryOrSkip(e.message || 'Gmail send failed');
  }

  await clearFailures(contact.id, base.campaign, base.step);
  await rememberSend(sendId, base);
  await indexSend(base.campaign, sendId);   // lets the time-based rule sweep find this send
  await rememberLastSend(contact.id, base.campaign);
  await logEvent({ type: 'sent', ...base, subject });
  await bumpStat(base.campaign, 'sent');
  await bumpMetric({ campaign: base.campaign, step: base.step, metric: 'sent' });

  try {
    const emailId = await logEmailToTimeline({
      contactId: contact.id,
      ownerId,
      subject,
      body: text,                     // uses the same text we just built
      html,                           // the actual rendered version, design or plain
      campaign: p.dw_campaign,
      step: stepIndex + 1
    });
    if (emailId) await rememberEngagement(sendId, emailId, text, html);
    else await logEvent({ type: 'error', ...base, detail: 'email sent but not logged to HubSpot timeline (no engagement id returned)' });
  } catch (e) {
    // Previously an unguarded catch swallowed this completely — the send worked, nothing
    // showed on the timeline, and there was no trace anywhere of why. Now it is visible.
    await logEvent({ type: 'error', ...base, detail: `email sent but timeline logging failed: ${e.message}` });
  }

  // Check if we need to fire the next step right now
  const shouldRecurse = await advance();
  if (shouldRecurse) {
    return processContact(contact, campaigns, ownerMap);
  }

  return { status: isLast ? 'completed' : 'sent', detail: `step ${stepIndex + 1} → ${email} as ${owner.email}` };
}
