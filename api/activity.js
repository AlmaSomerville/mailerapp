// api/activity.js — feed for the dashboard's Activity tab
import { getEvents, getAllTimeStats } from '../lib/activity.js';

export default async function handler(req, res) {
  const auth = req.headers['authorization'] || '';
  if (!(process.env.ADMIN_PASSWORD && auth === `Bearer ${process.env.ADMIN_PASSWORD}`)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const [events, allTime] = await Promise.all([getEvents(2000), getAllTimeStats()]);
  const now = Date.now();
  const dayMs = 86400000;
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);

  const count = (type, since) => events.filter(e => e.type === type && e.t >= since).length;
  const stats = {
    today: { sent: count('sent', startOfToday.getTime()), opened: count('opened', startOfToday.getTime()), replied: count('replied', startOfToday.getTime()), errors: count('error', startOfToday.getTime()) },
    week: { sent: count('sent', now - 7 * dayMs), opened: count('opened', now - 7 * dayMs), replied: count('replied', now - 7 * dayMs), errors: count('error', now - 7 * dayMs) }
  };

  return res.status(200).json({ events, stats, allTime });
}
