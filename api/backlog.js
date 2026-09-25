// api/backlog.js — how many contacts are queued, per sequence.
//
// The cron already counts one campaign per run and caches the result in Redis
// (counting all of them every run cost more HubSpot searches than the sending
// did). This just reads that cache, so the dashboard costs nothing to show it.
//
// Numbers are therefore each up to a few hours old. That is the right trade for
// a backlog figure, and the age is returned so the UI can say so.
import { getCampaigns } from '../lib/store.js';
import { readWaiting } from '../lib/alert.js';

export default async function handler(req, res) {
  const given = req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.query?.secret || '';
  if (!process.env.ADMIN_PASSWORD || given !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  try {
    const campaigns = await getCampaigns();
    const keys = Object.keys(campaigns);
    const waiting = await readWaiting(keys);

    const rows = keys
      .map((k) => ({
        key: k,
        label: campaigns[k]?.label || k,
        priority: campaigns[k]?.priority || 'normal',
        paused: campaigns[k]?.status === 'paused',
        waiting: waiting[k] ?? null          // null = not counted yet
      }))
      .filter((r) => r.waiting === null || r.waiting > 0)
      .sort((a, b) => (b.waiting || 0) - (a.waiting || 0));

    const total = rows.reduce((n, r) => n + (r.waiting || 0), 0);
    const counted = rows.filter((r) => r.waiting !== null).length;

    return res.status(200).json({ total, counted, of: keys.length, rows });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
