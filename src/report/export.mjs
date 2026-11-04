import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { redact } from '../core/privacy.mjs';
import { sanitizeCases, sensitivePath } from '../spec/sanitize.mjs';
import { specCoverage } from '../core/catalog.mjs';
import { firingChecks, FIRING_RULES } from '../core/firing.mjs';
import { linkDeliveries, deliveryStatus } from '../core/delivery.mjs';
import { activityEntries } from '../core/activity.mjs';
import { priceChecks } from '../core/api-prices.mjs';
import { eventReportRows, REPORT_LABEL } from './event-report.mjs';
import { bodyText } from '../core/api-log.mjs';
import { renderHtmlReport } from './html.mjs';
import { eventSections } from './models.mjs';

const json = value => value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
const safe = value => {
  // Counts and the report's STT stay numbers in Excel.
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  let text = json(value);
  if (text.length > 32000) text = `[TRUNCATED: full record in comparison.json]\n${text.slice(0, 31900)}`;
  return /^[=+@\-\t\r]/.test(text) ? `'${text}` : text;
};
const escape = value => json(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const colors = { PASS: 'DCFCE7', FAIL: 'FEE2E2', REVIEW: 'FEF3C7', NOT_EXECUTED: 'E2E8F0', 'Khớp': 'DCFCE7', 'Lệch': 'FEE2E2', 'Cần xem': 'FEF3C7', 'Chưa thấy': 'E2E8F0', 'Ngoài đặc tả': 'FEF3C7', 'Không gửi lên server': 'FEE2E2', 'Đang chờ gửi': 'FEF3C7', 'Đã gửi': 'DCFCE7', 'Khớp API': 'DCFCE7', 'Khớp giá trên API': 'DCFCE7', 'Lệch API': 'FEE2E2', 'Không thấy trong API': 'E2E8F0' };
// The comment of each row of the report sheet is coloured by the tool's verdict.
const REPORT_FILL = { MATCH: 'DCFCE7', SENT: 'DCFCE7', MISMATCH: 'FEE2E2', NOT_SENT: 'FEE2E2', NOT_SEEN: 'E2E8F0', REVIEW: 'FEF3C7', PENDING: 'FEF3C7', UNCHECKED: 'FEF3C7', OUTSIDE: 'FEF3C7' };
const PRICE_LABEL = { MATCH: 'Khớp API', MATCH_PAGE: 'Khớp giá trên API', MISMATCH: 'Lệch API', NO_API: 'Không thấy trong API' };
const money = value => typeof value === 'number' ? value.toLocaleString('vi-VN') : '';
const COVERAGE_LABEL = { MATCH: 'Khớp', MISMATCH: 'Lệch', REVIEW: 'Cần xem', NOT_SEEN: 'Chưa thấy', NOT_SENT: 'Không gửi lên server', PENDING: 'Đang chờ gửi' };
const DELIVERY_LABEL = { sent: 'Đã gửi', not_sent: 'Không gửi lên server', pending: 'Đang chờ gửi', unverified: 'Trước khi thu thập' };
const issueLine = issue => `${issue.code}${issue.path ? ` ${issue.path}` : ''}${['VALUE_MISMATCH', 'WRONG_TYPE', 'DYNAMIC_VALUE_MISMATCH'].includes(issue.code) ? ` (mong đợi ${json(issue.expected)}, thực tế ${json(issue.actual)})` : ''}${issue.code === 'NOT_FORWARDED' ? ` (website push ${json(issue.pushed)}, Google không nhận)` : ''}`;
// A row whose pushes never reached the vendor has no field issues to list: say what happened instead.
const vendorOf = row => row.source === 'GA4' ? 'Google' : 'Insider';
const rowIssues = row => [...(row.not_sent ? [`Website push ${row.not_sent} lần nhưng không có request gửi lên ${vendorOf(row)}`] : []), ...row.issues.map(issueLine)].join('\n');

// Sanitize every output boundary even if a caller supplies an unsanitized spec,
// context or diff. Keep QA IDs and rule syntax separate from vendor data.
const MASK = '[REDACTED]';
function sanitizeFinding(finding) {
  const cleaned = redact(finding);
  if (sensitivePath(finding.path)) {
    if (Object.hasOwn(finding, 'actual')) cleaned.actual = MASK;
    if (Object.hasOwn(finding, 'expected')) cleaned.expected = MASK;
  }
  return cleaned;
}
function sanitizeResult(result) {
  const cleaned = redact({ ...result, results: undefined });
  cleaned.results = (result.results ?? []).map(eventResult => ({
    ...redact({ ...eventResult, checks: undefined, issues: undefined }),
    checks: (eventResult.checks ?? []).map(sanitizeFinding),
    issues: (eventResult.issues ?? []).map(sanitizeFinding),
  }));
  return cleaned;
}
function sanitizeSnapshot(snapshot) {
  const session = redact(snapshot.session);
  if (Object.hasOwn(snapshot.session, 'session_id')) session.session_id = snapshot.session.session_id;
  if (Array.isArray(snapshot.session.results)) session.results = snapshot.session.results.map(sanitizeResult);
  return {
    session,
    cases: sanitizeCases(snapshot.cases),
    steps: snapshot.steps.map(step => redact(step)),
    events: snapshot.events.map(event => {
      const cleaned = redact(event);
      if (Object.hasOwn(event, 'session_id')) cleaned.session_id = event.session_id;
      return cleaned;
    }),
    results: snapshot.results.map(sanitizeResult),
  };
}

// Excel caps a row at 409 points, so counting past 27 wrapped lines cannot
// affect its height. Count Unicode code points without allocating [...line].
function wrappedLineCount(value, width) {
  const text = String(value ?? ''), limit = 27;
  let lines = 0, length = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 13 && text.charCodeAt(index + 1) === 10) continue;
    if (code === 10) {
      lines += Math.max(1, Math.ceil(length / width));
      if (lines >= limit) return limit;
      length = 0;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
    if (++length > (limit - lines - 1) * width) return limit;
  }
  return Math.min(limit, lines + Math.max(1, Math.ceil(length / width)));
}

function addSheet(workbook, name, headers, rows, widths = []) {
  const worksheet = workbook.addWorksheet(name);
  worksheet.columns = headers.map((header, index) => ({ header, key: `c${index}`, width: widths[index] ?? 24 }));
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: headers.length } };
  worksheet.getRow(1).height = 28;
  worksheet.getRow(1).eachCell(cell => { cell.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFF' }, size: 11 }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '17365D' } }; cell.alignment = { vertical: 'middle', wrapText: true }; });
  for (const values of rows) {
    const row = worksheet.addRow(values.map(value => safe(value)));
    let wrappedLines = 1;
    row.values.slice(1).some((value, index) => {
      wrappedLines = Math.max(wrappedLines, wrappedLineCount(value, Math.max(8, (widths[index] ?? 24) - 2)));
      return wrappedLines >= 27;
    });
    row.height = Math.min(409, Math.max(30, wrappedLines * 15 + 10));
    row.eachCell(cell => {
      cell.font = { name: 'Calibri', size: 11 };
      cell.alignment = { vertical: 'top', wrapText: true };
      if (colors[cell.value]) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors[cell.value] } };
    });
  }
  worksheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  return worksheet;
}

export function prepareReportData({ cases = [], events = [], api = [] } = {}) {
  // Matched on the unsanitized spec so sample values can still identify each flow.
  const links = linkDeliveries(events), now = Date.now();
  const coverage = cases.length ? specCoverage(cases, events, new Map(), { links, now }) : null;
  const firing = firingChecks(events, { links });
  const entries = activityEntries(events, { links, now });
  const priced = priceChecks(entries, api);
  // STT, platform, flow, event, expected event, actual event, comment (written by AI in the AI version).
  const report = eventReportRows({ cases, events, api, links, now, coverage, entries, priced });
  return { links, now, coverage, firing, entries, priced, report };
}

export async function exportReports({ session = {}, cases = [], events = [], steps = [], results = [], api = [], api_calls: apiCalls = [], report_notes: reportNotes = null }, outputDir, { prepared, formats, htmlSettings = {} } = {}) {
  const { links, now, coverage, firing, priced, report } = prepared ?? prepareReportData({ cases, events, api });
  const notes = reportNotes?.notes ?? {}, byAi = report.some(row => notes[row.key]);
  const delivery = new Map(events.map(event => [event.evidence_id, DELIVERY_LABEL[deliveryStatus(event, links, now)] ?? '']));
  ({ session, cases, events, steps, results } = sanitizeSnapshot({ session, cases, events, steps, results }));
  const directory = path.resolve(outputDir);
  await fs.mkdir(directory, { recursive: true });
  const paths = { xlsx: path.join(directory, 'report.xlsx'), html: path.join(directory, 'report.html'), json: path.join(directory, 'comparison.json'), bugs: path.join(directory, 'bugs.md') };
  const wanted = formats ?? ['xlsx', 'html', 'json', 'bugs'];
  const tallies = Object.fromEntries(['PASS', 'FAIL', 'REVIEW', 'NOT_EXECUTED'].map(verdict => [verdict, results.filter(result => result.verdict === verdict).length]));
  const comparisons = [];
  const bugs = [];
  for (const result of results) {
    const testCase = cases.find(candidate => candidate.id === result.test_case_id);
    if (!result.results?.length) comparisons.push([result.test_case_id, result.step_id, '', '', '', '', '', result.verdict, 'Step was not executed', '']);
    for (const eventResult of result.results ?? []) {
      if (!eventResult.checks?.length) comparisons.push([result.test_case_id, result.step_id, eventResult.event_name, eventResult.layer, '', '', '', eventResult.verdict, '', (eventResult.evidence_ids ?? []).join(', ')]);
      for (const check of eventResult.checks ?? []) comparisons.push([result.test_case_id, result.step_id, eventResult.event_name, eventResult.layer, check.path ?? '', check.expected, check.actual, check.verdict, check.code ?? '', check.evidence_id]);
      for (const issue of eventResult.issues ?? []) if (result.verdict === 'FAIL' && eventResult.verdict === 'FAIL' && issue.verdict !== 'REVIEW') bugs.push({ test_case_id: result.test_case_id, step_id: result.step_id, flow: testCase?.flow, event_name: eventResult.event_name, layer: eventResult.layer, source: eventResult.source, ...issue, ai_note: eventResult.ai_note ?? result.ai_note });
    }
  }
  if (wanted.includes('xlsx')) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Event Tracking QA';
  workbook.created = new Date();
  // The actual event in the column of the platform the expected payload is written for (both without one).
  const reportSheet = addSheet(workbook, 'Báo cáo event', ['STT', 'Nền tảng', 'Luồng', 'Tên event', 'Event mong muốn', 'Event thực tế (GA4)', 'Event thực tế (Insider)', byAi ? 'Nhận xét của AI' : 'Nhận xét'],
    report.map(row => [row.stt, row.platform, row.flow, row.event_name, row.expected, row.actual_ga4, row.actual_insider, `[${REPORT_LABEL[row.status]}] ${notes[row.key] ?? row.comment}`]), [6, 11, 18, 26, 55, 55, 55, 60]);
  report.forEach((row, index) => { reportSheet.getRow(index + 2).getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: REPORT_FILL[row.status] ?? 'FFFFFF' } }; });
  addSheet(workbook, 'Run Summary', ['Metric', 'Value'], [
    ['Session', session.id ?? session.session_id], ['Mode', session.mode], ['Started', session.started_at], ['Completed', session.completed_at],
    ['Test cases', cases.length], ['Steps', steps.length], ['Evidence records', events.length], ...Object.entries(tallies),
    ...(coverage ? [['Spec rows', coverage.totals.rows], ['Spec rows fired', coverage.totals.seen], ['Spec rows matching sample', coverage.totals.match], ['Spec rows mismatching', coverage.totals.mismatch], ['Spec rows pushed but not sent', coverage.totals.not_sent], ['Spec rows not seen', coverage.totals.not_seen], ['Events outside spec', coverage.totals.unmatched]] : []),
    ['Nhận xét trong sheet Báo cáo event', byAi ? `AI${reportNotes.model ? ` (${reportNotes.model})` : ''}; dòng AI không trả lời giữ nhận xét của công cụ` : 'Công cụ tự kiểm'],
    ['Giá đã so với API', priced.summary.total], ['Giá lệch API', priced.summary.mismatch], ['API của website đã đọc', priced.summary.api_responses],
    ['API Request/Response đã lưu', apiCalls.length], ['API lỗi (HTTP ≥ 400 hoặc lỗi mạng)', apiCalls.filter(call => !call.ok).length],
    ['Ingestion', 'NOT_VERIFIED: HTTP response does not confirm vendor ingestion.'],
  ], [28, 86]);
  const coverageRows = coverage ? [
    ...coverage.rows.map(row => [row.stt, row.source, row.flow, row.event_name, row.description, COVERAGE_LABEL[row.status], row.seen, row.pass, row.fail, rowIssues(row), row.last_fail_evidence_id || row.last_evidence_id || '', row.notes, row.sheet, row.row]),
    ...coverage.unmatched.map(item => ['', item.source, '', item.event_name, item.ambiguous ? 'Nhiều dòng đặc tả cùng phù hợp; chưa gán luồng' : 'Event bắn ra nhưng đặc tả không có', item.ambiguous ? 'Cần xác định luồng' : 'Ngoài đặc tả', item.count, '', '', '', item.last_evidence_id, '', '', '']),
  ] : [];
  addSheet(workbook, 'Spec Coverage', ['STT', 'Nền tảng', 'Luồng', 'Event Name', 'Mô tả', 'Trạng thái', 'Số lần bắn', 'Khớp', 'Lệch', 'Trường lệch', 'Evidence ID', 'Ghi chú đặc tả', 'Sheet', 'Dòng'], coverageRows, [7, 11, 18, 26, 40, 14, 11, 8, 8, 60, 42, 40, 22, 8]);
  const byId = new Map(events.map(event => [event.evidence_id, event]));
  const firingRows = [...firing.byEvent.entries()].flatMap(([id, checks]) => checks.map(check => [byId.get(id)?.captured_at, byId.get(id)?.source, byId.get(id)?.layer, byId.get(id)?.event_name, FIRING_RULES[check.rule], check.status === 'PASS' ? 'PASS' : check.status === 'FAIL' ? 'FAIL' : 'REVIEW', check.message, id, check.evidence_id ?? '']))
    .sort((a, b) => ({ FAIL: 0, REVIEW: 1, PASS: 2 })[a[5]] - ({ FAIL: 0, REVIEW: 1, PASS: 2 })[b[5]] || String(a[0]).localeCompare(String(b[0])));
  addSheet(workbook, 'Firing Checks', ['Thời điểm', 'Nền tảng', 'Tầng', 'Event', 'Quy tắc', 'Kết quả', 'Chi tiết', 'Evidence ID', 'Evidence liên quan'], firingRows, [24, 10, 16, 26, 44, 10, 70, 42, 42]);
  addSheet(workbook, 'Giá vs API', ['Thời điểm', 'Nền tảng', 'Event', 'Trường giá', 'Giá đã gửi', 'Giá API', 'Kết quả', 'Trường API', 'API', 'Giá khác trong API', 'Evidence ID'],
    redact(priced.checks).map(check => [check.at, check.source, check.event, check.field, check.sent, check.api?.value ?? '', PRICE_LABEL[check.status], check.api?.path ?? '', check.api?.url ?? '',
      (check.candidates ?? []).map(other => `${money(other.value)} (${other.path})`).join('\n'), check.evidence_id]), [24, 10, 26, 30, 14, 14, 18, 44, 60, 44, 42]);
  // Website API calls (api-log.mjs): one row per call; a body longer than a cell is cut here and kept whole in api-calls.jsonl.
  const stepCase = new Map(steps.map(step => [step.id, step.test_case_id]));
  addSheet(workbook, 'API calls', ['Thời điểm', 'Method', 'Host', 'Path', 'Query', 'HTTP status', 'Thời gian (ms)', 'Request body', 'Response body', 'Lỗi', 'Trang', 'Test case', 'Evidence ID'],
    apiCalls.map(call => [call.captured_at, call.method, call.host, call.path, Object.keys(call.query ?? {}).length ? call.query : '', call.response?.status ?? '', call.duration_ms ?? '',
      bodyText(call.request?.body), bodyText(call.response?.body), call.error ?? '', call.page?.url ?? '', call.test_case_id ?? stepCase.get(call.step_id) ?? '', call.evidence_id]),
    [24, 9, 26, 46, 30, 11, 12, 60, 80, 24, 50, 30, 46]);
  addSheet(workbook, 'Test Cases', ['ID', 'Name', 'Source', 'Flow', 'Description', 'Needs review', 'File', 'Sheet', 'Row'], cases.map(testCase => [testCase.id, testCase.name, testCase.source, testCase.flow, testCase.description, Boolean(testCase.needs_review), testCase.provenance?.file, testCase.provenance?.sheet, testCase.provenance?.row]), [35, 40, 16, 22, 65, 16, 55, 30, 10]);
  addSheet(workbook, 'Expected Events', ['Test case', 'Event', 'Layer', 'Source', 'Count', 'Timing ms', 'After', 'Field rules', 'Needs review'], cases.flatMap(testCase => testCase.rules.map(rule => [testCase.id, rule.event_name, rule.layer, rule.source ?? testCase.source, rule.count, rule.within_ms, rule.after, rule.fields, Boolean(rule.needs_review)])), [35, 30, 24, 16, 24, 16, 28, 95, 16]);
  addSheet(workbook, 'Actual Events', ['Evidence ID', 'Captured at', 'Test case', 'Step', 'Event', 'Layer', 'Source', 'Gửi lên server', 'Page', 'Payload', 'Network'], events.map(event => [event.evidence_id, event.captured_at, event.test_case_id, event.step_id, event.event_name, event.layer, event.source, delivery.get(event.evidence_id), event.page?.url, event.payload, event.network]), [30, 30, 35, 30, 30, 24, 16, 22, 60, 100, 80]);
  addSheet(workbook, 'Comparison', ['Test case', 'Step', 'Event', 'Layer', 'Field', 'Expected', 'Actual', 'Verdict', 'Issue', 'Evidence ID'], comparisons, [35, 30, 30, 24, 35, 65, 65, 18, 30, 30]);
  addSheet(workbook, 'Bug Reports', ['Test case', 'Event', 'Layer', 'Issue', 'Field', 'Expected', 'Actual', 'Evidence', 'AI note'], bugs.map(bug => [bug.test_case_id, bug.event_name, bug.layer, bug.code, bug.path, bug.expected, bug.actual, bug.evidence_id, bug.ai_note]), [35, 30, 24, 30, 35, 65, 65, 30, 90]);
  await workbook.xlsx.writeFile(paths.xlsx);
  }
  if (wanted.includes('json')) await fs.writeFile(paths.json, JSON.stringify({ session, counts: tallies, cases, events, steps, results, event_report: report.map(row => ({ stt: row.stt, platform: row.platform, flow: row.flow, event: row.event_name, status: row.status, evidence_id: row.evidence_id, comment: notes[row.key] ?? row.comment, comment_by: notes[row.key] ? 'AI' : 'tool' })) }, null, 2), 'utf8');
  if (wanted.includes('html')) await fs.writeFile(paths.html, renderHtmlReport({ title: 'Báo cáo event', session, settings: htmlSettings, sections: eventSections({ session, cases, events, steps, results, api_calls: apiCalls, report_notes: reportNotes }, { report }) }), 'utf8');
  for (const row of coverage?.rows ?? []) if (row.status === 'MISMATCH' || row.status === 'NOT_SENT') bugs.push({ spec: true, row });
  const specBug = ({ row }) => row.status === 'NOT_SENT'
    ? `## [Tracking][${row.flow}][${row.source}] ${row.event_name}: có push nhưng không gửi lên ${vendorOf(row)}\n\nĐặc tả: STT ${row.stt} (${row.sheet ?? ''} dòng ${row.row ?? ''})\n\nWebsite push vào ${row.source === 'GA4' ? 'dataLayer' : 'InsiderQueue'} ${row.not_sent} lần nhưng không có request nào mang event này lên ${vendorOf(row)}. Kiểm tra tag/trigger trong GTM hoặc Insider SDK.\n\nEvidence: ${row.last_fail_evidence_id}\n\n${row.notes ? `Ghi chú đặc tả: ${row.notes}\n\n` : ''}`
    : `## [Tracking][${row.flow}][${row.source}] ${row.event_name}: lệch so với đặc tả\n\nĐặc tả: STT ${row.stt} (${row.sheet ?? ''} dòng ${row.row ?? ''})\n\nĐã bắn: ${row.seen} lần, lệch ${row.fail} lần\n\nTrường lệch:\n\n${row.issues.map(issue => `- ${issueLine(issue)}`).join('\n')}\n\nEvidence: ${row.last_fail_evidence_id}\n\n${row.notes ? `Ghi chú đặc tả: ${row.notes}\n\n` : ''}`;
  for (const check of redact(priced.checks)) if (check.status === 'MISMATCH') bugs.push({ price: true, check });
  const priceBug = ({ check }) => `## [Giá][${check.source}] ${check.event}: ${check.field} gửi ${money(check.sent)}, API ${money(check.api.value)}\n\n`
    + `Đã gửi lên ${check.source === 'GA4' ? 'Google' : 'Insider'}: \`${check.field}\` = ${money(check.sent)}${check.currency ? ` ${check.currency}` : ''}${check.name ? ` (${check.name})` : ''}\n\n`
    + `API của website: \`${check.api.path}\` = ${money(check.api.value)}${check.api.times ? ` × ${check.api.times}` : ''}, ${check.api.url} lúc ${check.api.at}\n\n`
    + (check.stale ? `Giá đã gửi khớp API cũ lúc ${check.stale.at} (\`${check.stale.path}\`): giá chưa được cập nhật sau khi API đổi.\n\n` : '')
    + `Evidence: ${check.evidence_id}\n\n`;
  const bugText = bugs.length ? bugs.map(bug => bug.price ? priceBug(bug) : bug.spec ? specBug(bug) : `## [Tracking][${bug.flow ?? ''}][${bug.source ?? ''}] ${bug.event_name}: ${bug.code}\n\nTest case: ${bug.test_case_id}\n\nStep: ${bug.step_id}\n\nLayer: ${bug.layer}\n\nField: ${bug.path ?? '(event)'}\n\nExpected:\n\n\`\`\`json\n${JSON.stringify(bug.expected ?? null, null, 2)}\n\`\`\`\n\nActual:\n\n\`\`\`json\n${JSON.stringify(bug.actual ?? null, null, 2)}\n\`\`\`\n\nEvidence: ${bug.evidence_id}\n\nVerdict: FAIL\n\n${bug.ai_note ? `AI note (advisory): ${bug.ai_note}\n\n` : ''}`).join('\n---\n\n') : '# Bug reports\n\nNo deterministic failures found. Review/NOT_EXECUTED cases are not confirmed defects.\n';
  if (wanted.includes('bugs')) await fs.writeFile(paths.bugs, bugText, 'utf8');
  // The full API log is a download of its own; reports written elsewhere than the run folder get a copy.
  if (apiCalls.length) {
    const file = path.join(directory, 'api-calls.jsonl');
    let present = false;
    try { present = (await fs.stat(file)).size > 0; } catch { /* written below */ }
    if (!present) await fs.writeFile(file, apiCalls.map(call => JSON.stringify(redact(call))).join('\n') + '\n', 'utf8');
    paths.api_calls = file;
  }
  return Object.fromEntries(Object.entries(paths).filter(([key]) => wanted.includes(key) || key === 'api_calls'));
}
