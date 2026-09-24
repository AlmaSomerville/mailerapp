import { getDueContactsForCampaign } from './hubspot.js';

export async function allocate(campaigns, totalMax) {
  const entries = Object.entries(campaigns || {});
  const paused = entries.filter(([, c]) => c?.status === 'paused').map(([k]) => k);
  const active = entries
    .filter(([, c]) => c?.status !== 'paused')
    .map(([key, c]) => ({ key, cap: Number(c?.maxPerRun) > 0 ? Number(c.maxPerRun) : totalMax }));

  if (!active.length) return { contacts: [], perCampaign: {}, paused };

  // Fetch each campaign's queue in parallel, up to its own ceiling. We over-fetch
  // a little relative to a strict fair share, so a campaign with fewer waiting
  // than its share doesn't cost us a second round trip; the trim happens below.
  const fair = Math.max(1, Math.ceil(totalMax / active.length));
  const queues = await Promise.all(
    active.map(async ({ key, cap }) => {
      try {
        return { key, items: await getDueContactsForCampaign(key, Math.min(cap, Math.max(fair * 2, 10))) };
      } catch {
        return { key, items: [] };   // one campaign's query failing must not stop the run
      }
    })
  );

  // Round-robin: one from each campaign in turn until the run is full or every
  // queue is empty. Interleaving rather than concatenating is what stops a large
  // campaign occupying the head of the batch.
  const caps = Object.fromEntries(active.map(({ key, cap }) => [key, cap]));
  const taken = {};
  const contacts = [];
  let progressed = true;

  while (contacts.length < totalMax && progressed) {
    progressed = false;
    for (const q of queues) {
      if (contacts.length >= totalMax) break;
      if ((taken[q.key] || 0) >= caps[q.key]) continue;
      const next = q.items.shift();
      if (!next) continue;
      contacts.push(next);
      taken[q.key] = (taken[q.key] || 0) + 1;
      progressed = true;
    }
  }

  return { contacts, perCampaign: taken, paused };
}
