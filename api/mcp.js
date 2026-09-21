// api/mcp.js — the actual MCP tool server. One McpServer instance is built fresh per
// request (stateless mode — sessionIdGenerator: undefined), which matches how Vercel's
// serverless functions work: no long-lived process to keep session state in, so we
// don't try to. Every tool call is a self-contained request against your existing
// lib/ functions — the same ones the dashboard and cron use, nothing new underneath.
//
// AUTH: every request needs `Authorization: Bearer <access_token>` from the OAuth flow
// in api/oauth/*.js. A missing/invalid token gets a 401 with a WWW-Authenticate header
// pointing at the protected-resource metadata, so a spec-compliant client knows to go
// log in rather than just failing silently.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { validAccessToken } from '../lib/oauth.js';
import { getCampaigns, saveCampaigns } from '../lib/store.js';
import { validCampaign } from './campaigns.js';
import { findContactByEmail, updateContact } from '../lib/hubspot.js';
import { buildCampaignAnalytics } from '../lib/analyticsCore.js';
import { dayRange } from '../lib/metrics.js';
import { getEvents, getAllTimeStats } from '../lib/activity.js';
import { appBaseUrl } from '../lib/util.js';
import { listDesigns, getDesign, saveDesign, deleteDesign, designUsage, slugifyDesignId } from '../lib/designs.js';
import { getPlaceholders } from '../lib/settings.js';
import { tokenCatalogue } from '../lib/tokens.js';

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}
function errorResult(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function buildServer() {
  const server = new McpServer({ name: 'dogwise-mailer', version: '1.0.0' });

  server.registerTool('list_sequences', {
    description: 'List every sequence (campaign): key, label, type (sequence/checklist), step count, and whether A/B testing or send-time optimization is on for it.'
  }, async () => {
    const all = await getCampaigns();
    const list = Object.entries(all).map(([key, c]) => ({
      key, label: c.label || key, type: c.type || 'sequence',
      steps: (c.steps || []).length,
      hasVariants: (c.steps || []).some(s => Array.isArray(s.variants) && s.variants.length > 0),
      sendOptimization: c.sendOptimization?.enabled || false
    }));
    return textResult(list);
  });

  server.registerTool('get_sequence', {
    description: 'Get the full definition of one sequence by key — every step, its subject/body (or A/B variants), delay, channel, send window, and settings. Use list_sequences first if you don\u2019t know the key.',
    inputSchema: { key: z.string().describe('Campaign key, e.g. "welcome"') }
  }, async ({ key }) => {
    const all = await getCampaigns();
    if (!all[key]) return errorResult(`No sequence with key "${key}". Call list_sequences to see valid keys.`);
    return textResult(all[key]);
  });

  server.registerTool('save_sequence', {
    description: 'Create a new sequence, or overwrite an existing one entirely, by key. Pass the FULL campaign object (label, steps, etc — same shape get_sequence returns), not a partial patch. For small edits to one existing sequence, prefer update_sequence_step instead, which is safer. Steps: [{channel:"email"|"sms", subject, body, delayDaysAfter, days:{weekday,weekend}}] — or, for A/B testing, replace subject/body on a step with variants:[{id:"A",subject,body},{id:"B",subject,body}] (email or SMS steps only, not marketing-design steps). `body` here is plain text + light markdown ([[button:Text|url]], ![alt](url), [text](url), **bold**) — it gets HTML-escaped, so a full HTML document pasted into `body` sends as literal escaped markup, not a rendered email. For an HTML-designed marketing email, use create_marketing_design + attach_marketing_design instead — that\\u2019s a different step shape (format:"design", designId), not a body string. Call list_placeholders first so subject/body only use tokens that actually exist.',
    inputSchema: {
      key: z.string().regex(/^[a-z0-9_]+$/).describe('Lowercase letters, numbers, underscores only'),
      campaign: z.record(z.any()).describe('The full campaign object to save')
    }
  }, async ({ key, campaign }) => {
    const problem = validCampaign(campaign);
    if (problem) return errorResult(problem);
    if (campaign.type !== 'checklist' && campaign.steps?.length) {
      campaign.steps[campaign.steps.length - 1].delayDaysAfter = null; // last step never delays, same rule the dashboard enforces
    }
    const all = await getCampaigns();
    all[key] = campaign;
    await saveCampaigns(all);
    return textResult({ ok: true, key });
  });

  server.registerTool('update_sequence_step', {
    description: 'Edit one field on one step of an existing sequence (subject, body, delayDaysAfter, or channel) without having to resend the whole sequence. Use get_sequence first to see current step indices (0-based) and content. `body` is plain text + light markdown only \\u2014 it gets HTML-escaped before sending, so pasting a full HTML document here sends as literal escaped markup, not a rendered email. If the step\\u2019s current format is "design" (get_sequence shows designId), don\\u2019t set body at all \\u2014 use update_marketing_design on its designId instead. For a brand-new HTML marketing email, use create_marketing_design + attach_marketing_design. Call list_placeholders first so subject/body only use tokens that actually exist.',
    inputSchema: {
      key: z.string(),
      stepIndex: z.number().int().min(0).describe('0-based index into the steps array'),
      subject: z.string().optional(),
      body: z.string().optional(),
      delayDaysAfter: z.number().min(0).optional().describe('Days to wait after the previous step before sending this one'),
    }
  }, async ({ key, stepIndex, subject, body, delayDaysAfter }) => {
    const all = await getCampaigns();
    const c = all[key];
    if (!c) return errorResult(`No sequence with key "${key}".`);
    if (c.type === 'checklist') return errorResult('Checklist campaigns don\u2019t have numbered steps — use save_sequence with the firstEmail/intros/blocks fields instead.');
    const step = c.steps?.[stepIndex];
    if (!step) return errorResult(`Sequence "${key}" has no step at index ${stepIndex} (it has ${c.steps?.length || 0} steps).`);
    if (subject != null) step.subject = subject;
    if (body != null) step.body = body;
    if (delayDaysAfter != null) step.delayDaysAfter = delayDaysAfter;
    const problem = validCampaign(c);
    if (problem) return errorResult(problem);
    await saveCampaigns(all);
    return textResult({ ok: true, key, stepIndex, step });
  });

  server.registerTool('delete_sequence', {
    description: 'Delete a sequence by key. The "welcome" sequence and any checklist-type campaign can\u2019t be deleted (only edited) — same rule the dashboard enforces.',
    inputSchema: { key: z.string() }
  }, async ({ key }) => {
    const all = await getCampaigns();
    if (key === 'welcome') return errorResult('The welcome email can be edited but not deleted.');
    if (all[key]?.type === 'checklist') return errorResult('Checklist campaigns can be edited but not deleted.');
    if (!all[key]) return errorResult(`No sequence with key "${key}".`);
    delete all[key];
    await saveCampaigns(all);
    return textResult({ ok: true, deleted: key });
  });

  server.registerTool('enroll_contact', {
    description: 'Enroll one contact (by email) into a sequence, starting at step 1. Fails clearly if the email isn\u2019t found in HubSpot or the sequence key doesn\u2019t exist.',
    inputSchema: {
      email: z.string().email(),
      campaign: z.string().describe('Sequence key — see list_sequences'),
      startInDays: z.number().min(0).optional().describe('Delay before the first send, in days. Default 0 (send window permitting).')
    }
  }, async ({ email, campaign, startInDays = 0 }) => {
    const all = await getCampaigns();
    if (!all[campaign]) return errorResult(`No sequence with key "${campaign}". Call list_sequences to see valid keys.`);
    const contact = await findContactByEmail(email);
    if (!contact) return errorResult(`No HubSpot contact found with email "${email}".`);
    // "Send now" must use the 0 sentinel, exactly as the HubSpot workflows do. A Date.now()
    // stamp sorts to the TAIL of the ascending due queue, behind every stuck and deferred
    // contact, and with a backlog larger than MAX_PER_RUN it is never reached. 0 sorts first.
    // Same staleness-exemption trade-off noted in api/enroll.js.
    const firstSend = startInDays > 0 ? String(Date.now() + startInDays * 24 * 60 * 60 * 1000) : '0';
    await updateContact(contact.id, { dw_campaign: campaign, dw_campaign_step: '1', dw_next_send: firstSend });
    return textResult({ ok: true, contactId: contact.id, email, campaign });
  });

  server.registerTool('get_analytics', {
    description: 'Sent/opened/clicked/replied funnel data per sequence, per step (and per A/B variant where set up), plus which links get clicked and when opens happen. This is the real, current data behind the dashboard\u2019s Reports tab — use it to answer questions like "which email underperforms" or "did variant A beat variant B".',
    inputSchema: {
      campaigns: z.array(z.string()).optional().describe('Specific sequence keys, or omit for all'),
      days: z.number().int().min(1).max(90).optional().describe('Lookback window in days, default 14')
    }
  }, async ({ campaigns, days = 14 }) => {
    const { configured, campaigns: out } = await buildCampaignAnalytics(campaigns, days);
    if (!configured) return errorResult('Analytics storage (Upstash Redis) isn\u2019t configured on this deployment.');
    return textResult({ days: dayRange(days), campaigns: out });
  });

  server.registerTool('get_activity', {
    description: 'Recent send/open/click/reply/error events (most recent first), plus today/this-week/all-time totals. Good for "what\u2019s happened recently" or debugging a specific failure.',
    inputSchema: { limit: z.number().int().min(1).max(2000).optional().describe('Max events to return, default 300') }
  }, async ({ limit = 300 }) => {
    const [events, allTime] = await Promise.all([getEvents(limit), getAllTimeStats()]);
    return textResult({ events, allTime });
  });

  server.registerTool('list_placeholders', {
    description: 'List every {{token}} that actually works in an email, SMS, or marketing design \u2014 built-in ones (firstname, sender_booking_link, etc.) plus every custom token defined in Settings (e.g. {{dog_name}}), with which HubSpot object/property it maps to and its fallback text. Call this BEFORE writing or editing any email/SMS copy so you only use tokens that exist \u2014 an unlisted token isn\\u2019t an error, it just silently renders as blank or its fallback at send time, so guessing produces broken-looking copy with no warning.'
  }, async () => {
    return textResult(tokenCatalogue(await getPlaceholders()));
  });

  // ── Marketing designs ──────────────────────────────────────────────────
  // These are the drag-and-drop "marketing email" steps (format:'design'). A design
  // can come from the visual builder OR from raw HTML (e.g. written in Claude and
  // handed straight to create_marketing_design) — the send path only ever needs
  // rendered HTML, so an HTML-authored design works identically to a builder one; it
  // just can't be reopened in the drag-and-drop builder afterwards. See lib/designs.js.

  server.registerTool('list_marketing_designs', {
    description: 'List every saved marketing email design: id, name, when it was last updated, and whether it came from the visual builder or raw HTML. Use this before get/update/delete/attach to find the right id.'
  }, async () => {
    return textResult(await listDesigns());
  });

  server.registerTool('get_marketing_design', {
    description: 'Read one marketing design in full \u2014 its HTML, plain-text fallback, and (if built visually) the builder document. Use list_marketing_designs first if you don\u2019t know the id.',
    inputSchema: { id: z.string() }
  }, async ({ id }) => {
    const record = await getDesign(id);
    if (!record) return errorResult(`No design with id "${id}". Call list_marketing_designs to see valid ids.`);
    return textResult(record);
  });

  server.registerTool('create_marketing_design', {
    description: 'Create a new marketing email design from raw HTML \u2014 e.g. HTML written in Claude, pasted straight in. No visual builder involved. Produces a design usable in a sequence step exactly like one made in the drag-and-drop builder (attach it with attach_marketing_design). Plain-text fallback is auto-derived from the HTML if you don\u2019t supply one. Click tracking, the open pixel, and the unsubscribe footer are added automatically at send time \u2014 don\u2019t include your own.',
    inputSchema: {
      name: z.string().describe('Human-readable name shown in the dashboard'),
      html: z.string().describe('Full HTML for the email. Personalization tokens work the same as in any other step \u2014 call list_placeholders first to see which ones actually exist (built-ins plus any custom ones defined in Settings) rather than guessing a name like {{dog_name}}.'),
      text: z.string().optional().describe('Plain-text fallback. Auto-generated from the HTML if omitted.'),
      id: z.string().regex(/^[a-z0-9_-]{3,60}$/).optional().describe('Lowercase id, 3\u201360 chars (letters, numbers, _ or -). Auto-generated from name if omitted.')
    }
  }, async ({ name, html, text, id }) => {
    const resolvedId = id || slugifyDesignId(name);
    const existing = await getDesign(resolvedId);
    if (existing) return errorResult(`A design with id "${resolvedId}" already exists \u2014 use update_marketing_design to change it, or pass a different id.`);
    try {
      const record = await saveDesign({ id: resolvedId, name, html, text });
      return textResult({ ok: true, id: record.id, name: record.name, source: record.source, updatedAt: record.updatedAt });
    } catch (e) {
      return errorResult(e.message);
    }
  });

  server.registerTool('update_marketing_design', {
    description: 'Rewrite an existing marketing design\u2019s HTML, plain text, and/or name. Any field you omit keeps its current value \u2014 pass only what\u2019s changing. If you pass new HTML without new text, the plain-text fallback is regenerated from the new HTML (the old one would be stale). Any sequence step already attached to this design picks up the change immediately, no re-attach needed.',
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      html: z.string().optional(),
      text: z.string().optional()
    }
  }, async ({ id, name, html, text }) => {
    const existing = await getDesign(id);
    if (!existing) return errorResult(`No design with id "${id}". Call list_marketing_designs to see valid ids.`);
    try {
      const record = await saveDesign({
        id,
        name: name ?? existing.name,
        design: html != null ? null : existing.design,   // new HTML replaces a builder document too — nothing left to reopen visually
        html: html ?? existing.html,
        text: text ?? (html != null ? null : existing.text)   // null → saveDesign derives fresh text from the (possibly new) html
      });
      return textResult({ ok: true, id: record.id, name: record.name, source: record.source, updatedAt: record.updatedAt });
    } catch (e) {
      return errorResult(e.message);
    }
  });

  server.registerTool('delete_marketing_design', {
    description: 'Delete a marketing design. Refuses if any sequence step still uses it (lists which) unless force is true \u2014 those steps would fail to send until pointed at another design.',
    inputSchema: {
      id: z.string(),
      force: z.boolean().optional().describe('Delete even if sequence steps still reference this design. Default false.')
    }
  }, async ({ id, force = false }) => {
    const existing = await getDesign(id);
    if (!existing) return errorResult(`No design with id "${id}".`);
    const all = await getCampaigns();
    const uses = designUsage(all, id);
    if (uses.length && !force) {
      return errorResult(`Still used by: ${uses.map(u => `${u.label || u.campaign} step ${u.step}${u.variant ? ` (variant ${u.variant})` : ''}`).join(', ')}. Pass force:true to delete anyway \u2014 those steps will fail to send until pointed at another design.`);
    }
    await deleteDesign(id);
    return textResult({ ok: true, deleted: id, hadUses: uses });
  });

  server.registerTool('attach_marketing_design', {
    description: 'Put a design into a sequence step, turning that step into a marketing email. Converts the step to channel:"email", format:"design". A design step needs a subject line \u2014 pass one, or the design\u2019s own name is used if the step doesn\u2019t already have a subject. Use get_sequence first for the step index (0-based) and list_marketing_designs for the design id.',
    inputSchema: {
      key: z.string().describe('Sequence key \u2014 see list_sequences'),
      stepIndex: z.number().int().min(0).describe('0-based index into the steps array'),
      designId: z.string(),
      subject: z.string().optional().describe('Subject line for this step. Falls back to the step\u2019s existing subject, then the design\u2019s name, if omitted.')
    }
  }, async ({ key, stepIndex, designId, subject }) => {
    const all = await getCampaigns();
    const c = all[key];
    if (!c) return errorResult(`No sequence with key "${key}". Call list_sequences to see valid keys.`);
    if (c.type === 'checklist') return errorResult('Checklist campaigns don\u2019t have numbered steps to attach a design to.');
    const step = c.steps?.[stepIndex];
    if (!step) return errorResult(`Sequence "${key}" has no step at index ${stepIndex} (it has ${c.steps?.length || 0} steps).`);
    const design = await getDesign(designId);
    if (!design) return errorResult(`No design with id "${designId}". Call list_marketing_designs to see valid ids.`);

    step.channel = 'email';
    step.format = 'design';
    step.designId = designId;
    step.subject = subject || step.subject || design.name;
    delete step.body;       // not used by a design step; leaving a stale plain-text body around invites confusion
    delete step.variants;   // attach_marketing_design sets ONE design on this step; use save_sequence directly for A/B design variants

    const problem = validCampaign(c);
    if (problem) return errorResult(problem);
    await saveCampaigns(all);
    return textResult({ ok: true, key, stepIndex, step });
  });

  return server;
}

export default async function handler(req, res) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!(await validAccessToken(token))) {
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${appBaseUrl()}/.well-known/oauth-protected-resource"`);
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized — sign in first.' },
      id: null
    });
  }

  if (req.method === 'GET' || req.method === 'DELETE') {
    return res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  }

  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => { transport.close(); server.close(); });
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: `Internal server error: ${e.message}` }, id: null });
    }
  }
}
