import { createHash } from 'node:crypto';
import { ga4Items } from './ga4-parameters.mjs';
import { redact, redactUrl } from './privacy.mjs';
import { eventKind } from './event-kind.mjs';

export const DEFAULT_ENDPOINT_PATTERNS = ['(?:^|\\.)google-analytics\\.com/(?:g/)?collect(?:$|/)', '(?:^|\\.)analytics\\.google\\.com/(?:g/)?collect(?:$|/)', '(?:^|\\.)useinsider\\.com/'];
// Optional vendor allowlists offered by the UI. Each entry matches hostname + path.
export const VENDOR_ENDPOINTS = {
  // Recent Google tags also send GA4 hits to /g/s/collect.
  ga4: { label: 'GA4 (Google)', patterns: [...DEFAULT_ENDPOINT_PATTERNS.slice(0, 2), '(?:^|\\.)(?:google-analytics|analytics\\.google)\\.com/g/s/collect$'] },
  ga4_server: { label: 'GA4 server-side (/g/collect mọi domain)', patterns: ['/g/(?:s/)?collect$'] },
  // Insider event endpoints only; its other hosts serve SDK files, segments and predictions.
  insider: { label: 'Insider', patterns: ['(?:^|\\.)unification\\.useinsider\\.com/api/event/', '(?:^|\\.)hit\\.api\\.useinsider\\.com/hit$'] },
  meta: { label: 'Meta Pixel', patterns: ['(?:^|\\.)facebook\\.com/tr/?$'] },
  tiktok: { label: 'TikTok Pixel', patterns: ['(?:^|\\.)analytics\\.tiktok\\.com/api/v\\d+/pixel'] },
  google_ads: { label: 'Google Ads / Floodlight', patterns: ['(?:^|\\.)googleadservices\\.com/pagead/conversion', '(?:^|\\.)doubleclick\\.net/(?:pagead|activity)'] },
  clarity: { label: 'Microsoft Clarity', patterns: ['(?:^|\\.)clarity\\.ms/collect'] },
};
// Request paths that look like analytics beacons; used only to suggest endpoints.
const TRACKING_HINT = /(?:^|[/._-])(?:collect|track(?:ing)?|events?|beacon|pixel|analytics|telemetry|log(?:ging)?|ubt|metrics?|stats?|tr|hit|ingest)(?:$|[/._-])/i;
export function looksLikeTracking({ url, method, resourceType }) {
  if (String(method).toUpperCase() === 'OPTIONS') return false;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || /\.(?:js|css|png|jpe?g|webp|svg|woff2?|ico|html?)$/i.test(u.pathname)) return false;
    return resourceType === 'Ping' || TRACKING_HINT.test(u.hostname + u.pathname);
  } catch { return false; }
}
// Vendor SDK files, stylesheets, images and fonts share tracking hosts but are not events.
export const STATIC_ASSET = /\.(?:js|mjs|css|png|jpe?g|webp|svg|ico|woff2?|ttf|map)$/i;
export function matchesEndpoint(url, patterns = DEFAULT_ENDPOINT_PATTERNS) {
  // Match hostname + path, never query values that happen to contain a vendor name.
  try { const u = new URL(url); return !STATIC_ASSET.test(u.pathname) && patterns.some(p => new RegExp(p, 'i').test(u.hostname + u.pathname)); }
  catch { return false; }
}
const sha = x => createHash('sha256').update(x).digest('hex');
const flatQuery = s => {
  const out = Object.create(null);
  for (const [k, v] of new URLSearchParams(s)) out[k] = Object.hasOwn(out, k) ? [].concat(out[k], v) : v;
  return out;
};
function parsedBody(body, contentType) {
  const raw = Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? '');
  if (!raw) return { parts: [{}], status: 'DECODED' };
  if (/json/i.test(contentType) || /^[\s]*[\[{]/.test(raw)) {
    try { const val = JSON.parse(raw); return { parts: Array.isArray(val) ? val : [val], status: 'DECODED' }; }
    catch { /* NDJSON handled below. */ }
  }
  // Insider's hit endpoint sends a base64-encoded JSON object (pageView and session data).
  if (/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(raw.trim()) && /^eyJ/.test(raw.trim())) {
    try {
      const val = JSON.parse(Buffer.from(raw.trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (val && typeof val === 'object' && !Array.isArray(val)) return { parts: [val], status: 'DECODED' };
    } catch { /* not base64 JSON after all */ }
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length > 1) {
    try { return { parts: lines.flatMap(s => JSON.parse(s)), status: 'DECODED' }; }
    catch { /* GA4 newline-delimited query records below. */ }
  }
  if (/x-www-form-urlencoded/i.test(contentType) || (/^[\w.%~-]+=/.test(raw) && !/[\x00-\x08]/.test(raw))) {
    return { parts: lines.map(flatQuery), status: 'DECODED' };
  }
  return { parts: [{ decode_status: 'UNPARSED', raw_hash: sha(raw), content_type: contentType, reason: 'unsupported_format' }], status: 'UNPARSED' };
}
function ga4Payload(input) {
  const result = Object.create(null);
  for (const [k, v] of Object.entries(input)) {
    if (k.startsWith('epn.')) result[k.slice(4)] = typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
    else if (k.startsWith('ep.')) result[k.slice(3)] = v;
    else if (k === 'en') result.event = v;
    else result[k] = v;
  }
  const items = ga4Items(input);
  if (items.length && !result.ecommerce) result.ecommerce = { items };
  return result;
}
export function decodeRequest({ url, body = '', contentType = '', method = 'POST', requestId, status, source, capturedAt, pageUrl }) {
  let query = {}, host = '', pathname = '';
  try { const u = new URL(url); query = flatQuery(u.search); host = u.hostname; pathname = u.pathname; } catch { /* unsupported URL kept as redacted evidence */ }
  const decoded = parsedBody(body, contentType);
  const ga = query.en || decoded.parts.some(p => p?.en);
  const vendor = (source || (/(?:^|\.)(?:google-analytics\.com|analytics\.google\.com)$/i.test(host) || ga ? 'GA4'
    : /(?:^|\.)useinsider\.com$/i.test(host) || /\/insider\//i.test(pathname) ? 'INSIDER'
    : /(?:^|\.)facebook\.com$/i.test(host) && /^\/tr\/?$/i.test(pathname) ? 'META'
    : /(?:^|\.)tiktok\.com$/i.test(host) && /pixel/i.test(pathname) ? 'TIKTOK' : 'CUSTOM')).toUpperCase();
  const records = [];
  const requestParts = decoded.parts.map(part => ({ ...query, ...(part && typeof part === 'object' ? part : { value: part }) }));
  const opaque = payload => vendor === 'CUSTOM' && ['d', 'data', 'payload'].some(key => typeof payload?.[key] === 'string' && payload[key].length > 32);
  const opaqueSummary = payload => ({ decode_status: 'UNPARSED', raw_hash: sha(JSON.stringify(payload)), content_type: contentType, reason: 'opaque_vendor_payload' });
  const safeRequestParts = requestParts.map(part => opaque(part) ? opaqueSummary(part) : Array.isArray(part.events)
    ? { ...part, events: part.events.map(event => opaque(event) ? opaqueSummary(event) : event) } : part);
  const requestPayload = safeRequestParts.length === 1 ? safeRequestParts[0] : safeRequestParts;
  const batchSize = requestParts.reduce((size, part) => size + (Array.isArray(part.events) ? part.events.length : 1), 0);
  let batchIndex = 0;
  for (const merged of requestParts) {
    let items;
    if (Array.isArray(merged.events)) items = merged.events.map(event => ({ ...merged, events: undefined, ...event }));
    else items = [merged];
    for (let payload of items) {
      if (opaque(payload)) payload = opaqueSummary(payload);
      if (vendor === 'GA4' || payload.en) payload = ga4Payload(payload);
      // `ev` is the Meta Pixel event parameter.
      const eventName = payload.event || payload.event_name || payload.name || payload.type || payload.ev || (payload.decode_status === 'UNPARSED' ? 'UNPARSED' : 'tracking_request');
      const record = { schema_version: '1.0', source: vendor, layer: 'TRACKING_REQUEST',
        captured_at: capturedAt || new Date().toISOString(), event_name: typeof eventName === 'string' ? eventName : 'tracking_request',
        page: { url: redactUrl(pageUrl || payload.dl || payload.page_location || url) }, payload,
        // Opaque bodies keep their hash/reason only, as before. Do not reintroduce
        // the discarded raw content via the complete-request evidence field.
        request_payload: payload.decode_status === 'UNPARSED' ? payload : requestPayload,
        network: { request_id: requestId, url: redactUrl(url), method, status, phase: 'request', decode_status: payload.decode_status || decoded.status,
          batch_index: batchIndex++, batch_size: batchSize },
        privacy: { redacted: true }
      };
      record.event_kind = eventKind(record);
      records.push(redact(record));
    }
  }
  return records;
}
