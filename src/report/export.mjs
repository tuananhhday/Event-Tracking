import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { redact } from '../core/privacy.mjs';
import { sanitizeCases, sensitivePath } from '../spec/sanitize.mjs';
import { specCoverage } from '../core/catalog.mjs';
import { firingChecks, FIRING_RULES } from '../core/firing.mjs';
import { linkDeliveries, deliveryStatus } from '../core/delivery.mjs';

const json = value => value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
const safe = value => {
  let text = json(value);
  if (text.length > 32000) text = `[TRUNCATED: full record in comparison.json]\n${text.slice(0, 31900)}`;
  return /^[=+@\-\t\r]/.test(text) ? `'${text}` : text;
};
const escape = value => json(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const colors = { PASS: 'DCFCE7', FAIL: 'FEE2E2', REVIEW: 'FEF3C7', NOT_EXECUTED: 'E2E8F0', 'Khớp': 'DCFCE7', 'Lệch': 'FEE2E2', 'Cần xem': 'FEF3C7', 'Chưa thấy': 'E2E8F0', 'Ngoài đặc tả': 'FEF3C7', 'Không gửi lên server': 'FEE2E2', 'Đang chờ gửi': 'FEF3C7', 'Đã gửi': 'DCFCE7' };
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

function addSheet(workbook, name, headers, rows, widths = []) {
  const worksheet = workbook.addWorksheet(name);
  worksheet.columns = headers.map((header, index) => ({ header, key: `c${index}`, width: widths[index] ?? 24 }));
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: headers.length } };
  worksheet.getRow(1).height = 28;
  worksheet.getRow(1).eachCell(cell => { cell.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFF' }, size: 11 }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '17365D' } }; cell.alignment = { vertical: 'middle', wrapText: true }; });
  for (const values of rows) {
    const row = worksheet.addRow(values.map(value => safe(value)));
    const wrappedLines = row.values.slice(1).map((value, index) => String(value ?? '').split(/\r?\n/).reduce((count, line) => count + Math.max(1, Math.ceil([...line].length / Math.max(8, (widths[index] ?? 24) - 2))), 0));
    row.height = Math.min(409, Math.max(30, Math.max(...wrappedLines, 1) * 15 + 10));
    row.eachCell(cell => {
      cell.font = { name: 'Calibri', size: 11 };
      cell.alignment = { vertical: 'top', wrapText: true };
      if (colors[cell.value]) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors[cell.value] } };
    });
  }
  worksheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  return worksheet;
}

export async function exportReports({ session = {}, cases = [], events = [], steps = [], results = [] }, outputDir) {
  // Matched on the unsanitized spec so sample values can still identify each flow.
  const links = linkDeliveries(events), now = Date.now();
  const coverage = cases.length ? specCoverage(cases, events, new Map(), { links, now }) : null;
  const firing = firingChecks(events);
  const delivery = new Map(events.map(event => [event.evidence_id, DELIVERY_LABEL[deliveryStatus(event, links, now)] ?? '']));
  ({ session, cases, events, steps, results } = sanitizeSnapshot({ session, cases, events, steps, results }));
  const directory = path.resolve(outputDir);
  await fs.mkdir(directory, { recursive: true });
  const paths = { xlsx: path.join(directory, 'report.xlsx'), html: path.join(directory, 'report.html'), json: path.join(directory, 'comparison.json'), bugs: path.join(directory, 'bugs.md') };
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Event Tracking QA';
  workbook.created = new Date();
  const tallies = Object.fromEntries(['PASS', 'FAIL', 'REVIEW', 'NOT_EXECUTED'].map(verdict => [verdict, results.filter(result => result.verdict === verdict).length]));
  addSheet(workbook, 'Run Summary', ['Metric', 'Value'], [
    ['Session', session.id ?? session.session_id], ['Mode', session.mode], ['Started', session.started_at], ['Completed', session.completed_at],
    ['Test cases', cases.length], ['Steps', steps.length], ['Evidence records', events.length], ...Object.entries(tallies),
    ...(coverage ? [['Spec rows', coverage.totals.rows], ['Spec rows fired', coverage.totals.seen], ['Spec rows matching sample', coverage.totals.match], ['Spec rows mismatching', coverage.totals.mismatch], ['Spec rows pushed but not sent', coverage.totals.not_sent], ['Spec rows not seen', coverage.totals.not_seen], ['Events outside spec', coverage.totals.unmatched]] : []),
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
  addSheet(workbook, 'Test Cases', ['ID', 'Name', 'Source', 'Flow', 'Description', 'Needs review', 'File', 'Sheet', 'Row'], cases.map(testCase => [testCase.id, testCase.name, testCase.source, testCase.flow, testCase.description, Boolean(testCase.needs_review), testCase.provenance?.file, testCase.provenance?.sheet, testCase.provenance?.row]), [35, 40, 16, 22, 65, 16, 55, 30, 10]);
  addSheet(workbook, 'Expected Events', ['Test case', 'Event', 'Layer', 'Source', 'Count', 'Timing ms', 'After', 'Field rules', 'Needs review'], cases.flatMap(testCase => testCase.rules.map(rule => [testCase.id, rule.event_name, rule.layer, rule.source ?? testCase.source, rule.count, rule.within_ms, rule.after, rule.fields, Boolean(rule.needs_review)])), [35, 30, 24, 16, 24, 16, 28, 95, 16]);
  addSheet(workbook, 'Actual Events', ['Evidence ID', 'Captured at', 'Test case', 'Step', 'Event', 'Layer', 'Source', 'Gửi lên server', 'Page', 'Payload', 'Network'], events.map(event => [event.evidence_id, event.captured_at, event.test_case_id, event.step_id, event.event_name, event.layer, event.source, delivery.get(event.evidence_id), event.page?.url, event.payload, event.network]), [30, 30, 35, 30, 30, 24, 16, 22, 60, 100, 80]);
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
  addSheet(workbook, 'Comparison', ['Test case', 'Step', 'Event', 'Layer', 'Field', 'Expected', 'Actual', 'Verdict', 'Issue', 'Evidence ID'], comparisons, [35, 30, 30, 24, 35, 65, 65, 18, 30, 30]);
  addSheet(workbook, 'Bug Reports', ['Test case', 'Event', 'Layer', 'Issue', 'Field', 'Expected', 'Actual', 'Evidence', 'AI note'], bugs.map(bug => [bug.test_case_id, bug.event_name, bug.layer, bug.code, bug.path, bug.expected, bug.actual, bug.evidence_id, bug.ai_note]), [35, 30, 24, 30, 35, 65, 65, 30, 90]);
  await workbook.xlsx.writeFile(paths.xlsx);
  await fs.writeFile(paths.json, JSON.stringify({ session, counts: tallies, cases, events, steps, results }, null, 2), 'utf8');
  const coverageHtml = coverage ? `<h2>Đối chiếu đặc tả</h2><p class="summary">${escape(coverage.totals.rows)} dòng · đã bắn ${escape(coverage.totals.seen)} · khớp ${escape(coverage.totals.match)} · lệch ${escape(coverage.totals.mismatch)} · có push nhưng không gửi ${escape(coverage.totals.not_sent)} · chưa thấy ${escape(coverage.totals.not_seen)} · ngoài đặc tả ${escape(coverage.totals.unmatched)}</p><table><thead><tr>${['STT', 'Nền tảng', 'Luồng', 'Event Name', 'Trạng thái', 'Số lần bắn', 'Trường lệch', 'Evidence ID', 'Ghi chú đặc tả'].map(value => `<th>${value}</th>`).join('')}</tr></thead><tbody>${coverageRows.map(row => `<tr>${[0, 1, 2, 3, 5, 6, 9, 10, 11].map(index => `<td>${escape(row[index]).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`).join('\n')}</tbody></table><h2>Kết quả theo bước</h2>` : '';
  const htmlRows = comparisons.map(values => `<tr>${values.map(value => `<td>${escape(value)}</td>`).join('')}</tr>`).join('\n');
  await fs.writeFile(paths.html, `<!doctype html><html lang="vi"><meta charset="utf-8"><title>Event Tracking QA Report</title><style>body{font:15px system-ui;margin:32px;color:#172b4d}table{border-collapse:collapse;width:100%}td,th{border:1px solid #cbd5e1;padding:9px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#17365d;color:white}h1{font-size:26px}.summary{padding:16px;background:#eff6ff}pre{white-space:pre-wrap}</style><h1>Event Tracking QA</h1><p class="summary">Session: ${escape(session.id ?? session.session_id)} · Mode: ${escape(session.mode)} · ${escape(tallies)}</p><p>Vendor ingestion: NOT_VERIFIED. HTTP response is transport evidence only.</p>${coverageHtml}<table><thead><tr>${['Test case', 'Step', 'Event', 'Layer', 'Field', 'Expected', 'Actual', 'Verdict', 'Issue', 'Evidence ID'].map(value => `<th>${value}</th>`).join('')}</tr></thead><tbody>${htmlRows}</tbody></table></html>`, 'utf8');
  for (const row of coverage?.rows ?? []) if (row.status === 'MISMATCH' || row.status === 'NOT_SENT') bugs.push({ spec: true, row });
  const specBug = ({ row }) => row.status === 'NOT_SENT'
    ? `## [Tracking][${row.flow}][${row.source}] ${row.event_name}: có push nhưng không gửi lên ${vendorOf(row)}\n\nĐặc tả: STT ${row.stt} (${row.sheet ?? ''} dòng ${row.row ?? ''})\n\nWebsite push vào ${row.source === 'GA4' ? 'dataLayer' : 'InsiderQueue'} ${row.not_sent} lần nhưng không có request nào mang event này lên ${vendorOf(row)}. Kiểm tra tag/trigger trong GTM hoặc Insider SDK.\n\nEvidence: ${row.last_fail_evidence_id}\n\n${row.notes ? `Ghi chú đặc tả: ${row.notes}\n\n` : ''}`
    : `## [Tracking][${row.flow}][${row.source}] ${row.event_name}: lệch so với đặc tả\n\nĐặc tả: STT ${row.stt} (${row.sheet ?? ''} dòng ${row.row ?? ''})\n\nĐã bắn: ${row.seen} lần, lệch ${row.fail} lần\n\nTrường lệch:\n\n${row.issues.map(issue => `- ${issueLine(issue)}`).join('\n')}\n\nEvidence: ${row.last_fail_evidence_id}\n\n${row.notes ? `Ghi chú đặc tả: ${row.notes}\n\n` : ''}`;
  const bugText = bugs.length ? bugs.map(bug => bug.spec ? specBug(bug) : `## [Tracking][${bug.flow ?? ''}][${bug.source ?? ''}] ${bug.event_name}: ${bug.code}\n\nTest case: ${bug.test_case_id}\n\nStep: ${bug.step_id}\n\nLayer: ${bug.layer}\n\nField: ${bug.path ?? '(event)'}\n\nExpected:\n\n\`\`\`json\n${JSON.stringify(bug.expected ?? null, null, 2)}\n\`\`\`\n\nActual:\n\n\`\`\`json\n${JSON.stringify(bug.actual ?? null, null, 2)}\n\`\`\`\n\nEvidence: ${bug.evidence_id}\n\nVerdict: FAIL\n\n${bug.ai_note ? `AI note (advisory): ${bug.ai_note}\n\n` : ''}`).join('\n---\n\n') : '# Bug reports\n\nNo deterministic failures found. Review/NOT_EXECUTED cases are not confirmed defects.\n';
  await fs.writeFile(paths.bugs, bugText, 'utf8');
  return paths;
}
