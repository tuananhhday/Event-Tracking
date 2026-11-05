import { createHash } from 'node:crypto';
import { redactApiData } from './api-log.mjs';
import { redactUrl } from './privacy.mjs';

export const TP2_ENDPOINTS = ['/tp2(?:$|/)'];
export const isTp2Endpoint = url => { try { return /\/tp2\/?$/i.test(new URL(url).pathname); } catch { return false; } };
const hash = value => createHash('sha256').update(value).digest('hex');
const schemaName = schema => typeof schema === 'string' ? schema.match(/^iglu:[^/]+\/([^/]+)\//)?.[1] : undefined;

export function decodeBase64Json(value) {
  if (typeof value !== 'string' || !value || value.length > 2_000_000) throw new Error('ue_px rỗng hoặc vượt giới hạn giải mã.');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || value.replace(/=+$/, '').length % 4 === 1) throw new Error('ue_px không phải Base64 hợp lệ.');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== normalized) throw new Error('ue_px có mã Base64 không hợp lệ.');
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('ue_px không chứa JSON UTF-8 hợp lệ.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Dữ liệu ue_px phải là JSON object.');
  return parsed;
}

/** null means a different protocol. Encoded originals are hashed, never persisted unmasked. */
export function decodeTp2Request({ url, body = '', method = 'POST', requestId, status, capturedAt, pageUrl } = {}) {
  let query = {};
  try { query = Object.fromEntries(new URL(url).searchParams); } catch { /* endpoint handled below */ }
  let input;
  const raw = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  if (!isTp2Endpoint(url) && !query.ue_px && !query.ue_pr && !/\bue_p[xr](?:"\s*:|=)/.test(raw)) return null;
  try { input = raw ? JSON.parse(raw) : query; }
  catch { input = Object.fromEntries(new URLSearchParams(raw)); }
  const parts = Array.isArray(input?.data) ? input.data : Array.isArray(input) ? input : [input];
  if (!isTp2Endpoint(url) && !parts.some(part => part && typeof part === 'object' && ('ue_px' in part || 'ue_pr' in part)) && !query.ue_px && !query.ue_pr) return null;
  const captured = capturedAt || new Date().toISOString();
  return parts.map((part, index) => {
    const parameters = { ...query, ...(part && typeof part === 'object' ? part : {}) };
    let wrapper = null, payload = {}, schema = '', decodeStatus = 'DECODED', error;
    try {
      if (parameters.ue_px !== undefined) wrapper = decodeBase64Json(parameters.ue_px);
      else if (parameters.ue_pr !== undefined) wrapper = typeof parameters.ue_pr === 'string' ? JSON.parse(parameters.ue_pr) : parameters.ue_pr;
      else if (!['pv', 'pp', 'se', 'tr', 'ti'].includes(parameters.e)) throw new Error('Request TP2 không có ue_px hoặc ue_pr.');
      if (wrapper) {
        if (typeof wrapper !== 'object' || Array.isArray(wrapper)) throw new Error('Dữ liệu event không đúng JSON object.');
        let node = wrapper;
        if (schemaName(node.schema) === 'unstruct_event') node = node.data;
        schema = typeof node?.schema === 'string' ? node.schema : '';
        payload = schema && node.data && typeof node.data === 'object' ? node.data : node;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Không tìm thấy object dữ liệu nghiệp vụ trong ue_px.');
      } else payload = Object.fromEntries(Object.entries(parameters).filter(([key]) => !['ue_px', 'cx'].includes(key)));
    } catch (failure) { decodeStatus = 'ERROR'; error = failure instanceof SyntaxError ? 'ue_pr không chứa JSON hợp lệ.' : String(failure.message).slice(0, 250); payload = {}; wrapper = null; }
    const eventName = decodeStatus === 'ERROR' ? 'tp2_decode_error' : String(payload.event_name || payload.event || schemaName(schema)
      || ({ pv: 'page_view', pp: 'page_ping', se: 'structured_event', tr: 'transaction', ti: 'transaction_item' }[parameters.e]) || 'tp2_event');
    const eventTime = Number(parameters.dtm), capturedMs = Date.parse(captured);
    const eventAt = Number.isFinite(eventTime) && Math.abs(eventTime - capturedMs) <= 86400000 ? new Date(eventTime).toISOString() : captured;
    const safeParameters = Object.fromEntries(Object.entries(parameters).map(([key, value]) => /^(ue_px|ue_pr|cx)$/i.test(key) && typeof value === 'string'
      ? [key, { encoded: true, sha256: hash(value), length: value.length }] : [key, value]));
    return redactApiData({ schema_version: '1.0', source: 'TP2', layer: 'TRACKING_REQUEST', captured_at: captured, event_name: eventName,
      event_kind: decodeStatus === 'ERROR' ? 'observation' : 'business', page: { url: redactUrl(pageUrl || parameters.url || url) }, payload,
      tp2: { decode_status: decodeStatus, ...(error ? { error } : {}), schema, event_at: eventAt, parameters: safeParameters, decoded: wrapper },
      request_payload: safeParameters,
      network: { request_id: requestId, url: redactUrl(url), method, status, phase: 'request', decode_status: decodeStatus, batch_index: index, batch_size: parts.length }, privacy: { redacted: true } });
  });
}
