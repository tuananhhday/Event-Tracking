// API Request/Response log: the calls the website makes to its own backend (api.uat.vinpearlota.com at UAT,
// api.vinpearlota.com at PROD), kept whole so the parameters of a tracking event can be checked against
// (and completed from) the data the page actually had: the Bookable ancillaries of an addon, the discount
// returned when a promotion code is applied, the items of the cart.
//
// Unlike api-prices.mjs, which keeps only money fields, a record holds the request (method, URL, body)
// and the response (status, body), including 4xx/5xx and network failures. Before anything is written:
// - headers are reduced to an allowlist (no Authorization, Cookie, Set-Cookie or custom tokens);
// - privacy.mjs masks tokens, emails, phone numbers and names; personal keys of booking APIs
//   (passport, date of birth, guest/contact names…) are masked here as well;
// - login, token, OTP and password endpoints keep their status but never their bodies.
import { redact, redactUrl } from './privacy.mjs';

// Matched against hostname + pathname, like the tracking endpoint allowlist.
export const DEFAULT_API_LOG_PATTERNS = ['(?:^|\\.)api\\.uat\\.vinpearlota\\.com(?:/|$)', '(?:^|\\.)api\\.vinpearlota\\.com(?:/|$)'];
export const API_LOG_LIMITS = { calls: 3000, bodyChars: 1_000_000, sessionBytes: 300 * 1024 * 1024 };

const MASK = '[REDACTED]';
// Account and credential endpoints: the call is listed, its bodies are not kept.
const CREDENTIAL_PATH = /(?:^|[/._-])(?:auth|login|logout|signin|sign-in|signup|sign-up|oauth|token|refresh-token|otp|password|passwd|verify-otp)(?:$|[/._-])/i;
// Headers worth reading next to a payload (format, language, currency, channel, request id).
const HEADER_ALLOW = /^(?:content-type|content-length|content-encoding|accept|accept-language|origin|referer|cache-control|date|x-(?:request|correlation|trace)-id|x-(?:language|lang|locale|currency|channel|platform|client-channel|app-version|device-type)|language|locale|currency|channel|platform)$/i;
// Personal data of guests, contacts and passengers that privacy.mjs does not name.
const PERSONAL_KEY = /^(?:sur[-_]?name|given[-_]?name|middle[-_]?name|(?:guest|customer|contact|passenger|holder|booker|traveller|traveler|buyer|receiver|recipient)[-_]?(?:name|full[-_]?name|first[-_]?name|last[-_]?name)|birth[-_]?(?:date|day)|date[-_]?of[-_]?birth|dob|passport(?:[-_]?(?:no|number))?|id[-_]?card(?:[-_]?number)?|identity[-_]?(?:number|card)|national[-_]?id|cccd|cmnd|tax[-_]?code|otp|pin(?:[-_]?code)?)$/i;

const compile = patterns => patterns.map(pattern => new RegExp(pattern, 'i'));

/** Validated API log patterns; throws on an invalid regex so the QC sees it before the session opens. */
export function apiLogPatterns(value) {
  const patterns = Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : [];
  if (patterns.length > 20) throw new Error('Tối đa 20 mẫu host API.');
  for (const pattern of patterns) {
    if (pattern.length > 300) throw new Error('Mẫu host API quá dài.');
    try { new RegExp(pattern, 'i'); } catch { throw new Error(`Mẫu host API không hợp lệ: ${pattern}`); }
  }
  return patterns.length ? patterns : [...DEFAULT_API_LOG_PATTERNS];
}

/** True for a request to one of the logged API hosts (hostname + pathname, never the query). */
export function matchesApiLog(url, patterns = DEFAULT_API_LOG_PATTERNS) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    const subject = parsed.hostname + parsed.pathname;
    return compile(patterns).some(pattern => pattern.test(subject));
  } catch { return false; }
}

export const isCredentialApi = url => { try { return CREDENTIAL_PATH.test(new URL(url).pathname); } catch { return false; } };

export function allowedHeaders(headers = {}) {
  const kept = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (!HEADER_ALLOW.test(name) || value === '' || value === undefined || value === null) continue;
    kept[name.toLowerCase()] = /^(?:origin|referer)$/i.test(name) ? redactUrl(String(value)) : String(value).slice(0, 300);
  }
  return kept;
}

function maskPersonal(value, depth = 0) {
  if (depth > 40 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => maskPersonal(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, PERSONAL_KEY.test(key) ? MASK : maskPersonal(item, depth + 1)]));
}

/**
 * A request or response body as it is stored: JSON parsed (so masking works by key), other text as text,
 * cut at `limit` characters with `truncated: true`. Binary bodies are described, not stored.
 */
export function storedBody(text, { mimeType = '', limit = API_LOG_LIMITS.bodyChars, omitted } = {}) {
  if (omitted) return { omitted };
  if (text === undefined || text === null || text === '') return null;
  const raw = String(text);
  const size = Buffer.byteLength(raw, 'utf8');
  if (mimeType && !/json|text|xml|javascript|x-www-form-urlencoded|graphql/i.test(mimeType)) return { omitted: 'binary', mime_type: mimeType, size };
  if (raw.length > limit) return { truncated: true, size, text: redact(raw.slice(0, limit)) };
  try { return { size, json: maskPersonal(redact(JSON.parse(raw))) }; }
  catch {
    if (/x-www-form-urlencoded/i.test(mimeType) || (/^[^\s{[<]+=[^\s]*(?:&[^\s=]+=[^\s]*)*$/.test(raw) && raw.includes('='))) {
      const form = {};
      for (const [key, item] of new URLSearchParams(raw)) form[key] = item;
      return { size, form: maskPersonal(redact(form)) };
    }
    return { size, text: redact(raw) };
  }
}

/** One logged call, ready to persist (already masked). */
export function apiCallRecord({ request = {}, response, error, incomplete, page = {}, resourceType, startedAt, finishedAt, requestBody, responseBody }) {
  const credential = isCredentialApi(request.url);
  let parsed = null;
  try { parsed = new URL(request.url); } catch { /* kept as the raw, redacted URL */ }
  const query = parsed ? Object.fromEntries([...parsed.searchParams].map(([key, value]) => [key, value])) : {};
  const requestType = request.headers && Object.entries(request.headers).find(([name]) => /^content-type$/i.test(name))?.[1];
  const record = {
    kind: 'api_call',
    captured_at: startedAt,
    ...(finishedAt ? { finished_at: finishedAt, duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) } : {}),
    resource_type: resourceType || null,
    method: String(request.method || 'GET').toUpperCase(),
    url: redactUrl(String(request.url || '')),
    host: parsed?.hostname ?? '',
    path: parsed?.pathname ?? '',
    query: maskPersonal(redact(query)),
    page: { url: redactUrl(page.url || ''), frame_id: page.frame_id, target_id: page.target_id },
    request: { headers: allowedHeaders(request.headers), body: storedBody(requestBody, { mimeType: requestType, omitted: credential && requestBody ? 'credential_endpoint' : undefined }) },
    response: response ? { status: response.status, status_text: response.statusText || '', mime_type: response.mimeType || '', headers: allowedHeaders(response.headers),
      body: storedBody(responseBody, { mimeType: response.mimeType, omitted: credential && responseBody ? 'credential_endpoint' : undefined }) } : null,
    ...(error ? { error: String(error).slice(0, 300) } : {}),
    // response_not_finished: the page had the response but never read it to the end; no_response_before_stop: capture stopped first.
    ...(incomplete ? { incomplete } : {}),
    ...(credential ? { credential_endpoint: true } : {}),
  };
  record.ok = !error && Boolean(response) && response.status < 400 && incomplete !== 'no_response_before_stop';
  return record;
}

/** What the API list shows for a call; the full record is read from api-calls.jsonl on demand. */
export function apiCallSummary(record) {
  const size = body => body?.size ?? 0;
  return { evidence_id: record.evidence_id, captured_at: record.captured_at, duration_ms: record.duration_ms ?? null, method: record.method, host: record.host, path: record.path,
    url: record.url, status: record.response?.status ?? null, ok: Boolean(record.ok), error: record.error ?? null, incomplete: record.incomplete ?? null, request_size: size(record.request?.body), response_size: size(record.response?.body),
    step_id: record.step_id ?? null, test_case_id: record.test_case_id ?? null, page_url: record.page?.url ?? '' };
}

/** A body for a spreadsheet cell or a quick look: JSON text, form, text or the reason it is absent. */
export function bodyText(body) {
  if (!body) return '';
  if (body.omitted) return `[${body.omitted === 'credential_endpoint' ? 'Không lưu: API đăng nhập / tài khoản' : body.omitted === 'binary' ? `Không lưu: dữ liệu nhị phân ${body.mime_type ?? ''}` : body.omitted === 'session_limit' ? 'Không lưu: phiên đã đạt giới hạn dung lượng' : body.omitted}]`;
  const text = body.json !== undefined ? JSON.stringify(body.json) : body.form ? new URLSearchParams(body.form).toString() : body.text ?? '';
  return body.truncated ? `${text}\n[Đã cắt: body gốc ${body.size} byte]` : text;
}
