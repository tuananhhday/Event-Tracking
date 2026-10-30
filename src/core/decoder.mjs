import { createHash } from 'node:crypto';
import { redact, redactUrl } from './privacy.mjs';

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
// Browser /g/collect serialization, independently implemented from the field
// table in analytics-debugger/ga4mp (MIT), commit b2e66f0709b2be583561db4277a25469930b736f,
// src/modules/ga4Schema.js and src/ga4mp.js. This is not Google's JSON MP schema.
const GA4_ITEM_FIELDS = Object.freeze({
  id: 'item_id', nm: 'item_name', br: 'item_brand', ca: 'item_category', c2: 'item_category2', c3: 'item_category3', c4: 'item_category4', c5: 'item_category5',
  va: 'item_variant', pr: 'price', qt: 'quantity', cp: 'coupon', ln: 'item_list_name', lp: 'index', li: 'item_list_id', ds: 'discount', af: 'affiliation',
  pi: 'promotion_id', pn: 'promotion_name', cn: 'creative_name', cs: 'creative_slot', lo: 'location_id',
});
const GA4_NUMERIC_ITEMS = new Set(['price', 'quantity', 'index', 'discount']);
const decimal = value => typeof value === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value));
const sensitiveItemName = name => redact({ [name]: '__eventqa_sensitive_probe__' })[name] !== '__eventqa_sensitive_probe__';

function safeCompactString(value) {
  if (typeof value !== 'string') return value;
  // Do not persist a potentially sensitive value merely because it exceeded
  // the decoder's bound. The hash permits correlation without retaining it.
  if (value.length > 200000) return `[OMITTED_COMPACT_ITEM sha256=${sha(value)}]`;
  const tokens = value.split('~');
  const sensitive = new Set(tokens.flatMap(token => {
    const pair = token.match(/^k([0-9A-Z])([\s\S]*)$/);
    return pair && sensitiveItemName(pair[2]) ? [pair[1]] : [];
  }));
  return tokens.map(token => sensitive.has(token[1]) && token.startsWith('v') ? token.slice(0, 2) + '[REDACTED]' : token).join('~');
}
function safeCompactFields(value) {
  if (Array.isArray(value)) return value.map(safeCompactFields);
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return safeGa4Url(value);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^pr\d+$/.test(key)
    ? Array.isArray(item) ? item.map(safeCompactString) : safeCompactString(item) : safeCompactFields(item)]));
}
function safeGa4Url(value, depth = 0) {
  if (depth > 8) return `[OMITTED_NESTED_URL sha256=${sha(value)}]`;
  try {
    const url = new URL(value), pairs = [...url.searchParams]; let changed = false;
    const safe = new URLSearchParams();
    for (const [key, item] of pairs) {
      const redacted = /^pr\d+$/.test(key) ? safeCompactString(item) : /^https?:\/\//i.test(item) ? safeGa4Url(item, depth + 1) : item;
      if (redacted !== item) changed = true;
      safe.append(key, redacted);
    }
    if (changed) url.search = safe.toString();
    return redactUrl(url.toString());
  } catch { return redactUrl(value); }
}

function ga4Payload(input, originForKey) {
  const result = Object.create(null), origins = Object.create(null), warnings = [], itemIndexes = [];
  let partial = false;
  const warn = (code, parameter, detail = {}, incomplete = true) => { warnings.push({ code, parameter, ...detail }); if (incomplete) partial = true; };
  for (const [key, value] of Object.entries(input)) {
    const name = key.startsWith('epn.') ? key.slice(4) : key.startsWith('ep.') ? key.slice(3) : key === 'en' ? 'event' : key;
    const normalized = key.startsWith('epn.') && decimal(value) ? Number(value) : value;
    if (Object.hasOwn(result, name)) {
      result[name] = [].concat(result[name], normalized);
      origins[name] += `; ${originForKey(key)}`;
      warn('AMBIGUOUS_PARAMETER', key, { normalized_name: name });
    } else { result[name] = normalized; origins[name] = originForKey(key); }
    if (Array.isArray(value)) warn('REPEATED_PARAMETER', key);
    else if (key.startsWith('epn.') && !decimal(value)) warn('INVALID_NUMERIC_PARAMETER', key, {}, false);
  }
  const productKeys = Object.keys(input).filter(key => /^pr\d+$/.test(key)).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
  const indexCounts = new Map();
  for (const key of productKeys) indexCounts.set(Number(key.slice(2)), (indexCounts.get(Number(key.slice(2))) || 0) + 1);
  const items = [], itemOrigins = Object.create(null);
  for (const key of productKeys) {
    const position = Number(key.slice(2)), raw = input[key];
    if (!Number.isInteger(position) || position < 1 || position > 200) { warn('UNSUPPORTED_ITEM_INDEX', key); continue; }
    if (indexCounts.get(position) > 1) { warn('AMBIGUOUS_ITEM_INDEX', key, { item_index: position }); continue; }
    if (typeof raw === 'string' && raw.startsWith('[OMITTED_COMPACT_ITEM sha256=')) { warn('COMPACT_ITEM_TOO_LARGE', key); continue; }
    if (typeof raw !== 'string' || raw.length > 200000) { warn('UNREADABLE_COMPACT_ITEM', key); continue; }
    // URLSearchParams has decoded the request once. Do not double-decode item
    // values: a transmitted literal %2F, + or % must remain that exact value.
    const tokens = raw.split('~'), item = Object.create(null), custom = new Map(), seen = new Set(), blocked = new Set();
    if (tokens.length > 256) { warn('COMPACT_ITEM_TOO_LARGE', key); continue; }
    const itemIndex = items.length;
    const assign = (name, value, tokenIndex, code) => {
      if (seen.has(name)) {
        delete item[name]; delete itemOrigins[`items.${itemIndex}.${name}`]; blocked.add(name);
        warn('DUPLICATE_ITEM_FIELD', key, { field: name, token_index: tokenIndex }); return;
      }
      seen.add(name);
      if (blocked.has(name)) return;
      item[name] = value;
      itemOrigins[`items.${itemIndex}.${name}`] = `${originForKey(key)} (compact ${code}, token ${tokenIndex})`;
    };
    for (const [tokenIndex, token] of tokens.entries()) {
      if (!token) continue; // Common serializers append an empty final segment.
      const pair = token.match(/^([kv])([0-9A-Z])([\s\S]*)$/);
      if (pair) {
        const entry = custom.get(pair[2]) || { indexes: [] };
        if (Object.hasOwn(entry, pair[1])) { entry.duplicate = true; warn('DUPLICATE_CUSTOM_ITEM_FIELD', key, { slot: pair[2], token_index: tokenIndex }); }
        entry[pair[1]] = pair[3]; entry.indexes.push(tokenIndex); custom.set(pair[2], entry); continue;
      }
      const code = token.slice(0, 2), name = GA4_ITEM_FIELDS[code];
      if (!name) { warn('UNKNOWN_COMPACT_ITEM_FIELD', key, { token_index: tokenIndex, token }); continue; }
      const text = token.slice(2);
      if (GA4_NUMERIC_ITEMS.has(name) && !decimal(text)) warn('INVALID_NUMERIC_ITEM_VALUE', key, { field: name, token_index: tokenIndex }, false);
      assign(name, GA4_NUMERIC_ITEMS.has(name) && decimal(text) ? Number(text) : text, tokenIndex, code);
    }
    for (const [slot, entry] of custom) {
      if (entry.duplicate || !Object.hasOwn(entry, 'k') || !Object.hasOwn(entry, 'v') || !entry.k) {
        warn('UNPAIRED_CUSTOM_ITEM_FIELD', key, { slot }); continue;
      }
      assign(entry.k, entry.v, entry.indexes.join(','), `k${slot}/v${slot}`);
    }
    if (Object.keys(item).length) { items.push(item); itemIndexes.push(position); }
    else {
      // No empty object pretending to be a decoded product. Remove origins that
      // belonged to this unsuccessful logical array index before the next item.
      for (const name of Object.keys(itemOrigins)) if (name.startsWith(`items.${itemIndex}.`)) delete itemOrigins[name];
      warn('EMPTY_COMPACT_ITEM', key);
    }
  }
  if (productKeys.length) {
    if (Object.hasOwn(result, 'items')) warn('ITEMS_PARAMETER_COLLISION', 'items');
    else {
      result.items = items;
      origins.items = productKeys.map(originForKey).join('; ');
      Object.assign(origins, itemOrigins);
    }
  }
  return { payload: result, origins, detail: { status: partial ? 'PARTIAL' : 'DECODED', item_indexes: itemIndexes, warnings }, partial };
}
export function decodeRequest({ url, body = '', bodyUnavailable = false, contentType = '', method = 'POST', requestId, status, source, capturedAt, pageUrl }) {
  let query = {}, host = '', pathname = '';
  try { const u = new URL(url); query = flatQuery(u.search); host = u.hostname; pathname = u.pathname; } catch { /* unsupported URL kept as redacted evidence */ }
  const decoded = parsedBody(body, contentType);
  const ga = query.en || decoded.parts.some(p => p?.en);
  const vendor = (source || (/(?:^|\.)(?:google-analytics\.com|analytics\.google\.com)$/i.test(host) || ga ? 'GA4'
    : /(?:^|\.)useinsider\.com$/i.test(host) || /\/insider\//i.test(pathname) ? 'INSIDER'
    : /(?:^|\.)facebook\.com$/i.test(host) && /^\/tr\/?$/i.test(pathname) ? 'META'
    : /(?:^|\.)tiktok\.com$/i.test(host) && /pixel/i.test(pathname) ? 'TIKTOK' : 'CUSTOM')).toUpperCase();
  const records = [];
  for (const [partIndex, part] of decoded.parts.entries()) {
    const merged = { ...query, ...(part && typeof part === 'object' ? part : { value: part }) };
    const batch = Array.isArray(merged.events);
    const items = batch ? merged.events.map(event => ({ ...merged, events: undefined, ...event })) : [merged];
    for (const [itemIndex, item] of items.entries()) {
      let payload = item;
      let decodedOrigins;
      let ga4Decoded;
      if (vendor === 'CUSTOM' && ['d', 'data', 'payload'].some(key => typeof payload[key] === 'string' && payload[key].length > 32)) {
        payload = { decode_status: 'UNPARSED', raw_hash: sha(JSON.stringify(payload)), content_type: contentType, reason: 'opaque_vendor_payload' };
      }
      if (vendor === 'GA4' || payload.en) {
        const originForKey = key => {
          const fromItem = batch && merged.events[itemIndex] && Object.hasOwn(merged.events[itemIndex], key);
          const base = fromItem ? `original_payload.events[${itemIndex}]` : 'original_payload';
          return `${base}[${JSON.stringify(key)}]`;
        };
        ga4Decoded = ga4Payload(safeCompactFields(payload), originForKey);
        decodedOrigins = ga4Decoded.origins; payload = ga4Decoded.payload;
      }
      // `ev` is the Meta Pixel event parameter.
      const eventName = payload.event || payload.event_name || payload.name || payload.type || payload.ev || (payload.decode_status === 'UNPARSED' ? 'UNPARSED' : 'tracking_request');
      records.push(redact({ schema_version: '1.0', source: vendor, layer: 'TRACKING_REQUEST',
        captured_at: capturedAt || new Date().toISOString(), event_name: typeof eventName === 'string' ? eventName : 'tracking_request',
        page: { url: (ga4Decoded ? safeGa4Url : redactUrl)(pageUrl || payload.dl || payload.page_location || url) }, payload,
        ...(batch || decodedOrigins ? { original_payload: ga4Decoded ? safeCompactFields(merged) : merged } : {}),
        ...(batch ? { original_event_index: itemIndex } : {}),
        ...(decoded.parts.length > 1 ? { original_batch_index: partIndex } : {}),
        ...(ga4Decoded ? { request_parameter_sources: { query: safeCompactFields(query), body: safeCompactFields(part) } } : {}),
        ...(decodedOrigins ? { decoded_parameter_origins: decodedOrigins } : {}),
        ...(bodyUnavailable || ga4Decoded?.partial ? { capture: { incomplete: true, reasons: [...(bodyUnavailable ? ['request_body_unavailable'] : []), ...(ga4Decoded?.partial ? ['ga4_parameters_partially_decoded'] : [])] } } : {}),
        network: { request_id: requestId, url: ga4Decoded ? safeGa4Url(url) : redactUrl(url), method, status, phase: 'request', decode_status: bodyUnavailable ? 'UNAVAILABLE' : ga4Decoded?.partial ? 'PARTIAL' : payload.decode_status || decoded.status,
          ...(decoded.parts.length > 1 ? { batch_index: partIndex, batch_size: decoded.parts.length } : {}),
          ...(ga4Decoded ? { ga4_decode: ga4Decoded.detail, raw_url_hash: sha(url), raw_body_hash: sha(Buffer.isBuffer(body) ? body : String(body ?? '')) } : {}) },
        privacy: { redacted: true }
      }));
    }
  }
  return records;
}
