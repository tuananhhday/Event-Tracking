import { REPORT_LABEL } from './event-report.mjs';
import { TP2_LABELS } from '../core/tp2-compare.mjs';
import { redactApiData } from '../core/api-log.mjs';
import { defineComparison } from '../core/testlab.mjs';

const col = (key, label, width) => ({ key, label, width });
const showBody = body => !body ? null : body.omitted || body.truncated ? body : body.json ?? body.form ?? body.text ?? body;
const displayTime = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) : value;
export function apiSection(calls = []) {
  return { id: 'api', title: 'API của phiên', columns: [col('stt', 'STT', 65), col('at', 'Thời điểm', 175), col('method', 'Method', 90), col('url', 'API', 370),
    col('http', 'HTTP', 80), col('duration', 'Thời gian (ms)', 120), col('result', 'Kết quả', 150), col('error', 'Chi tiết lỗi', 250)],
  rows: redactApiData(calls).map((call, index) => ({ stt: index + 1, id: call.evidence_id, at: displayTime(call.captured_at), method: call.method, url: call.url,
    http: call.response?.status ?? '', duration: call.duration_ms ?? '', status: call.ok ? 'MATCH' : call.incomplete ? 'REVIEW' : 'MISMATCH',
    result: call.ok ? 'Thành công' : call.incomplete ? 'Chưa hoàn tất' : 'Có lỗi', error: call.error || call.incomplete || '',
    details: { 'Thông tin API': { id: call.evidence_id, method: call.method, url: call.url, query: call.query, at: call.captured_at, finished_at: call.finished_at,
      duration_ms: call.duration_ms, page: call.page, step_id: call.step_id, test_case_id: call.test_case_id, error: call.error, incomplete: call.incomplete },
    'Request headers': call.request?.headers, 'Request body': showBody(call.request?.body), 'Response headers': call.response?.headers,
    'Response body': showBody(call.response?.body) } })) };
}
export function tp2Section(rows = [], events = []) {
  const byId = new Map(events.map(event => [event.evidence_id, event]));
  return { id: 'tp2', title: 'TP2 ↔ API', columns: [col('stt', 'STT', 65), col('at', 'Thời điểm', 170), col('event_name', 'Event TP2', 230),
    col('schema', 'Schema', 300), col('api', 'API đối chiếu', 330), col('result', 'Kết quả', 180), col('differences', 'Chi tiết', 350)],
  rows: rows.map((row, index) => ({ stt: index + 1, id: row.evidence_id, at: displayTime(row.captured_at), event_name: row.event_name, schema: row.schema,
    api: row.api?.url || '', result: TP2_LABELS[row.status] || row.status, status: row.status,
    differences: row.message || row.comparisons.filter(field => field.status !== 'MATCH').map(field => `${field.field}: ${field.reason}`).join('\n'),
    details: { 'Kết quả đối chiếu': row.comparisons, 'Dữ liệu TP2 đã giải mã': byId.get(row.evidence_id)?.payload,
      'Thông tin giải mã': byId.get(row.evidence_id)?.tp2, 'API đối chiếu': row.api, 'Các API phù hợp': row.candidates } })) };
}
export function eventSections(snapshot, prepared) {
  const report = { id: 'events', title: 'Báo cáo event', columns: [col('stt', 'STT', 65), col('at', 'Thời điểm', 160), col('platform', 'Nền tảng', 120), col('flow', 'Luồng', 160), col('event_name', 'Tên event', 230),
    col('expected', 'Event mong muốn', 350), col('actual_ga4', 'Event thực tế (GA4)', 350), col('actual_insider', 'Event thực tế (Insider)', 350), col('comment', 'Nhận xét', 400)],
  rows: prepared.report.map(row => ({ ...row, at: row.at_text, diff: row.diff ? { expected: row.diff.expected, [row.source === 'GA4' ? 'actual_ga4' : 'actual_insider']: row.diff.actual } : undefined, comment: `[${REPORT_LABEL[row.status] || row.status}] ${snapshot.report_notes?.notes?.[row.key] ?? row.comment}`,
    details: { 'Event mong muốn': row.expected, 'Event thực tế GA4': row.actual_ga4, 'Event thực tế Insider': row.actual_insider, 'Nhận xét': row.comment, 'Bằng chứng': row.evidence_id } })) };
  const summary = { id: 'summary', title: 'Tổng quan', columns: [col('name', 'Nội dung', 280), col('value', 'Giá trị', 320)], rows: [
    { name: 'Phiên', value: snapshot.session?.id }, { name: 'Bắt đầu', value: displayTime(snapshot.session?.started_at) }, { name: 'Kết thúc', value: displayTime(snapshot.session?.completed_at) },
    { name: 'Bản ghi bằng chứng', value: snapshot.events?.length ?? 0 }, { name: 'Lần bắn event trong báo cáo', value: prepared.report.filter(row => row.seen).length },
    { name: 'Event đặc tả chưa thấy', value: prepared.report.filter(row => row.status === 'NOT_SEEN').length },
    { name: 'Case đã chạy', value: snapshot.steps?.length ?? 0 }, { name: 'API đã thu thập', value: snapshot.api_calls?.length ?? 0 },
    { name: 'Event lệch', value: prepared.report.filter(row => row.status === 'MISMATCH').length },
  ] };
  const checks = { id: 'checks', title: 'Kiểm tra theo bước', columns: [col('case', 'Test case', 230), col('event', 'Event', 230), col('field', 'Trường', 250), col('expected', 'Mong muốn', 300), col('actual', 'Thực tế', 300), col('result', 'Kết quả', 150)],
    rows: (snapshot.results ?? []).flatMap(result => (result.results ?? []).flatMap(event => (event.checks ?? []).map(check => ({ case: result.test_case_id, event: event.event_name, field: check.path || '', expected: check.expected,
      actual: check.actual, result: check.verdict, status: check.verdict, details: check })))) };
  return [summary, report, checks, ...(snapshot.api_calls?.length ? [apiSection(snapshot.api_calls)] : [])];
}

const TESTLAB_STATUS = { successful: 'Thành công', failed: 'Thất bại', in_progress: 'Đang xử lý', not_tested: 'Chưa test', unknown: 'Chưa rõ' };
const DEFINE_LABEL = { MATCH: 'Khớp', MISMATCH: 'Lệch', MISSING: 'Thiếu', EXTRA: 'Ngoài define', UNREAD: 'Chưa đọc' };
const DEFINE_ORDER = ['MISMATCH', 'MISSING', 'EXTRA', 'UNREAD', 'MATCH'];
/** Insider only: every Insider event of the session (website and app read from Test Lab) against the specification. */
export function insiderSection(snapshot, prepared) {
  const byId = new Map((snapshot.events ?? []).map(event => [event.evidence_id, event]));
  const caseById = new Map((snapshot.cases ?? []).map(testCase => [testCase.id, testCase]));
  const rows = prepared.report.filter(row => String(row.source).toUpperCase() === 'INSIDER');
  return { id: 'insider', title: 'Báo cáo Insider', columns: [col('stt', 'STT', 65), col('at', 'Thời điểm', 160), col('origin', 'Nguồn', 140), col('flow', 'Luồng', 150),
    col('event_name', 'Tên event', 220), col('expected', 'Event mong muốn', 340), col('actual', 'Event Insider nhận', 340), col('testlab', 'Test Lab', 110), col('define', 'So với define', 220), col('comment', 'Nhận xét', 380)],
  rows: rows.map((row, index) => {
    const event = byId.get(row.evidence_id);
    const define = event?.layer === 'TEST_LAB' ? defineComparison(event, caseById.get(row.case_id)) : null;
    return { ...row, stt: index + 1, at: row.at_text, origin: row.app ? 'App · Insider Test Lab' : row.status === 'NOT_SEEN' ? '' : 'Website', actual: row.actual_insider,
      diff: row.diff ? { expected: row.diff.expected, actual: row.diff.actual } : undefined,
      testlab: row.testlab_status ? TESTLAB_STATUS[row.testlab_status] ?? row.testlab_status : '',
      define: define ? DEFINE_ORDER.filter(result => define.summary[result]).map(result => `${DEFINE_LABEL[result]} ${define.summary[result]}`).join(' · ')
        + define.rows.filter(item => item.result !== 'MATCH').slice(0, 8).map(item => `\n${DEFINE_LABEL[item.result]}: ${item.name}${item.note ? ` (${item.note})` : ''}`).join('') : '',
      comment: `[${REPORT_LABEL[row.status] || row.status}] ${snapshot.report_notes?.notes?.[row.key] ?? row.comment}`,
      details: { 'Event mong muốn': row.expected, 'Event Insider nhận': row.actual_insider, 'Nhận xét': row.comment, 'Bằng chứng': row.evidence_id,
        ...(event?.testlab ? { 'Insider Test Lab': { lần_nhận: event.testlab.receipt, trạng_thái: event.testlab.status, đọc_đủ: event.testlab.complete, tham_số: event.testlab.params } } : {}),
        ...(define ? { 'So với define': define.rows.map(item => ({ tham_số: item.name, define: item.rule || item.expected, test_lab: item.actual, kết_quả: DEFINE_LABEL[item.result], ghi_chú: item.note })) } : {}),
        ...(event ? { 'Dữ liệu gốc': event.payload } : {}) } };
  }) };
}
