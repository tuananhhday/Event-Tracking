// The QA report as QC writes it: one row per expected event of the flows tested (and per event sent
// outside the specification) with the event the specification expects, the event actually sent and a
// comment on what is complete, missing or wrong. The AI version has the comment written by AI from the
// tool's verdicts; the tool's own comment stays for the normal version and for rows AI did not answer.
import { specCoverage, sessionRows, trackedView, flowHint, specificFlow, APP_ONLY_FIELD } from '../core/catalog.mjs';
import { linkDeliveries } from '../core/delivery.mjs';
import { activityEntries } from '../core/activity.mjs';
import { priceChecks } from '../core/api-prices.mjs';
import { redact } from '../core/privacy.mjs';
import { sensitivePath } from '../spec/sanitize.mjs';
import { isGa4Transport } from '../core/ga4-parameters.mjs';

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

function toolComment(row) {
  const missing = row.issues.filter(issue => ['MISSING_FIELD', 'NULL_FIELD'].includes(issue.code)).map(issue => issue.path);
  const wrong = row.issues.filter(issue => ['VALUE_MISMATCH', 'WRONG_TYPE', 'DYNAMIC_VALUE_MISMATCH'].includes(issue.code)).map(issue => `${issue.path} (mong đợi ${brief(issue.expected)}, thực tế ${brief(issue.actual)})`);
  const unforwarded = row.issues.filter(issue => issue.code === 'NOT_FORWARDED').map(issue => issue.path);
  const review = [...new Set(row.issues.filter(issue => REVIEW_TEXT[issue.code]).map(issue => REVIEW_TEXT[issue.code]))];
  const parts = [];
  if (row.status === 'MATCH') parts.push(`Đủ các trường đặc tả yêu cầu, giá trị khớp; đã gửi ${row.seen} lần.`);
  if (missing.length) parts.push(`Thiếu: ${missing.join(', ')}.`);
  if (wrong.length) parts.push(`Sai: ${wrong.join('; ')}.`);
  if (unforwarded.length) parts.push(`Website có push nhưng Google không nhận: ${unforwarded.join(', ')} (cấu hình tag GA4 trong GTM).`);
  if (review.length) parts.push(`Cần xem: ${review.join('; ')}.`);
  if (row.status === 'NOT_SENT') parts.push(`Website push ${row.not_sent} lần nhưng không có request gửi lên ${vendorOf(row.source)}: kiểm tra tag/trigger GTM hoặc Insider.`);
  if (row.status === 'PENDING') parts.push(`Website vừa push, đang chờ gửi lên ${vendorOf(row.source)}.`);
  if (row.status === 'NOT_SEEN') parts.push('Chưa thấy event: chưa thao tác tới bước này hoặc website không bắn.');
  if (row.status === 'UNCHECKED') parts.push(`${vendorOf(row.source)} đã nhận event này nhưng chưa so được từng trường: mẫu đặc tả là dữ liệu website push vào ${row.source === 'GA4' ? 'dataLayer' : 'InsiderQueue'}, còn phiên chỉ thấy request gửi lên server. Mở phiên có đọc dataLayer / InsiderQueue để so đủ.`);
  if (row.status === 'OUTSIDE') parts.push(`Gửi lên ${vendorOf(row.source)} ${row.seen} lần nhưng file đặc tả không có event này.`);
  if (row.status === 'SENT') parts.push(`Đã gửi lên ${Object.entries(row.counts).map(([source, count]) => `${vendorOf(source)} ${count} lần`).join(', ')}; chưa có file đặc tả để so.`);
  for (const check of row.price_mismatches) parts.push(`Giá lệch API: ${check.field} gửi ${money(check.sent)}, API ${money(check.api)}.`);
  return parts.join(' ');
}

/**
 * Rows of the report: the specification rows of the flows tested (sessionRows), each with its sample
 * and the event it was judged on (the failing one if any), then the events sent outside the
 * specification; without a specification, each event sent to Google/Insider at its last occurrence.
 */
export function eventReportRows({ cases = [], events = [], api = [], links = linkDeliveries(events), now = Date.now() } = {}) {
  const byId = new Map(events.map(event => [event.evidence_id, event]));
  const caseById = new Map(cases.map(testCase => [testCase.id, testCase]));
  // A price check belongs to an event-list row (push + hit): reach it from either evidence id.
  const activity = activityEntries(events, { links, now });
  const rowOf = new Map(activity.flatMap(row => row.evidence_ids.map(id => [id, row.evidence_id])));
  const priced = new Map();
  for (const check of priceChecks(activity, api).checks) if (check.status === 'MISMATCH') priced.set(check.evidence_id, [...priced.get(check.evidence_id) ?? [], { field: check.field, sent: check.sent, api: check.api?.value }]);
  const pricesOf = id => priced.get(rowOf.get(id)) ?? [];
  // Every event each platform received, by name (oldest first), to fill the GA4 / Insider columns.
  const received = new Map();
  for (const row of activity) if (row.delivery === 'sent' && row.event_kind === 'business') received.set(`${row.source}|${row.event_name}`, [...received.get(`${row.source}|${row.event_name}`) ?? [], row.sent_by ?? row.evidence_id]);
  const latest = key => received.get(key)?.at(-1);
  const viewOf = (id, sample) => {
    const event = byId.get(id);
    return event ? pretty(orderLike(event.layer === 'TRACKING_REQUEST' && event.source === 'GA4' ? ga4View(event.payload ?? {}, sample) : trackedView(event), sample)) : '';
  };
  // What GA4 and Insider received for the event: only the platform the expected payload is written for,
  // both when the row has no expected payload. "Chưa thấy event" goes where the event was expected.
  const actualColumns = ({ source, event, evidence, status, sample, platform }) => {
    const actual = { GA4: '', INSIDER: '' };
    for (const vendor of platform ? [platform] : ['GA4', 'INSIDER']) {
      const id = vendor === source ? evidence : latest(`${vendor}|${event}`);
      if (id) actual[vendor] = `${vendor === source && status === 'NOT_SENT' ? `(Website push nhưng không gửi lên ${vendorOf(vendor)})\n` : ''}${viewOf(id, sample)}`;
    }
    if (!actual.GA4 && !actual.INSIDER) actual[(platform ?? source) === 'GA4' ? 'GA4' : 'INSIDER'] = 'Chưa thấy event';
    return { actual_ga4: actual.GA4, actual_insider: actual.INSIDER };
  };
  const rows = [];
  const coverage = cases.length ? specCoverage(cases, events, new Map(), { links, now }) : null;
  if (coverage) {
    const platformOf = row => payloadPlatform(caseById.get(row.case_id)?.sample, caseById.get(row.case_id)?.sample_text);
    // A row written as an InsiderQueue push matches no hit of a session that saw requests only. What Insider
    // received for it is the last hit of its name on a page of its flow (any page for a row of every flow).
    const unchecked = new Map(coverage.rows.map(row => {
      if (row.status !== 'NOT_SEEN' || row.layer !== 'JS_QUEUE' || String(row.source).toUpperCase() !== 'INSIDER') return [row.case_id, null];
      const ids = [...received.get(`INSIDER|${row.event_name}`) ?? []].reverse();
      return [row.case_id, ids.find(id => flowHint(row.flow, byId.get(id)) > 0) ?? (specificFlow(row.flow) ? null : ids[0]) ?? null];
    }));
    const shown = new Set(coverage.rows.filter(row => unchecked.get(row.case_id)).map(row => `INSIDER|${row.event_name}`));
    for (const row of sessionRows(coverage, coverage.rows.filter(row => unchecked.get(row.case_id)).map(row => row.flow))) {
      const testCase = caseById.get(row.case_id), evidence = row.last_fail_evidence_id ?? row.last_evidence_id;
      const fields = Object.keys(testCase?.rules?.[0]?.fields ?? {}).filter(path => !(row.capture_platform === 'APP_SDK' && APP_ONLY_FIELD.test(path)));
      // An issue on a sensitive field (email, token…) keeps its field name only.
      const issues = row.issues.map(issue => sensitivePath(issue.path) ? { ...issue, expected: '[REDACTED]', actual: '[REDACTED]' } : issue);
      const platform = platformOf(row);
      const hit = unchecked.get(row.case_id), shownEvidence = evidence ?? hit;
      rows.push({ key: row.case_id, source: row.source, platforms: [platform ?? row.source], flow: row.flow, event_name: row.event_name, status: hit ? 'UNCHECKED' : row.status, issues, seen: row.seen, not_sent: row.not_sent, expected_fields: fields,
        expected: pretty(testCase?.sample ?? testCase?.sample_text) || '(Đặc tả không có mẫu event)',
        ...actualColumns({ source: row.source, event: row.event_name, evidence: shownEvidence, status: row.status, sample: testCase?.sample, platform }),
        evidence_id: shownEvidence ?? '', price_mismatches: shownEvidence ? pricesOf(shownEvidence) : [] });
    }
    // An event already shown on a specification row of its name is not "outside the specification".
    for (const item of coverage.unmatched) if (!shown.has(`${item.source}|${item.event_name}`)) rows.push({ key: `outside|${item.source}|${item.event_name}`, source: item.source, platforms: [item.source], flow: '', event_name: item.event_name, status: 'OUTSIDE', issues: [], seen: item.count, not_sent: 0,
      expected_fields: [], expected: '(Không có trong file đặc tả)', ...actualColumns({ source: item.source, event: item.event_name, evidence: item.last_evidence_id, status: 'OUTSIDE' }),
      evidence_id: item.last_evidence_id, price_mismatches: pricesOf(item.last_evidence_id) });
  } else {
    // No specification: one row per event name, with what GA4 and what Insider received for it.
    const sent = new Map();
    for (const row of activity) {
      if (row.delivery !== 'sent' || row.event_kind !== 'business' || !['GA4', 'INSIDER'].includes(row.source)) continue;
      const counts = sent.get(row.event_name) ?? new Map();
      counts.set(row.source, (counts.get(row.source) ?? 0) + 1); sent.set(row.event_name, counts);
    }
    for (const [event, counts] of sent) {
      const source = counts.has('GA4') ? 'GA4' : 'INSIDER', evidence = latest(`${source}|${event}`);
      rows.push({ key: `sent|${event}`, source, platforms: [...counts.keys()], counts: Object.fromEntries(counts), flow: '', event_name: event, status: 'SENT', issues: [], seen: [...counts.values()].reduce((sum, count) => sum + count, 0), not_sent: 0,
        expected_fields: [], expected: '(Chưa nhập file đặc tả)', ...actualColumns({ source, event, evidence, status: 'SENT' }),
        evidence_id: evidence, price_mismatches: [...counts.keys()].flatMap(vendor => pricesOf(latest(`${vendor}|${event}`))) });
    }
  }
  return rows.map((row, index) => ({ ...row, stt: index + 1, id: `R${index + 1}`, platform: row.platforms.map(source => PLATFORM[String(source).toUpperCase()] ?? source).join(', '), comment: toolComment(row) }));
}
