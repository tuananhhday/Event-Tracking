import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { redactApiData, apiCallSummary } from './api-log.mjs';
import { isTp2Endpoint } from './tp2.mjs';
import { affiliateStage, isMyOrder, orderIdentity, sharesIdentity, suggestTp2Fields } from './tp2-auto.mjs';

export const TP2_LABELS = { MATCH: 'Khớp', MISMATCH: 'Lệch', REVIEW: 'Cần kiểm tra', CLICK: 'Click affiliate', NO_MAPPING: 'Chưa đủ dữ liệu ghép', NO_API: 'Chưa tìm thấy API', AMBIGUOUS: 'Chưa xác định được API', DECODE_ERROR: 'Lỗi giải mã' };
export const valueAt = (value, field = '') => field ? String(field).replace(/\[(\d+)\]/g, '.$1').split('.').reduce((node, key) => node != null && Object.hasOwn(Object(node), key) ? node[key] : undefined, value) : value;
export function fieldPaths(value, prefix = '', out = [], depth = 0) {
  if (out.length >= 500 || depth > 15) return out;
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (out.length >= 500) break;
      fieldPaths(item, Array.isArray(value) ? `${prefix}[${key}]` : prefix ? `${prefix}.${key}` : key, out, depth + 1);
    }
  } else if (prefix) out.push(prefix);
  return out;
}
export function validateTp2Mapping(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Cấu hình đối chiếu phải là JSON object.');
  const result = { id: input.id || `TP2-${randomUUID()}`, name: String(input.name || 'Đối chiếu TP2').trim(), event_name: String(input.event_name || '*').trim(),
    api_pattern: String(input.api_pattern || '').trim(), api_side: input.api_side ?? 'response', record_path: String(input.record_path || ''),
    event_id_path: String(input.event_id_path || ''), api_id_path: String(input.api_id_path || ''), window_ms: input.window_ms ?? 1800000, dynamic_items: input.dynamic_items === true, fields: input.fields };
  if (!/^[\w-]{1,100}$/.test(result.id) || !result.name || result.name.length > 200) throw new Error('Mã hoặc tên cấu hình không hợp lệ.');
  if (!result.api_pattern || result.api_pattern.length > 300) throw new Error('Nhập đường dẫn hoặc regex của API cần so sánh.');
  try { new RegExp(result.api_pattern, 'i'); } catch { throw new Error('Regex API không hợp lệ.'); }
  if (!['request', 'response'].includes(result.api_side) || !Number.isInteger(result.window_ms) || result.window_ms < 1 || result.window_ms > 86400000) throw new Error('Nguồn dữ liệu API hoặc khoảng thời gian không hợp lệ.');
  if (Boolean(result.event_id_path) !== Boolean(result.api_id_path)) throw new Error('Điền cả hai đường dẫn mã định danh TP2 và API, hoặc để trống cả hai.');
  if (!Array.isArray(result.fields) || !result.fields.length || result.fields.length > 100) throw new Error('Cần từ 1 đến 100 cặp trường đối chiếu.');
  result.fields = result.fields.map(field => {
    if (!field || typeof field.event_path !== 'string' || !field.event_path || typeof field.api_path !== 'string' || !field.api_path) throw new Error('Mỗi cặp cần đường dẫn trường TP2 và trường API.');
    const type = field.type ?? 'json';
    if (!['json', 'number', 'string', 'date'].includes(type)) throw new Error('Kiểu so sánh chỉ nhận json, number, string hoặc date.');
    return { event_path: field.event_path, api_path: field.api_path, type, optional: field.optional === true };
  });
  for (const field of [result.event_name, result.record_path, result.event_id_path, result.api_id_path, ...result.fields.flatMap(field => [field.event_path, field.api_path])]) if (field.length > 500) throw new Error('Đường dẫn trường quá dài.');
  return result;
}

export class Tp2MappingStore {
  constructor(file) { this.file = path.resolve(file); this.mappings = []; }
  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Array.isArray(data.mappings)) throw new Error('Sai định dạng cấu hình TP2.');
      this.mappings = data.mappings.map(validateTp2Mapping);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  list() { return structuredClone(this.mappings); }
  async save(mapping) {
    const next = this.list(), valid = validateTp2Mapping(mapping), index = next.findIndex(item => item.id === valid.id);
    if (index < 0) next.push(valid); else next[index] = valid;
    await this.write(next); return valid;
  }
  async delete(id) { await this.write(this.mappings.filter(mapping => mapping.id !== id)); }
  async write(next) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify({ mappings: next }, null, 2), 'utf8'); await fs.rename(temporary, this.file); this.mappings = next; }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
}

function normalized(value, type) {
  if (type === 'json') return value;
  if (type === 'string') return typeof value === 'object' ? undefined : String(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value) ? value
    : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()) && Number.isFinite(Number(value)) ? Number(value) : undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value) || !Number.isFinite(Date.parse(value))) return undefined;
  const day = value.slice(0, 10);
  if (new Date(day).toISOString().slice(0, 10) !== day) return undefined;
  if (value.length === 10) return day;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const masked = value => JSON.stringify(value)?.includes('[REDACTED]');
function compareField(event, record, field) {
  const actual = valueAt(event.payload, field.event_path), expected = valueAt(record, field.api_path);
  let status = 'MATCH', reason = '';
  if (expected === undefined) { status = 'REVIEW'; reason = 'API không có trường này.'; }
  else if (actual === undefined) { status = field.optional ? 'REVIEW' : 'MISMATCH'; reason = 'TP2 thiếu trường.'; }
  else if (masked(actual) || masked(expected)) { status = 'REVIEW'; reason = 'Giá trị đã che, không thể so chính xác.'; }
  else {
    const a = normalized(actual, field.type), b = normalized(expected, field.type);
    if (a === undefined || b === undefined) { status = 'REVIEW'; reason = 'Không chuyển được về kiểu so sánh đã chọn.'; }
    else if (!isDeepStrictEqual(a, b)) { status = 'MISMATCH'; reason = 'Giá trị khác nhau.'; }
  }
  return { field: field.event_path, api_field: field.api_path, actual: actual ?? null, expected: expected ?? null, status, reason };
}

function compareAutomatic(event, summaries, getCall, result, apiId) {
  const stage = affiliateStage(event), base = { ...result, automatic: true, stage };
  const at = Date.parse(event.tp2?.event_at || event.captured_at);
  const eligible = summaries.filter(call => (!apiId || call.evidence_id === apiId) && !isTp2Endpoint(call.url)
    && (call.target_id && event.page?.target_id ? call.target_id === event.page.target_id : Boolean(call.page_url && event.page?.url && call.page_url === event.page.url))
    && Date.parse(call.finished_at || call.captured_at) <= at && at - Date.parse(call.finished_at || call.captured_at) <= 1800000);
  base.candidates = eligible.map(call => ({ evidence_id: call.evidence_id, method: call.method, url: call.url, status: call.status, at: call.finished_at || call.captured_at }));
  if (eligible.length > 200) return { ...base, candidates: base.candidates.slice(-200), status: 'REVIEW', message: 'Có hơn 200 API trong khoảng thời gian này; chưa đủ chắc chắn để kết luận tự động.' };
  const calls = eligible.map(call => getCall(call.evidence_id)).filter(call => call && (apiId || sharesIdentity(event, call) || stage === 'purchase' && isMyOrder(call)));
  base.candidates = base.candidates.filter(summary => calls.some(call => call.evidence_id === summary.evidence_id));
  const complete = calls.filter(call => call.ok && !call.incomplete && call.response?.body?.json && !call.response.body.omitted && !call.response.body.truncated);
  if (!complete.length) return { ...base, status: calls.length ? 'REVIEW' : stage === 'click' ? 'CLICK' : 'NO_API', message: calls.length ? 'API chưa có Response JSON thành công, đầy đủ để đối chiếu.' : stage === 'click' ? 'Đã ghi nhận click affiliate. Chưa có API cùng mã để so sánh; click không bắt buộc có đơn hàng.' : 'Chưa tìm thấy API liên quan trước event này trong cùng tab. Kết quả tự cập nhật khi thu được đủ dữ liệu.' };
  const identity = orderIdentity(event.payload);
  const identified = identity ? complete.filter(call => orderIdentity(call.response.body.json, { orderApi: isMyOrder(call) }) === identity) : [];
  let candidates = identified.length ? identified : complete;
  if (stage === 'purchase' && candidates.some(isMyOrder)) candidates = candidates.filter(isMyOrder);
  // Repeated reads of the same identified record use its latest response before TP2.
  const latest = new Map(), ungrouped = [];
  for (const call of candidates) {
    const order = orderIdentity(call.response.body.json, { orderApi: isMyOrder(call) });
    if (!order && !sharesIdentity(event, call)) { ungrouped.push(call); continue; }
    const key = `${call.method}|${call.url}|${order || ''}`, previous = latest.get(key);
    const time = value => Date.parse(value.finished_at || value.captured_at);
    if (!previous || time(call) > time(previous)) latest.set(key, call);
    else if (time(call) === time(previous) && !isDeepStrictEqual(call.response.body.json, previous.response.body.json)) ungrouped.push(call);
  }
  candidates = [...latest.values(), ...ungrouped];
  if (candidates.length > 1 && identified.length) {
    const ranked = candidates.map(call => ({ call, fields: suggestTp2Fields(event, call).fields.filter(field => field.api_path).length })).sort((a, b) => b.fields - a.fields);
    if (ranked[0].fields > ranked[1].fields) candidates = [ranked[0].call];
  }
  if (candidates.length !== 1) return { ...base, status: 'AMBIGUOUS', message: 'Có nhiều API hoặc mã đơn cùng phù hợp; dữ liệu hiện tại chưa xác định được API duy nhất để so sánh tự động.' };
  const call = candidates[0], suggestion = suggestTp2Fields(event, call);
  base.api = apiCallSummary(call);
  base.comparisons = suggestion.fields.map(field => field.api_path ? compareField(event, call.response.body.json, field) : {
    field: field.event_path, api_field: '', actual: valueAt(event.payload, field.event_path) ?? null, expected: null, status: 'REVIEW', reason: field.reason,
  });
  base.status = base.comparisons.some(field => field.status === 'MISMATCH') ? 'MISMATCH'
    : !base.comparisons.length || suggestion.limited || base.comparisons.some(field => field.status === 'REVIEW') ? 'REVIEW' : 'MATCH';
  base.message = suggestion.limited ? 'Dữ liệu lớn: chỉ gợi ý tối đa 100 trường TP2 và 500 trường API. Chưa thể kết luận toàn bộ.' : 'Tự ghép theo tên trường và mã sản phẩm. Trường chưa rõ được đánh dấu để kiểm tra; kết quả chỉ áp dụng cho các trường hiển thị.';
  return redactApiData(base);
}

export function compareTp2Event(event, summaries, getCall, mappings, { apiId, mappingId, automatic = false } = {}) {
  const mapping = automatic ? null : mappingId ? mappings.find(item => item.id === mappingId) : mappings.find(item => item.event_name === event.event_name) ?? mappings.find(item => item.event_name === '*');
  const result = { evidence_id: event.evidence_id, event_name: event.event_name, captured_at: event.captured_at, page: event.page,
    schema: event.tp2?.schema, decode_status: event.tp2?.decode_status, status: 'NO_MAPPING', comparisons: [], candidates: [], mapping_id: mapping?.id };
  if (event.tp2?.decode_status !== 'DECODED') return { ...result, status: 'DECODE_ERROR', message: event.tp2?.error };
  if (!mapping) return compareAutomatic(event, summaries, getCall, result, apiId);
  const at = Date.parse(event.tp2?.event_at || event.captured_at), pattern = new RegExp(mapping.api_pattern, 'i');
  const identity = mapping.event_id_path ? valueAt(event.payload, mapping.event_id_path) : undefined;
  if (mapping.event_id_path && (identity == null || masked(identity))) return { ...result, status: 'REVIEW', message: 'TP2 thiếu mã định danh hoặc mã đã được che.' };
  const eligible = summaries.filter(call => (!apiId || call.evidence_id === apiId) && !isTp2Endpoint(call.url) && pattern.test(call.host + call.path)
    && (call.target_id && event.page?.target_id ? call.target_id === event.page.target_id : Boolean(call.page_url && event.page?.url && call.page_url === event.page.url))
    && Date.parse(call.finished_at || call.captured_at) <= at && at - Date.parse(call.finished_at || call.captured_at) <= mapping.window_ms);
  result.candidates = eligible.map(call => ({ evidence_id: call.evidence_id, method: call.method, url: call.url, status: call.status, at: call.finished_at || call.captured_at }));
  const candidates = []; let unavailable = false;
  for (const summary of eligible) {
    const call = getCall(summary.evidence_id);
    const body = call?.[mapping.api_side]?.body;
    if (!call || !body || body.omitted || body.truncated || body.json === undefined || !apiId && (!call.ok || call.incomplete)) { unavailable = true; continue; }
    const value = valueAt(body.json, mapping.record_path), records = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
    const matched = records.filter(record => !mapping.event_id_path || valueAt(record, mapping.api_id_path) != null && !masked(valueAt(record, mapping.api_id_path)) && String(valueAt(record, mapping.api_id_path)) === String(identity));
    for (const record of matched) candidates.push({ call, record, at: Date.parse(call.finished_at || call.captured_at) });
  }
  if (!candidates.length) return { ...result, status: unavailable ? 'REVIEW' : 'NO_API', message: unavailable ? 'API chưa có body JSON đầy đủ để đối chiếu.' : 'Chưa tìm thấy API phù hợp mã định danh, tab và thời điểm event.' };
  candidates.sort((a, b) => b.at - a.at);
  if (candidates.length > 1 && (!mapping.event_id_path || candidates[0].at === candidates[1].at)) return { ...result, status: 'AMBIGUOUS', message: 'Có nhiều bản ghi phù hợp. Chọn API hoặc bổ sung mã định danh.' };
  const chosen = candidates[0];
  result.api = apiCallSummary(chosen.call);
  const indexed = field => /(?:\.|\[)\d+(?:\.|\])/.test(field);
  const template = field => field.replace(/\[(\d+)\]/g, '.$1').replace(/\.\d+(?=\.|$)/g, '.*');
  const suggestions = mapping.dynamic_items ? suggestTp2Fields(event, chosen.call, { side: mapping.api_side, recordPath: mapping.record_path }).fields : [];
  const seen = new Set();
  result.comparisons = mapping.fields.flatMap(field => {
    if (!mapping.dynamic_items || !indexed(field.event_path) && !indexed(field.api_path)) return [compareField(event, chosen.record, field)];
    const key = `${template(field.event_path)}|${template(field.api_path)}`;
    if (seen.has(key)) return []; seen.add(key);
    const matches = suggestions.filter(item => template(item.event_path) === template(field.event_path));
    if (!matches.length) return [{ field: field.event_path, api_field: '', actual: null, expected: null, status: 'REVIEW', reason: 'Không tìm thấy phần tử TP2 để ghép theo mã sản phẩm.' }];
    return matches.map(item => item.api_path && template(item.api_path) === template(field.api_path) ? compareField(event, chosen.record, { ...item, type: field.type })
      : { field: item.event_path, api_field: '', actual: valueAt(event.payload, item.event_path) ?? null, expected: null, status: 'REVIEW', reason: 'Chưa ghép được phần tử API theo mã sản phẩm; không dùng vị trí mảng cũ.' });
  });
  result.status = result.comparisons.some(field => field.status === 'MISMATCH') ? 'MISMATCH' : result.comparisons.some(field => field.status === 'REVIEW') ? 'REVIEW' : 'MATCH';
  return redactApiData(result);
}

export function tp2Events(events) { return events.filter(event => event.source === 'TP2' && (!event.network?.phase || event.network.phase === 'request')); }
