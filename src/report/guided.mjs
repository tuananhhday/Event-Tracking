import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { redact as redactCore } from '../core/privacy.mjs';
import { sanitizeCases, sanitizeRule, sensitivePath } from '../spec/sanitize.mjs';

const MASK = '[REDACTED]';
// Insider wire custom attributes use c_* names. Classify those names with the
// same privacy contract as their unprefixed UI fields, retaining rule syntax.
function redact(value) {
  const visit = node => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).map(([key, child]) => {
      if (/^c_/i.test(key) && sensitivePath(key.replace(/^c_/i, ''))) {
        if (child && typeof child === 'object' && typeof child.op === 'string') {
          return [key, ['eq', 'one_of', 'subset'].includes(child.op) ? { ...visit(child), value: MASK } : visit(child)];
        }
        return [key, MASK];
      }
      return [key, visit(child)];
    }));
  };
  return visit(redactCore(value));
}
const valueText = value => value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
const escapeHtml = value => valueText(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const statusLabels = {
  match: 'Khớp phần đã kiểm', missing: 'Thiếu', mismatch: 'Sai', extra: 'Bổ sung / ngoài mong muốn', review: 'Cần kiểm tra',
  not_executed: 'Chưa thực hiện', interrupted: 'Bị gián đoạn', error: 'Lỗi',
};
const statusOf = value => String(value ?? 'review').toLowerCase();
const statusLabel = value => statusLabels[statusOf(value)] ?? valueText(value);
const acceptanceLabel = value => ({ PASS: 'Đạt', FAIL: 'Có lỗi', REVIEW: 'Cần xác nhận', NOT_EXECUTED: 'Chưa thực hiện' })[value] ?? valueText(value);
const countLabel = value => value && typeof value === 'object'
  ? value.min === value.max ? value.min : value.max == null ? `Ít nhất ${value.min ?? 0}` : `${value.min ?? 0}–${value.max}`
  : value;
const syntaxOperators = new Set(['exists', 'not_exists', 'type', 'regex', 'one_of_type', 'range', 'ignore']);

function sanitizeFinding(finding = {}) {
  // Field names and type/context syntax are requirements, not personal values.
  const safe = redact({ ...finding, path: undefined, expected: undefined, actual: undefined });
  if (Object.hasOwn(finding, 'path')) safe.path = finding.path;
  const sensitive = sensitivePath(finding.path) || sensitivePath(String(finding.path ?? '').split('.').at(-1).replace(/^c_/i, ''));
  if (Object.hasOwn(finding, 'actual')) safe.actual = sensitive ? MASK : redact(finding.actual);
  if (Object.hasOwn(finding, 'expected')) {
    const isSyntax = syntaxOperators.has(finding.op) || (finding.op === 'ref' && typeof finding.expected === 'string' && finding.expected.startsWith('context.'));
    safe.expected = sensitive && !isSyntax ? MASK : redact(finding.expected);
  }
  return safe;
}

function sanitizeRules(rules) {
  if (!rules || typeof rules !== 'object') return redact(rules);
  if (Array.isArray(rules)) return rules.map(rule => rule?.fields ? sanitizeRule(rule) : redact(rule));
  if (rules.fields) return sanitizeRule(rules);
  return Object.fromEntries(Object.entries(rules).map(([fieldPath, definition]) => {
    const safe = sanitizeRule({ fields: { [fieldPath]: definition } });
    return [fieldPath, safe.fields[fieldPath]];
  }));
}

function sanitizeComparison(comparison = {}) {
  const safe = redact({ ...comparison, parameters: undefined, issues: undefined, expected_rules: undefined });
  safe.parameters = (comparison.parameters ?? []).map(sanitizeFinding);
  safe.issues = (comparison.issues ?? []).map(sanitizeFinding);
  if (Object.hasOwn(comparison, 'expected_rules')) safe.expected_rules = sanitizeRules(comparison.expected_rules);
  return safe;
}

function sanitizeGuided(guided = {}) {
  const safe = redact({ ...guided, results: undefined });
  safe.results = (guided.results ?? []).map(result => {
    const cleaned = redact({ ...result, comparisons: undefined, expected: undefined });
    const comparisons = (result.comparisons ?? result.expected ?? []).map(sanitizeComparison);
    cleaned.comparisons = comparisons;
    if (Object.hasOwn(result, 'expected')) cleaned.expected = comparisons;
    return cleaned;
  });
  return safe;
}

function acceptance(result, comparison) {
  const status = comparison?.acceptance_status ?? result?.acceptance_status;
  if (comparison?.needs_review || result?.needs_review || status != null && statusOf(status) === 'review') return 'REVIEW';
  if (statusOf(status) === 'match') return 'PASS';
  if (statusOf(status) === 'mismatch') return 'FAIL';
  const declared = String(status ?? comparison?.verdict ?? result?.verdict ?? 'REVIEW').toUpperCase();
  return ['PASS', 'FAIL', 'NOT_EXECUTED'].includes(declared) ? declared : 'REVIEW';
}

function expectedForStep(step, cases) {
  const declared = step.expected_events ?? step.expected;
  if (Array.isArray(declared) && declared.length) return declared.map(expected => {
    const testCase = cases.find(candidate => candidate.id === expected.case_id);
    const rule = testCase?.rules?.find(candidate => candidate.event_name === expected.event_name) ?? testCase?.rules?.[0];
    return { expected_count: rule?.count, expected_payload_sample: testCase?.sample, expected_rules: rule, provenance: testCase?.provenance, ...expected };
  });
  const ids = step.expected_case_ids ?? step.case_ids ?? [];
  return ids.flatMap(id => {
    const testCase = cases.find(candidate => candidate.id === id);
    return (testCase?.rules ?? []).map(rule => ({ case_id: id, event_name: rule.event_name, source: rule.source ?? testCase.source, layer: rule.layer,
      expected_count: rule.count, expected_payload_sample: testCase.sample, expected_rules: rule, provenance: testCase.provenance }));
  });
}

function evidenceIds(comparison) {
  return [...new Set([...(comparison.evidence_ids ?? []), ...(comparison.actual_events ?? []).map(event => event.evidence_id)].filter(Boolean))];
}

function reportRows(plan, results, cases) {
  const steps = [], comparisons = [], parameters = [];
  const append = (step, result) => {
    const executed = Boolean(result);
    const stepStatus = executed ? statusOf(result.status ?? result.verdict) : 'not_executed';
    const stepAcceptance = executed ? acceptance(result) : 'NOT_EXECUTED';
    const context = result?.context ?? step.context ?? {};
    steps.push({ step_id: step.id, title: result?.title ?? step.title ?? step.id, instruction: step.instruction ?? '',
      status: stepStatus, acceptance_status: stepAcceptance, context, summary: result?.summary ?? '', ai_note: result?.ai_note ?? '' });
    const rows = executed ? result.comparisons ?? result.expected ?? [] : expectedForStep(step, cases);
    for (const row of rows) {
      const actualEvents = row.actual_events ?? [];
      const record = {
        step_id: step.id, step_title: result?.title ?? step.title ?? step.id, instruction: step.instruction ?? '', context,
        case_id: row.case_id ?? '', event_name: row.event_name ?? '', source: row.source ?? '', layer: row.layer ?? '',
        kind: 'expected_event', status: executed ? statusOf(row.status) : 'not_executed',
        acceptance_status: executed ? acceptance(result, row) : 'NOT_EXECUTED',
        expected_count: row.expected_count ?? '', actual_count: executed ? row.actual_count ?? actualEvents.length : null,
        actual_event_names: [...new Set(actualEvents.map(event => event.event_name).filter(Boolean))],
        expected_payload_sample: row.expected_payload_sample ?? row.expected_payload ?? null,
        expected_rules: row.expected_rules ?? {},
        actual_payloads: actualEvents.length ? actualEvents.map(event => event.payload) : row.actual_payload === undefined ? [] : [row.actual_payload],
        evidence_ids: evidenceIds(row), issues: row.issues ?? [], provenance: row.provenance ?? null,
      };
      comparisons.push(record);
      for (const parameter of row.parameters ?? []) parameters.push({ step_id: step.id, event_name: record.event_name, source: record.source,
        layer: record.layer, acceptance_status: record.acceptance_status, ...parameter });
    }
    for (const extra of result?.unexpected_events ?? result?.extra_events ?? []) {
      const event = extra.event ?? extra;
      comparisons.push({ step_id: step.id, step_title: result?.title ?? step.title ?? step.id, instruction: step.instruction ?? '', context,
        case_id: '', event_name: '', source: event.source ?? extra.source ?? '', layer: event.layer ?? extra.layer ?? '', kind: 'extra_event',
        status: 'extra', acceptance_status: acceptance(result), expected_count: 0, actual_count: extra.actual_count ?? extra.count ?? 1,
        actual_event_names: [event.event_name ?? extra.event_name ?? 'unknown'], expected_payload_sample: null, expected_rules: {},
        actual_payloads: event.payload === undefined ? [] : [event.payload], evidence_ids: [event.evidence_id ?? extra.evidence_id].filter(Boolean),
        issues: extra.issues ?? [{ code: extra.reason ?? extra.code ?? 'EXTRA_EVENT', verdict: 'REVIEW' }], provenance: null });
    }
  };
  const consumed = new Set();
  for (const step of plan.steps ?? []) {
    const matching = results.filter(result => (result.plan_step_id ?? result.step_id) === step.id);
    for (const result of matching) consumed.add(result);
    append(step, matching.at(-1));
  }
  // Retain evidence from a recovered/older plan instead of silently dropping it.
  for (const result of results) if (!consumed.has(result)) append({ id: result.plan_step_id ?? result.step_id, title: result.title }, result);
  return { steps, comparisons, parameters };
}

function cellValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  let text = valueText(value);
  if (text.length > 32000) text = `[TRUNCATED: xem comparison.json để đọc đầy đủ]\n${text.slice(0, 31900)}`;
  return /^[\s]*[=+@\-\t\r]/.test(text) ? `'${text}` : text;
}

function addSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = columns.map(([header, width]) => ({ header, width }));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: columns.length } };
  sheet.getRow(1).height = 30;
  sheet.getRow(1).eachCell(cell => {
    cell.font = { name: 'Calibri', bold: true, color: { argb: 'FFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '343B75' } };
  });
  for (const values of rows) {
    const row = sheet.addRow(values.map(cellValue));
    row.height = Math.min(180, Math.max(34, Math.max(...values.map(value => valueText(value).split('\n').length), 1) * 15));
    row.eachCell(cell => { cell.alignment = { vertical: 'top', wrapText: true }; cell.font = { name: 'Calibri', size: 11 }; });
  }
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

const issueText = issue => `${issue.code ?? issue.message ?? ''}${issue.path ? ` · ${issue.path}` : ''}`;
function markdownFindings(data) {
  const sections = [];
  for (const row of data.comparisons) {
    const parameterProblems = data.parameters.filter(parameter => parameter.step_id === row.step_id && parameter.event_name === row.event_name
      && parameter.source === row.source && ['missing', 'mismatch', 'error'].includes(statusOf(parameter.status)));
    const hasConcreteIssue = ['missing', 'mismatch', 'error'].includes(row.status) || parameterProblems.length;
    if (!hasConcreteIssue && row.kind !== 'extra_event') continue;
    const heading = row.kind === 'extra_event' ? 'Event ngoài danh sách mong muốn' : row.acceptance_status === 'FAIL' ? 'Lỗi đã xác nhận' : 'Phát hiện cần xác nhận';
    sections.push(`## ${heading}: ${row.source} · ${row.event_name || row.actual_event_names.join(', ')}\n\nBước: ${row.step_title}\n\nThao tác: ${row.instruction}\n\nKiểm tra dữ liệu: ${statusLabel(row.status)}\n\nNghiệm thu: ${row.acceptance_status}\n\nMong muốn: ${row.event_name || '(không có trong danh sách bước)'} — số lần ${valueText(row.expected_count)}\n\nThực tế: ${row.actual_event_names.join(', ') || '(chưa thấy)'} — số lần ${valueText(row.actual_count)}\n\nContext đã dùng:\n\n\`\`\`json\n${JSON.stringify(row.context, null, 2)}\n\`\`\`\n\n${parameterProblems.map(parameter => `- ${parameter.path}: ${statusLabel(parameter.status)}; mong đợi ${valueText(parameter.expected)}, thực tế ${valueText(parameter.actual)} (${parameter.code ?? ''})`).join('\n')}\n\nEvidence: ${row.evidence_ids.join(', ') || '(bằng chứng bước)'}\n\n${row.issues.map(issueText).join('\n')}\n\n${row.kind === 'extra_event' ? 'Event bổ sung cần đối chiếu phạm vi requirement trước khi kết luận lỗi.' : row.acceptance_status !== 'FAIL' ? 'Chưa coi đây là lỗi nghiệm thu khi yêu cầu hoặc dữ liệu đối chiếu còn cần duyệt.' : ''}`);
  }
  return '# Đối chiếu tracking — mong muốn và thực tế\n\n' + (sections.join('\n\n---\n\n') || 'Chưa có lỗi đã xác nhận hoặc event ngoài danh sách. Bước chưa thực hiện không được coi là FAIL.\n');
}

/** Export only the simple guided comparison; retain vendor/layer evidence explicitly. */
export async function exportGuidedReports({ session = {}, events = [], cases = [] }, outputDir) {
  const safeSession = redact({ ...session, guided: undefined });
  if (/^S-/.test(session.session_id ?? '')) safeSession.session_id = session.session_id;
  const guided = sanitizeGuided(session.guided ?? {});
  const safeCases = sanitizeCases(cases);
  const safeEvents = events.map(event => {
    const cleaned = redact(event);
    if (/^S-/.test(event.session_id ?? '')) cleaned.session_id = event.session_id;
    return cleaned;
  });
  const data = { report_version: 'guided-1.0', session: safeSession, guided,
    ...reportRows(guided.plan ?? {}, guided.results ?? [], safeCases), events: safeEvents };
  const directory = path.resolve(outputDir);
  await fs.mkdir(directory, { recursive: true });
  const files = Object.fromEntries(Object.entries({ xlsx: 'report.xlsx', html: 'report.html', json: 'comparison.json', bugs: 'bugs.md' }).map(([key, name]) => [key, path.join(directory, name)]));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'EventQA'; workbook.created = new Date();
  addSheet(workbook, 'Tổng quan', [['Nội dung', 30], ['Giá trị', 95]], [
    ['Phiên', safeSession.id ?? safeSession.session_id], ['Website', safeSession.target_url ?? safeSession.environment], ['Luồng', guided.plan?.flow],
    ['Kịch bản', guided.plan?.title], ['Số bước', data.steps.length], ['Đã thực hiện', data.steps.filter(step => step.status !== 'not_executed').length],
    ['Chưa thực hiện', data.steps.filter(step => step.status === 'not_executed').length],
    ['Bước nghiệm thu FAIL', data.steps.filter(step => step.acceptance_status === 'FAIL').length],
    ['Bước cần kiểm tra', data.steps.filter(step => step.acceptance_status === 'REVIEW').length],
    ['Lưu ý', 'Khớp phần đã kiểm không xác nhận mọi giá trị nghiệp vụ. Param bổ sung không mặc định là lỗi. Queue, SDK và request là các bằng chứng riêng; HTTP không xác nhận vendor ingestion.'],
  ]);
  addSheet(workbook, 'Các bước', [['Bước', 28], ['Hướng dẫn thao tác', 65], ['Kiểm tra dữ liệu', 24], ['Nghiệm thu', 18], ['Context', 55], ['Nhận xét', 65]],
    data.steps.map(step => [step.title, step.instruction, statusLabel(step.status), acceptanceLabel(step.acceptance_status), step.context, step.summary]));
  addSheet(workbook, 'Đối chiếu event', [['Bước', 28], ['Vendor', 14], ['Tầng', 23], ['Event mong muốn', 30], ['Event thực tế', 30], ['Số lần mong muốn', 22], ['Số lần thực tế', 17], ['Kiểm tra dữ liệu', 24], ['Nghiệm thu', 18], ['Payload mẫu tham khảo', 70], ['Quy tắc mong muốn', 70], ['Payload thực tế', 70], ['Vấn đề', 60], ['Evidence', 44]],
    data.comparisons.map(row => [row.step_title, row.source, row.layer, row.event_name || '(ngoài danh sách)', row.actual_event_names.join('\n') || '(chưa thấy)', countLabel(row.expected_count), row.actual_count,
      statusLabel(row.status), acceptanceLabel(row.acceptance_status), row.expected_payload_sample, row.expected_rules, row.actual_payloads, row.issues.map(issueText).join('\n'), row.evidence_ids.join('\n')]));
  addSheet(workbook, 'Đối chiếu params', [['Bước ID', 30], ['Event', 28], ['Vendor', 14], ['Tầng', 23], ['Param', 45], ['Mong muốn', 60], ['Thực tế', 60], ['Kiểm tra dữ liệu', 24], ['Phép kiểm', 17], ['Mã vấn đề', 30], ['Nghiệm thu', 18], ['Evidence', 44]],
    data.parameters.map(parameter => [parameter.step_id, parameter.event_name, parameter.source, parameter.layer, parameter.path, parameter.expected, parameter.actual,
      statusLabel(parameter.status), parameter.constraint ?? parameter.op, parameter.code, acceptanceLabel(parameter.acceptance_status), parameter.evidence_id]));
  addSheet(workbook, 'Bằng chứng thực tế', [['Evidence', 44], ['Thời gian UTC', 27], ['Event thực tế', 30], ['Vendor', 14], ['Tầng', 23], ['Queue / nguồn', 25], ['Request phase', 19], ['Trang', 65], ['Payload thực tế', 90]],
    safeEvents.map(event => [event.evidence_id, event.captured_at, event.event_name, event.source, event.layer, event.queue_name ?? '', event.network?.phase ?? '', event.page?.url ?? '', event.original_payload ?? event.payload]));
  await workbook.xlsx.writeFile(files.xlsx);
  await fs.writeFile(files.json, JSON.stringify(data, null, 2), 'utf8');
  const sections = data.steps.map(step => {
    const rows = data.comparisons.filter(row => row.step_id === step.step_id);
    return `<section><h2>${escapeHtml(step.title)}</h2><p>${escapeHtml(step.instruction)}</p><p><strong>${escapeHtml(statusLabel(step.status))}</strong> · Nghiệm thu: ${escapeHtml(step.acceptance_status)}</p><p>${escapeHtml(step.summary)}</p>${rows.map(row => {
      const parameters = data.parameters.filter(parameter => parameter.step_id === row.step_id && parameter.event_name === row.event_name && parameter.source === row.source);
      return `<article><h3>${escapeHtml(row.source)} · ${escapeHtml(row.event_name || '(event ngoài danh sách)')}</h3><table><thead><tr><th>Mong muốn</th><th>Thực tế</th><th>Đối chiếu</th></tr></thead><tbody><tr><td>${escapeHtml(row.event_name || '(không có trong danh sách)')}<br>Số lần: ${escapeHtml(row.expected_count)}</td><td>${escapeHtml(row.actual_event_names.join(', ') || '(chưa thấy)')}<br>Số lần: ${escapeHtml(row.actual_count)}</td><td>${escapeHtml(statusLabel(row.status))}<br>Nghiệm thu: ${escapeHtml(row.acceptance_status)}</td></tr></tbody></table>${parameters.length ? `<table><thead><tr><th>Param</th><th>Mong muốn</th><th>Thực tế</th><th>Kết quả</th></tr></thead><tbody>${parameters.map(parameter => `<tr><td>${escapeHtml(parameter.path)}</td><td><pre>${escapeHtml(parameter.expected)}</pre>${parameter.constraint ? `<small>Quy tắc: ${escapeHtml(parameter.constraint)}</small>` : ''}</td><td><pre>${escapeHtml(parameter.actual)}</pre></td><td>${escapeHtml(statusLabel(parameter.status))}<br>${escapeHtml(parameter.code)}</td></tr>`).join('')}</tbody></table>` : ''}<details><summary>Payload mẫu và tracking thực tế · ${escapeHtml(row.evidence_ids.join(', '))}</summary><div class="payloads"><div><h4>Mẫu tham khảo — không phải actual</h4><pre>${escapeHtml(JSON.stringify(row.expected_payload_sample, null, 2))}</pre></div><div><h4>Tracking thực tế</h4><pre>${escapeHtml(JSON.stringify(row.actual_payloads, null, 2))}</pre></div></div></details></article>`;
    }).join('')}</section>`;
  }).join('');
  await fs.writeFile(files.html, `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Đối chiếu tracking</title><style>body{font:15px system-ui;color:#24304d;background:#f6f7fc;margin:24px auto;padding:0 20px;max-width:1200px}h1{font-size:26px}section,article{background:white;border:1px solid #dde1ef;border-radius:12px;padding:18px;margin:18px 0}article{background:#fafbff}table{border-collapse:collapse;width:100%;margin:12px 0;table-layout:fixed}th,td{border:1px solid #dce1ee;padding:10px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#eef0fb}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font-size:12px}.payloads{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:18px}summary{cursor:pointer}.note{color:#61708b}</style><h1>Tracking mong muốn và thực tế</h1><p>${escapeHtml(guided.plan?.title)} · ${escapeHtml(guided.plan?.flow)}</p><p>${escapeHtml(safeSession.target_url ?? safeSession.environment)}</p><p class="note">Khớp phần đã kiểm không xác nhận mọi giá trị nghiệp vụ. Param bổ sung không mặc định là lỗi. Queue, SDK và request là các bằng chứng riêng; HTTP không xác nhận vendor ingestion.</p>${sections}</html>`, 'utf8');
  await fs.writeFile(files.bugs, markdownFindings(data), 'utf8');
  return files;
}
