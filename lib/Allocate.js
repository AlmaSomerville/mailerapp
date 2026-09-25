// lib/allocate.js — decides who gets processed this run.
//
// Round-robin across campaigns was fair and wrong. A 2-contact welcome sequence
// and a 419-contact reactivation blast each got one slot per pass, so live leads
// queued behind dead ones and the backlog barely moved. They are not equals.
//
// Three tiers instead:
//
//   live     Takes everything it needs, first, always. Welcome and onboarding are
//            a handful of contacts, so this costs almost nothing — and a new lead
//            waiting behind a reactivation blast is the failure that matters.
//   normal   The default. Shares what is left, round-robin.
//   passive  Backlog and reactivation. Takes leftover capacity only. Never
//            competes with a live lead, and drains fast when things are quiet.
//
// With 80 slots and live wanting ~10, passive gets ~70 a run rather than 4.
// Both ends improve: the backlog drains in hours, live leads never wait.
//
// The HubSpot constraint still holds — its search endpoint rate-limits hard, and
// lib/hubspot.js paces every call through one chain — so searches are counted,
// not sprayed. One global pool query, then targeted top-ups only where the pool
// came up short, rotating so the same campaigns are not skipped every run.
//
// Campaign fields, all optional:
//   priority   'live' | 'normal' | 'passive'. Absent means normal.
//   status     'paused' stops it entirely. Contacts keep their place.
//   maxPerRun  ceiling on this campaign's slots per run.

import { getDueContacts, getDueContactsForCampaign } from './hubspot.js';

const POOL_FACTOR = Number(process.env.ALLOC_POOL_FACTOR || 6);
const TOP_UP_LIMIT = Number(process.env.ALLOC_TOP_UP_LIMIT || 3);

const TIERS = ['live', 'normal', 'passive'];
const tierOf = (c) => (TIERS.includes(c?.priority) ? c.priority : 'normal');

export async function allocate(campaigns, totalMax) {
  const entries = Object.entries(campaigns || {});
  const paused = entries.filter(([, c]) => c?.status === 'paused').map(([k]) => k);

  const active = entries
    .filter(([, c]) => c?.status !== 'paused')
    .map(([key, c]) => ({
      key,
      tier: tierOf(c),
      cap: c?.maxPerRun === undefined || c?.maxPerRun === null || Number(c.maxPerRun) < 0
        ? totalMax
        : Number(c.maxPerRun)
    }));

  if (!active.length) return { contacts: [], perCampaign: {}, paused, searches: 0, starved: [] };

  const pausedSet = new Set(paused);
  const queues = new Map(active.map(({ key }) => [key, []]));
  let searches = 1;

  // One paginated global query, ordered by dw_next_send ascending. A backlog
  // dominates it, which is fine: the tiering happens in memory, and the top-ups
  // below rescue whoever the backlog crowded out of the pool.
  const pool = await getDueContacts(Math.max(totalMax * POOL_FACTOR, 200));
  for (const contact of pool) {
    const k = contact.properties?.dw_campaign;
    if (!k || pausedSet.has(k) || !queues.has(k)) continue;
    queues.get(k).push(contact);
  }

  // Live campaigns that got nothing in the pool ALWAYS get a direct query. They
  // are few and small, so this is cheap, and a live lead must never wait on a
  // rotation. This is the case the whole tier system exists for.
  const liveMissing = active.filter(({ key, tier, cap }) => tier === 'live' && cap > 0 && !queues.get(key).length);
  for (const { key, cap } of liveMissing) {
    try {
      queues.set(key, await getDueContactsForCampaign(key, Math.min(cap, totalMax)));
      searches++;
    } catch { /* one campaign's query failing must not stop the run */ }
  }

  // Non-live campaigns that came up empty get a rotating top-up. Rotating matters:
  // a fixed slice always skipped the same tail campaigns, every run, forever.
  const otherMissing = active.filter(({ key, tier, cap }) => tier !== 'live' && cap > 0 && !queues.get(key).length);
  if (otherMissing.length) {
    const offset = Math.floor(Date.now() / 300000) % otherMissing.length;
    const rotated = otherMissing.slice(offset).concat(otherMissing.slice(0, offset));
    for (const { key, cap } of rotated.slice(0, TOP_UP_LIMIT)) {
      try {
        const share = Math.max(1, Math.ceil(totalMax / Math.max(active.length, 1)));
        queues.set(key, await getDueContactsForCampaign(key, Math.min(cap, share)));
        searches++;
      } catch { /* same */ }
    }
  }

  // Fill by tier. Within a tier, round-robin so no one campaign takes the head.
  const caps = Object.fromEntries(active.map(({ key, cap }) => [key, cap]));
  const taken = {};
  const contacts = [];

  for (const tier of TIERS) {
    const inTier = active.filter((a) => a.tier === tier);
    if (!inTier.length) continue;

    let progressed = true;
    while (contacts.length < totalMax && progressed) {
      progressed = false;
      for (const { key } of inTier) {
        if (contacts.length >= totalMax) break;
        if ((taken[key] || 0) >= caps[key]) continue;
        const next = queues.get(key).shift();
        if (!next) continue;
        contacts.push(next);
        taken[key] = (taken[key] || 0) + 1;
        progressed = true;
      }
    }
    if (contacts.length >= totalMax) break;
  }

  // Anything with contacts queued that got no slots. Passive campaigns waiting is
  // correct behaviour, so the tier travels with the name for the alerting to use.
  const starved = active
    .filter(({ key }) => queues.get(key).length && !taken[key])
    .map(({ key, tier }) => ({ key, tier }));

  return { contacts, perCampaign: taken, paused, searches, starved };
}
