import { getDueContacts, getDueContactsForCampaign } from './hubspot.js';

const POOL_FACTOR = Number(process.env.ALLOC_POOL_FACTOR || 6);
const TOP_UP_LIMIT = Number(process.env.ALLOC_TOP_UP_LIMIT || 3);

export async function allocate(campaigns, totalMax) {
  const entries = Object.entries(campaigns || {});
  const paused = entries.filter(([, c]) => c?.status === 'paused').map(([k]) => k);
  const active = entries
    .filter(([, c]) => c?.status !== 'paused')
    .map(([key, c]) => ({ key, cap: Number(c?.maxPerRun) >= 0 && c?.maxPerRun !== undefined ? Number(c.maxPerRun) : totalMax }));

  if (!active.length) return { contacts: [], perCampaign: {}, paused, searches: 0 };

  const pausedSet = new Set(paused);
  const queues = new Map(active.map(({ key }) => [key, []]));
  let searches = 1;

  // One paginated global query. Ordered by dw_next_send ascending, so a backlog
  // dominates it — which is fine, because the fair share happens in memory and the
  // top-up below rescues whoever the backlog crowded out.
  const pool = await getDueContacts(Math.max(totalMax * POOL_FACTOR, 200));
  for (const contact of pool) {
    const k = contact.properties?.dw_campaign;
    if (!k || pausedSet.has(k)) continue;
    if (queues.has(k)) queues.get(k).push(contact);
  }

  // Campaigns with contacts due but nothing in the pool are exactly the starved
  // ones. Query those directly — a handful of searches, not one per campaign.
  const starved = active.filter(({ key, cap }) => cap > 0 && queues.get(key).length === 0);
  for (const { key, cap } of starved.slice(0, TOP_UP_LIMIT)) {
    try {
      const share = Math.max(1, Math.ceil(totalMax / active.length));
      queues.set(key, await getDueContactsForCampaign(key, Math.min(cap, share)));
      searches++;
    } catch { /* one campaign's query failing must not stop the run */ }
  }

  // Round-robin, so no campaign can occupy the head of the batch.
  const caps = Object.fromEntries(active.map(({ key, cap }) => [key, cap]));
  const taken = {};
  const contacts = [];
  let progressed = true;

  while (contacts.length < totalMax && progressed) {
    progressed = false;
    for (const { key } of active) {
      if (contacts.length >= totalMax) break;
      if ((taken[key] || 0) >= caps[key]) continue;
      const next = queues.get(key).shift();
      if (!next) continue;
      contacts.push(next);
      taken[key] = (taken[key] || 0) + 1;
      progressed = true;
    }
  }

  return { contacts, perCampaign: taken, paused, searches };
}
