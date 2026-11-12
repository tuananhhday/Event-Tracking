/** An event as its vendor received it, written like a specification sample (fields in its order). */
export function comparedView(event, sample) {
  return orderLike(event.layer === 'TRACKING_REQUEST' && event.source === 'GA4' ? ga4View(event.payload ?? {}, sample) : trackedView(event), sample);
}
/** The record of an event compared with a sample: the website's push for a sample written as an InsiderQueue push, otherwise what the vendor received. */
export function comparedRecord(sample, { event, push, hit }) {
  const pushShaped = sample && typeof sample === 'object' && !sample.default_parameters && !sample.custom_parameters && ('type' in sample || 'value' in sample);
  return String(event.source).toUpperCase() === 'INSIDER' && push && pushShaped ? push : hit ?? event;
}

// The QA report as QC writes it: one row per event fired (every occurrence, in time order) and per
// expected event of the flows tested that never fired, with the event the specification expects, the
// event actually sent and a comment on what is complete, missing or wrong. The AI version has the comment written by AI from the
// tool's verdicts; the tool's own comment stays for the normal version and for rows AI did not answer.
import { specCoverage, sessionRows, trackedView, flowHint, specificFlow, APP_ONLY_FIELD, matchTracked, indexCases } from '../core/catalog.mjs';
import { linkDeliveries } from '../core/delivery.mjs';
import { activityEntries } from '../core/activity.mjs';
import { priceChecks } from '../core/api-prices.mjs';
import { redact } from '../core/privacy.mjs';
import { sensitivePath } from '../spec/sanitize.mjs';
import { isGa4Transport } from '../core/ga4-parameters.mjs';
import { payloadDiff, diffSentences } from '../core/payload-diff.mjs';

export const REPORT_LABEL = { MATCH: 'Đủ', MISMATCH: 'Lệch', REVIEW: 'Cần xem', NOT_SENT: 'Không gửi lên server', PENDING: 'Đang chờ gửi', NOT_SEEN: 'Chưa thấy', UNCHECKED: 'Đã gửi, chưa so được', OUTSIDE: 'Ngoài đặc tả', SENT: 'Đã gửi' };
const PLATFORM = { GA4: 'GA4', INSIDER: 'Insider' };
const REVIEW_TEXT = { NO_EXPECTED_FIELDS: 'đặc tả chưa có chi tiết payload', SPEC_INCOMPLETE: 'mẫu trong đặc tả chưa đầy đủ', SPEC_PLATFORM_MISMATCH: 'đặc tả viết cho app, event bắn từ web',
  CAPTURE_INCOMPLETE: 'payload thu chưa đầy đủ', UNEXPECTED_FIELD: 'có trường không được phép', AMBIGUOUS_SPEC: 'nhiều dòng đặc tả cùng phù hợp' };
const vendorOf = source => source === 'GA4' ? 'Google' : 'Insider';
const brief = value => { const text = typeof value === 'string' ? value : JSON.stringify(value); return text === undefined ? '—' : text.length > 60 ? `${text.slice(0, 60)}…` : text; };
const money = value => typeof value === 'number' ? value.toLocaleString('vi-VN') : String(value ?? '—');
// Which platform an expected payload is written for: Insider's queue, record or request shape, otherwise a
// dataLayer (GA4) event; null when the specification row has no usable sample.
function payloadPlatform(sample, text = '') {
  if (/InsiderQueue|Insider\.|insider_object/.test(text ?? '')) return 'INSIDER';
  if (/dataLayer|gtag\(/.test(text ?? '')) return 'GA4';
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return null;
  if (sample.default_parameters || sample.custom_parameters || sample.event_params || Array.isArray(sample.events) || (typeof sample.type === 'string' && 'value' in sample)) return 'INSIDER';
  return typeof sample.event === 'string' || sample.ecommerce ? 'GA4' : null;
}
// What Google received, written as the dataLayer push a specification shows: business parameters only
// (not protocol fields such as v, tid, gtm), under `ecommerce` where the expected payload puts them.
function ga4View(payload, expected) {
  const inEcommerce = new Set(expected?.ecommerce && typeof expected.ecommerce === 'object' ? Object.keys(expected.ecommerce) : []);
  const view = { event: payload.event }, ecommerce = {};
  for (const [wire, value] of Object.entries(payload)) {
    const key = wire === 'uid' && payload.user_id === undefined ? 'user_id' : wire;
    if (!['event', 'ecommerce', 'cu'].includes(key) && !isGa4Transport(key)) (inEcommerce.has(key) ? ecommerce : view)[key] = value;
  }
  if (payload.cu !== undefined) (inEcommerce.has('currency') || (!Object.hasOwn(expected ?? {}, 'currency') && payload.ecommerce?.items) ? ecommerce : view).currency = payload.cu;
  if (Array.isArray(payload.ecommerce?.items)) ecommerce.items = payload.ecommerce.items;
  if (Object.keys(ecommerce).length) view.ecommerce = ecommerce;
  return view;
}
// The actual event with its fields in the order of the expected payload, so the two read side by side.
function orderLike(actual, expected) {
  if (Array.isArray(actual)) return actual.map(item => orderLike(item, Array.isArray(expected) ? expected[0] : undefined));
  if (!actual || typeof actual !== 'object' || !expected || typeof expected !== 'object' || Array.isArray(expected)) return actual;
  const keys = [...Object.keys(expected).filter(key => Object.hasOwn(actual, key)), ...Object.keys(actual).filter(key => !Object.hasOwn(expected, key))];
  return Object.fromEntries(keys.map(key => [key, orderLike(actual[key], expected[key])]));
}
const pretty = value => value === undefined || value === null || value === '' ? '' : typeof value === 'string' ? value : JSON.stringify(redact(value), null, 2);

// When the event happened, as QC reads it (Vietnam time).
const VN_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const timeText = value => {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  const part = Object.fromEntries(VN_TIME.formatToParts(new Date(value)).map(item => [item.type, item.value]));
  return `${part.day}/${part.month}/${part.year} ${part.hour}:${part.minute}:${part.second}`;
};
const STATUS_OF = { PASS: 'MATCH', FAIL: 'MISMATCH', REVIEW: 'REVIEW', NOT_SENT: 'NOT_SENT', PENDING: 'PENDING' };

function toolComment(row) {
  const missing = row.issues.filter(issue => ['MISSING_FIELD', 'NULL_FIELD'].includes(issue.code)).map(issue => issue.path);
  const wrong = row.issues.filter(issue => ['VALUE_MISMATCH', 'WRONG_TYPE', 'DYNAMIC_VALUE_MISMATCH'].includes(issue.code)).map(issue => `${issue.path} (mong đợi ${brief(issue.expected)}, thực tế ${brief(issue.actual)})`);
  const unforwarded = row.issues.filter(issue => issue.code === 'NOT_FORWARDED').map(issue => issue.path);
  const review = [...new Set(row.issues.filter(issue => REVIEW_TEXT[issue.code]).map(issue => REVIEW_TEXT[issue.code]))];
  const vendor = vendorOf(row.source), parts = [];
  if (row.status === 'MATCH') parts.push('Đủ các trường đặc tả yêu cầu, giá trị khớp.');
  if (row.differences) parts.push(...row.differences);
  else {
    if (missing.length) parts.push(`Event thực tế thiếu (đặc tả có): ${missing.join(', ')}.`);
    if (wrong.length) parts.push(`Sai: ${wrong.join('; ')}.`);
  }
  if (unforwarded.length) parts.push(`Website có push nhưng Google không nhận: ${unforwarded.join(', ')} (cấu hình tag GA4 trong GTM).`);
  if (review.length) parts.push(`Cần xem: ${review.join('; ')}.`);
  if (row.status === 'NOT_SENT') parts.push(`Website push nhưng không có request gửi lên ${vendor}: kiểm tra tag/trigger GTM hoặc Insider.`);
  if (row.status === 'PENDING') parts.push(`Website vừa push, đang chờ gửi lên ${vendor}.`);
  if (row.status === 'NOT_SEEN') parts.push('Chưa thấy event: chưa thao tác tới bước này hoặc website không bắn.');
  if (row.status === 'UNCHECKED') parts.push(`${vendor} đã nhận event này nhưng chưa so được từng trường: mẫu đặc tả là dữ liệu website push vào ${row.source === 'GA4' ? 'dataLayer' : 'InsiderQueue'}, còn phiên chỉ thấy request gửi lên server. Mở phiên có đọc dataLayer / InsiderQueue để so đủ.`);
  if (row.status === 'OUTSIDE') parts.push(`Gửi lên ${vendor} nhưng file đặc tả không có event này.`);
  if (row.status === 'SENT') parts.push(row.spec_loaded ? `Đã gửi lên ${vendor}; file đặc tả không gồm event ${vendor}.` : `Đã gửi lên ${vendor}; chưa có file đặc tả để so.`);
  if (row.repeat) parts.push(`Gửi lặp lại sau ${(row.repeat.after_ms / 1000).toFixed(1)} giây (cùng event, cùng trang).`);
  for (const param of row.testlab_failed ?? []) parts.push(`Insider Test Lab báo thất bại: ${param.field}${param.expected_type ? ` (Insider mong đợi ${param.expected_type}, app gửi ${param.observed_type ?? '?'})` : ''}.`);
  for (const check of row.price_mismatches) parts.push(`Giá lệch API: ${check.field} gửi ${money(check.sent)}, API ${money(check.api)}.`);
  return parts.join(' ');
}

/**
 * Rows of the report: every event the session saw fired, in time order, each judged against the
 * specification row it implements (its expected sample beside what the vendor received), then the
 * specification rows of the flows tested that nothing fired for. A push and the vendor hit that sent it
 * are one event; an app event read from Insider's Test Lab is one event per receipt.
 */
export function eventReportRows({ cases = [], events = [], api = [], links = linkDeliveries(events), now = Date.now(), entries, priced: priceAnalysis, coverage: suppliedCoverage } = {}) {
  const byId = new Map(events.map(event => [event.evidence_id, event]));
  const caseById = new Map(cases.map(testCase => [testCase.id, testCase]));
  // A price check belongs to an event-list row (push + hit): reach it from either evidence id.
  const activity = entries ?? activityEntries(events, { links, now });
  const rowOf = new Map();
  for (const row of activity) for (const id of row.evidence_ids) rowOf.set(id, row.evidence_id);
  const priced = new Map();
  for (const check of (priceAnalysis ?? priceChecks(activity, api)).checks) if (check.status === 'MISMATCH') {
    const mismatches = priced.get(check.evidence_id) ?? [];
    mismatches.push({ field: check.field, sent: check.sent, api: check.api?.value });
    priced.set(check.evidence_id, mismatches);
  }
  const pricesOf = id => priced.get(rowOf.get(id)) ?? [];
  const viewObject = comparedView;
  const viewOf = (id, sample) => { const event = byId.get(id); return event ? pretty(viewObject(event, sample)) : ''; };
  // Which record of an event is compared: what the vendor received, or the website's push when the
  // sample is written as an InsiderQueue push ({type, value}) — the same shape on both sides.
  const shownOf = (entry, sample) => comparedRecord(sample, { event: byId.get(entry.evidence_id), push: entry.evidence_ids.map(id => byId.get(id)).find(item => item?.layer === 'JS_QUEUE'),
    hit: entry.sent_by ? byId.get(entry.sent_by) : null });
  const coverage = suppliedCoverage === undefined ? (cases.length ? specCoverage(cases, events, new Map(), { links, now }) : null) : suppliedCoverage;
  const index = indexCases(cases);
  const specSources = new Set(cases.flatMap(testCase => (testCase.rules ?? []).map(rule => String(rule.source ?? testCase.source).toUpperCase())));
  const platformOf = testCase => payloadPlatform(testCase?.sample, testCase?.sample_text);
  // An issue on a sensitive field (email, token…) keeps its field name only.
  const safeIssues = issues => (issues ?? []).map(issue => sensitivePath(issue.path) ? { ...issue, expected: '[REDACTED]', actual: '[REDACTED]' } : issue);
  const expectedFields = (testCase, event) => Object.keys(testCase?.rules?.[0]?.fields ?? {})
    .filter(path => !(testCase?.capture_platform === 'APP_SDK' && event?.layer !== 'TEST_LAB' && APP_ONLY_FIELD.test(path)));
  const rows = [], answered = new Set(), answeredFlows = [];
  for (const entry of activity) {
    const source = String(entry.source).toUpperCase();
    if (entry.event_kind !== 'business' || !['GA4', 'INSIDER'].includes(source)) continue;
    const event = byId.get(entry.evidence_id); if (!event) continue;
    const match = cases.length ? matchTracked(cases, event, { links, now, index }) : null;
    let testCase = null, status, issues = [];
    if (match && !match.ambiguous) { testCase = caseById.get(match.case_id); status = STATUS_OF[match.verdict] ?? 'REVIEW'; issues = match.issues; }
    else if (match?.ambiguous) { status = 'REVIEW'; issues = match.issues; }
    else if (!cases.length || !specSources.has(source)) status = entry.delivery === 'not_sent' ? 'NOT_SENT' : entry.delivery === 'pending' ? 'PENDING' : 'SENT';
    else {
      // An Insider hit of a session that saw requests only, for a row written as an InsiderQueue push:
      // what Insider received, not yet compared field by field.
      const queued = source === 'INSIDER' && event.layer === 'TRACKING_REQUEST' ? (index.get(`JS_QUEUE|INSIDER|${entry.event_name}`) ?? []) : [];
      const candidate = queued.find(item => flowHint(item.testCase.flow, event) > 0) ?? queued.find(item => !specificFlow(item.testCase.flow));
      if (candidate) { testCase = candidate.testCase; status = 'UNCHECKED'; }
      else status = 'OUTSIDE';
    }
    if (testCase) { answered.add(testCase.id); answeredFlows.push(testCase.flow); }
    const prefix = status === 'NOT_SENT' ? `(Website push nhưng không gửi lên ${vendorOf(source)})\n` : status === 'PENDING' ? `(Website push, đang chờ gửi lên ${vendorOf(source)})\n` : '';
    const shown = shownOf(entry, testCase?.sample) ?? event, evidence = shown.evidence_id;
    const actual = `${prefix}${viewOf(evidence, testCase?.sample)}`;
    // Field by field against the sample (website events; an app event has its define comparison).
    const sample = testCase?.sample;
    const diff = sample && typeof sample === 'object' && event.layer !== 'TEST_LAB' && status !== 'UNCHECKED'
      ? payloadDiff(sample, viewObject(shown, sample), { fields: testCase.rules?.[0]?.fields ?? {}, issues }) : null;
    const failed = (event.testlab?.params ?? []).filter(param => param.status === 'failed')
      .map(param => ({ field: param.field ?? param.key ?? param.name, ...Object.values(param.failed_detail ?? {}).find(detail => detail?.expected_type) }));
    rows.push({ key: `ev|${entry.evidence_id}`, case_id: testCase?.id ?? null, at: entry.sent_at ?? entry.captured_at, source, layer: event.layer,
      platforms: [source], app: event.layer === 'TEST_LAB', flow: testCase?.flow ?? '', event_name: testCase?.rules?.[0]?.event_name ?? entry.event_name,
      status, issues: safeIssues(issues), seen: 1, not_sent: status === 'NOT_SENT' ? 1 : 0, spec_loaded: cases.length > 0, expected_fields: expectedFields(testCase, event),
      expected: testCase ? pretty(testCase.sample ?? testCase.sample_text) || '(Đặc tả không có mẫu event)'
        : !cases.length ? '(Chưa nhập file đặc tả)' : specSources.has(source) ? '(Không có trong file đặc tả)' : `(File đặc tả không gồm event ${vendorOf(source)})`,
      actual_ga4: source === 'GA4' ? actual : '', actual_insider: source === 'INSIDER' ? actual : '',
      evidence_id: evidence, ...(entry.repeat ? { repeat: entry.repeat } : {}), ...(failed.length ? { testlab_failed: failed } : {}),
      ...(diff ? { diff: { expected: diff.rows.map(row => row.expected), actual: diff.rows.map(row => row.actual), prefix }, differences: diffSentences(diff),
        diff_counts: { missing: diff.missing.filter(item => item.required).length, wrong: diff.wrong.length, extra: diff.extra.length, different: diff.different.length } } : {}),
      ...(event.testlab ? { testlab_status: event.testlab.status } : {}), price_mismatches: pricesOf(entry.evidence_id) });
  }
  // Specification rows nothing fired for, of the flows tested (every row when no flow was touched).
  if (coverage) for (const row of sessionRows(coverage, answeredFlows)) {
    if (row.status !== 'NOT_SEEN' || answered.has(row.case_id)) continue;
    const testCase = caseById.get(row.case_id), platform = platformOf(testCase) ?? String(row.source).toUpperCase();
    rows.push({ key: row.case_id, case_id: row.case_id, at: null, source: row.source, layer: row.layer, platforms: [platform], app: false, flow: row.flow,
      event_name: row.event_name, status: 'NOT_SEEN', issues: [], seen: 0, not_sent: 0, spec_loaded: true, expected_fields: expectedFields(testCase),
      expected: pretty(testCase?.sample ?? testCase?.sample_text) || '(Đặc tả không có mẫu event)',
      actual_ga4: platform === 'GA4' ? 'Chưa thấy event' : '', actual_insider: platform === 'GA4' ? '' : 'Chưa thấy event', evidence_id: '', price_mismatches: [] });
  }
  return rows.map((row, index) => ({ ...row, stt: index + 1, id: `R${index + 1}`, at_text: timeText(row.at),
    platform: row.platforms.map(source => PLATFORM[String(source).toUpperCase()] ?? source).join(', ') + (row.app ? ' (app)' : ''), comment: toolComment(row) }));
}
