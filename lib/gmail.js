// lib/gmail.js — send email as any @dogwiseacademy.com user via domain-wide delegation
import { JWT } from 'google-auth-library';

const SCOPES_SEND = ['https://www.googleapis.com/auth/gmail.send'];
const SCOPES_READ = ['https://www.googleapis.com/auth/gmail.readonly'];

function getKey() {
  // Vercel env vars keep literal \n if pasted via CLI; dashboard pastes keep real newlines.
  return (process.env.GOOGLE_SA_KEY || '').replace(/\\n/g, '\n');
}

// Access tokens last an hour, and a run sends for at most two minutes — so one
// token per sender covers the whole run. Building a fresh JWT client per send
// meant a full OAuth exchange before every single email and every reply check:
// on a 120-contact run, well over a hundred round trips to Google for tokens we
// already held. Module scope, so it also survives between warm invocations.
const tokenCache = new Map();   // `${email}|${scopes}` -> { token, expires }

// Refresh a minute early rather than racing the expiry.
const TOKEN_SKEW_MS = 60 * 1000;

async function getAccessToken(impersonateEmail, scopes = SCOPES_SEND) {
  const cacheKey = `${impersonateEmail}|${scopes.join(',')}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expires > Date.now() + TOKEN_SKEW_MS) return hit.token;

  const client = new JWT({
    email: process.env.GOOGLE_SA_EMAIL,
    key: getKey(),
    scopes,
    subject: impersonateEmail
  });
  const { token } = await client.getAccessToken();
  if (!token) throw new Error(`No access token for ${impersonateEmail}`);

  // google-auth-library exposes the real expiry once a token has been fetched;
  // fall back to a conservative 45 minutes if it is not there.
  const expires = client.credentials?.expiry_date || (Date.now() + 45 * 60 * 1000);
  tokenCache.set(cacheKey, { token, expires });
  return token;
}

/** Drop a cached token — call this if Google rejects one mid-run. */
function invalidateToken(impersonateEmail, scopes = SCOPES_SEND) {
  tokenCache.delete(`${impersonateEmail}|${scopes.join(',')}`);
}

/**
 * Has `fromEmail` sent anything to `ownerEmail`'s mailbox since `sinceMs`?
 * Returns true/false — or null if the readonly scope isn't granted / check failed
 * (callers treat null as "can't check, proceed").
 */
export async function hasMailFrom(ownerEmail, fromEmail, sinceMs) {
  try {
    const token = await getAccessToken(ownerEmail, SCOPES_READ);
    const q = encodeURIComponent(`from:${fromEmail} after:${Math.floor(sinceMs / 1000)}`);
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=1`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.resultSizeEstimate || 0) > 0 || (data.messages || []).length > 0;
  } catch {
    return null; // scope not granted yet, or transient failure — never block sends on this
  }
}

function base64url(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// RFC 2047: email headers are ASCII-only — emoji/accents must be wrapped as =?UTF-8?B?...?=
function encodeHeader(str) {
  if (!/[^\x20-\x7E]/.test(str)) return str; // plain ASCII — leave as-is
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

function buildMime({ from, fromName, to, subject, body, html }) {
  const fromHeader = fromName ? `${encodeHeader(fromName)} <${from}>` : from;
  const headers = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0'
  ];

  if (!html) {
    return [
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body, 'utf8').toString('base64')
    ].join('\r\n');
  }

  // multipart/alternative: plain text fallback + HTML
  const boundary = 'dwm_' + Math.random().toString(36).slice(2);
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64'),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64'),
    `--${boundary}--`
  ].join('\r\n');
}

/**
 * Send an email as `senderEmail` (the deal owner).
 * Pass `html` for a rich version alongside the plain-text `body`.
 * Returns the Gmail message id.
 */
export async function sendAsOwner({ senderEmail, senderName, to, subject, body, html }) {
  const token = await getAccessToken(senderEmail);
  const raw = base64url(buildMime({ from: senderEmail, fromName: senderName, to, subject, body, html }));

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw })
  });

  if (!res.ok) {
    const err = await res.text();
    // A 401 on a cached token means it was revoked or rotated early. Drop it and
    // try once with a fresh one, so caching can never strand a sender.
    if (res.status === 401) {
      invalidateToken(senderEmail);
      const fresh = await getAccessToken(senderEmail);
      const retry = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${fresh}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw })
      });
      if (retry.ok) return (await retry.json()).id;
      const err2 = await retry.text();
      throw new Error(`Gmail send failed (${retry.status}) as ${senderEmail}: ${err2.slice(0, 300)}`);
    }
    throw new Error(`Gmail send failed (${res.status}) as ${senderEmail}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.id;
}
