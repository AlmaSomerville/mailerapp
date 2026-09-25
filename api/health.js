// api/health.js — post-deploy sanity check.
//
//   GET /api/health?secret=<ADMIN_PASSWORD>
//
// WHY THE IMPORTS ARE STATIC
// The first version of this file did `await import(pathVariable)` in a loop. Vercel's
// bundler traces STATIC imports to decide which files ship in a function's bundle, and a
// computed dynamic path is untraceable — so every module reported "Cannot find module"
// even though the files were present and the cron was using them happily. Static imports
// force them into the bundle, and the check becomes implicit: if a module were missing or
// misnamed, THIS function would fail to load and return a 500 naming the file. So a 200
// from this endpoint means every module resolved.
import { appBaseUrl } from '../lib/util.js';
import * as activity from '../lib/activity.js';
import * as alert from '../lib/alert.js';
import * as allocate from '../lib/allocate.js';
import * as bounces from '../lib/bounces.js';
import * as checklist from '../lib/checklist.js';
import * as designs from '../lib/designs.js';
import * as gmail from '../lib/gmail.js';
import * as hubspot from '../lib/hubspot.js';
import * as links from '../lib/links.js';
import * as marketing from '../lib/marketing.js';
import * as metrics from '../lib/metrics.js';
import * as processMod from '../lib/process.js';
import * as region from '../lib/region.js';
import * as settings from '../lib/settings.js';
import * as sms from '../lib/sms.js';
import * as spamcheck from '../lib/spamcheck.js';
import * as store from '../lib/store.js';
import * as tokens from '../lib/tokens.js';
import * as triggers from '../lib/triggers.js';

const MODULES = {
  'lib/activity.js': activity, 'lib/bounces.js': bounces, 'lib/checklist.js': checklist,
  'lib/designs.js': designs, 'lib/gmail.js': gmail, 'lib/hubspot.js': hubspot,
  'lib/links.js': links, 'lib/marketing.js': marketing, 'lib/metrics.js': metrics,
  'lib/process.js': processMod, 'lib/region.js': region, 'lib/settings.js': settings,
  'lib/sms.js': sms, 'lib/spamcheck.js': spamcheck, 'lib/store.js': store,
  'lib/tokens.js': tokens, 'lib/triggers.js': triggers
};

// Names taken from the code, not guessed. Secrets report presence only.
const REQUIRED = ['ADMIN_PASSWORD', 'CRON_SECRET', 'HUBSPOT_TOKEN', 'KV_REST_API_URL',
                  'KV_REST_API_TOKEN', 'GOOGLE_SA_EMAIL', 'GOOGLE_SA_KEY'];
const RECOMMENDED = ['APP_URL', 'SENDER_ADDRESS', 'SENDER_NAME', 'OPENPHONE_API_KEY'];
const OPTIONAL = ['MAX_PER_RUN', 'HUBSPOT_MIN_GAP_MS', 'SEND_START_HOUR', 'SEND_END_HOUR',
                  'SEND_TZ', 'BRAND_NAME', 'BRAND_DOMAIN'];
const PLAIN = new Set(['APP_URL', 'SENDER_ADDRESS', 'SENDER_NAME', 'MAX_PER_RUN',
                       'HUBSPOT_MIN_GAP_MS', 'SEND_START_HOUR', 'SEND_END_HOUR', 'SEND_TZ',
                       'BRAND_NAME', 'BRAND_DOMAIN']);

function readEnv(keys) {
  const out = {};
  for (const k of keys) {
    const v = process.env[k];
    out[k] = v ? (PLAIN.has(k) ? v : `set (${v.length} chars)`) : 'not set';
  }
  return out;
}

export default async function handler(req, res) {
  const secret = req.query.secret || '';
  const ok = (process.env.ADMIN_PASSWORD && secret === process.env.ADMIN_PASSWORD) ||
             (process.env.CRON_SECRET && secret === process.env.CRON_SECRET);
  if (!ok) return res.status(401).json({ error: 'unauthorized — pass ?secret=' });

  const base = appBaseUrl();
  const rawAppUrl = process.env.APP_URL || null;

  const problems = [];
  const warnings = [];

  if (rawAppUrl && rawAppUrl.trim() !== base) {
    problems.push(`APP_URL is malformed. It was cleaned up to ${base} for this response, but fix the env var: it should be exactly ${base}`);
  }
  if (!rawAppUrl) {
    warnings.push(`APP_URL is not set, so the base URL is inferred from the Vercel production domain (${base}). It will silently change if you change the primary domain.`);
  }
  for (const k of REQUIRED) if (!process.env[k]) problems.push(`${k} is not set`);
  if (!process.env.SENDER_ADDRESS) {
    problems.push('SENDER_ADDRESS is not set, so marketing emails ship with no physical postal address in the footer. Commercial email is legally required to include one.');
  }
  if (!process.env.SENDER_NAME) warnings.push("SENDER_NAME is not set, so the footer falls back to 'Dogwise Academy'.");

  const moduleExports = {};
  for (const [name, mod] of Object.entries(MODULES)) {
    const n = Object.keys(mod || {}).length;
    moduleExports[name] = n ? `ok (${n} exports)` : 'loaded but exports nothing';
  }

  return res.status(200).json({
    healthy: problems.length === 0,
    baseUrl: base,
    urlsInEmails: {
      trackedLink: `${base}/api/c?e=<sendId>&i=0`,
      openPixel: `${base}/api/px?e=<sendId>`,
      unsubscribe: `${base}/api/unsubscribe?e=<sendId>`
    },
    problems,
    warnings,
    note: 'A 200 from this endpoint means every lib module resolved. A 500 means one is missing or misnamed, and the Vercel log will name it.',
    modules: moduleExports,
    env: { required: readEnv(REQUIRED), recommended: readEnv(RECOMMENDED), optional: readEnv(OPTIONAL) }
  });
}
