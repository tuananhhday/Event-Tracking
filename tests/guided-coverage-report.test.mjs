import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { buildGuidedPlan, assessGuidedStep } from '../src/core/guided.mjs';
import { exportGuidedReports } from '../src/report/guided.mjs';

const target = 'https://uat.example.test/vi/golf';
const startedAt = '2026-10-30T00:00:00Z', completedAt = '2026-10-30T00:00:10Z';
const requirement = (id, field = { op: 'eq', value: 'golf' }, extra = {}) => ({
  id, name: id, flow: 'Golf', source: 'GA4', target_platform: 'WEB', needs_review: false,
  description: `Thao tác ${id}`, provenance: { sheet: 'Golf', row: id },
  sample: { event: `search_${id.toLowerCase()}`, service: 'golf' },
  rules: [{ event_name: `search_${id.toLowerCase()}`, layer: 'JS_QUEUE', fields: { service: field }, count: { min: 1, max: 1 }, needs_review: false }],
  ...extra,
});
async function outputDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-coverage-report-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
const checked = (plan, row, cases, service) => assessGuidedStep({
  step: plan.steps.find(step => step.case_ids.includes(row.id)), cases, startedAt, completedAt, expectedUrl: target,
  events: service === undefined ? [] : [{ evidence_id: `E-${row.id}`, source: 'GA4', layer: 'JS_QUEUE', queue_name: 'dataLayer',
    event_name: row.rules[0].event_name, page: { url: target }, captured_at: '2026-10-30T00:00:01Z',
    payload: { event: row.rules[0].event_name, service } }],
});

test('selected scope exports fresh reconciled coverage and leaves unselected requirements out of missing-event findings', async t => {
  const cases = [requirement('EXACT'), requirement('TYPE', { op: 'type', value: 'string' }), requirement('MISSING'), requirement('WRONG'),
    requirement('SKIP'), requirement('WAIT'), requirement('EXCLUDED'), requirement('COMMON', undefined, { flow: 'All luồng' }),
    requirement('FLIGHT', undefined, { flow: 'Flight' }), { id: 'INVALID', flow: 'Golf', name: 'Unparsed source row' }];
  const plan = buildGuidedPlan(cases, { flow: 'Golf', url: target, selectedCaseIds: ['EXACT', 'TYPE', 'MISSING', 'WRONG', 'SKIP', 'WAIT'] });
  const results = [checked(plan, cases[0], cases, 'golf'), checked(plan, cases[1], cases, 'golf'), checked(plan, cases[2], cases), checked(plan, cases[3], cases, 'flight'),
    { step_id: plan.steps.find(step => step.case_ids.includes('SKIP')).id, status: 'not_executed', verdict: 'NOT_EXECUTED', comparisons: [] }];
  const paths = await exportGuidedReports({ cases, session: { target_url: target, guided: { plan, results,
    selection: { selected_case_ids: ['EXCLUDED'] }, completeness: { selected: 999, complete: true } } } }, await outputDirectory(t));
  const data = JSON.parse(await fs.readFile(paths.json, 'utf8'));
  const c = data.scope.completeness;
  assert.deepEqual({ selected: c.selected, executed: c.executed, skipped: c.skipped, remaining: c.remaining, excluded: c.excluded, out_of_scope: c.out_of_scope },
    { selected: 6, executed: 4, skipped: 1, remaining: 1, excluded: 2, out_of_scope: 2 });
  assert.equal(c.selected, c.executed + c.skipped + c.remaining);
  assert.equal(c.complete, false);
  assert.deepEqual(data.guided.completeness, c, 'saved stale coverage is replaced with coverage derived from actual results');
  assert.deepEqual(data.guided.selection, plan.selection);
  assert.deepEqual(data.scope.requirements.map(row => [row.case_id, row.status]), [
    ['EXACT', 'verified'], ['TYPE', 'checked_unverified'], ['MISSING', 'missing'], ['WRONG', 'mismatch'],
    ['SKIP', 'skipped'], ['WAIT', 'not_run'], ['EXCLUDED', 'excluded'], ['COMMON', 'excluded'], ['FLIGHT', 'out_of_scope'], ['INVALID', 'out_of_scope'],
  ]);
  assert.equal(data.scope.parameter_totals.total_parameters, 6);
  assert.equal(data.scope.parameter_totals.checked_parameters, 3);
  assert.equal(data.scope.parameter_totals.verified_parameters, 1);
  assert.equal(data.scope.parameter_totals.unverified_parameters, 4);
  assert.equal(data.scope.parameter_totals.wrong_parameters, 1);
  assert.equal(data.scope.parameter_check_totals.total, 3);
  assert.equal(data.comparisons.length, 6, 'all selected events remain visible, including skipped and pending ones');
  assert.equal(data.comparisons.find(row => row.case_id === 'SKIP').acceptance_status, 'NOT_EXECUTED');
  assert.equal(data.comparisons.find(row => row.case_id === 'WAIT').actual_count, null);
  assert.equal(data.comparisons.filter(row => row.status === 'missing').length, 1);
  assert.ok(data.comparisons.every(row => !['EXCLUDED', 'COMMON', 'FLIGHT', 'INVALID'].includes(row.case_id)));
  const html = await fs.readFile(paths.html, 'utf8');
  assert.ok(html.includes('Đã chọn 6 · đã chạy 4 · bỏ qua 1 · chưa chạy 1 · không chọn 2 · ngoài luồng 2'));
  assert.ok(html.includes('Chưa đủ căn cứ cho toàn bộ yêu cầu đã chọn.'));
  assert.ok(html.includes('Param yêu cầu được đếm theo đường dẫn'));
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(paths.xlsx);
  const scope = workbook.getWorksheet('Phạm vi kiểm');
  assert.equal(scope.rowCount, 11);
  assert.equal(scope.getCell('F3').value, 'Đã kiểm, còn giá trị chưa xác minh');
  assert.equal(scope.getCell('J3').value, 1);
  assert.equal(scope.getCell('K3').value, 0);
  assert.equal(scope.getCell('L3').value, 1);
  assert.equal(scope.getCell('F8').value, 'Không chọn');
  const overview = workbook.getWorksheet('Tổng quan').getSheetValues();
  assert.equal(overview.find(row => row?.[1] === 'Yêu cầu đã chọn')[2], 6);
  assert.equal(overview.find(row => row?.[1] === 'Đủ căn cứ toàn bộ phạm vi đã chọn')[2], 'Chưa');
  const bugs = await fs.readFile(paths.bugs, 'utf8');
  assert.ok(!bugs.includes('search_excluded') && !bugs.includes('search_flight') && !bugs.includes('search_skip') && !bugs.includes('search_wait'));
});

test('selection-aware scope retains redaction, HTML escaping and formula safety on source metadata', async t => {
  const email = 'private-qc@example.test', formula = '=HYPERLINK("https://unsafe.example")';
  const cases = [requirement(formula, { op: 'eq', value: email }, { source: 'INSIDER', provenance: { sheet: '<script>scope()</script>', row: 8 },
    rules: [{ event_name: '<script>event()</script>', layer: 'JS_QUEUE', fields: { email: { op: 'eq', value: email } } }] })];
  const plan = buildGuidedPlan(cases, { flow: 'Golf', url: target, selectedCaseIds: [formula] });
  const paths = await exportGuidedReports({ cases, session: { guided: { plan, results: [] } } }, await outputDirectory(t));
  const json = await fs.readFile(paths.json, 'utf8'), html = await fs.readFile(paths.html, 'utf8');
  assert.ok(!json.includes(email) && !html.includes(email));
  assert.ok(!html.includes('<script>scope()</script>') && !html.includes('<script>event()</script>'));
  assert.ok(html.includes('&lt;script&gt;scope()&lt;/script&gt;'));
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(paths.xlsx);
  const idCell = workbook.getWorksheet('Phạm vi kiểm').getCell('A2');
  assert.equal(idCell.type, ExcelJS.ValueType.String);
  assert.equal(idCell.value, "'" + formula);
  const values = [];
  workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => values.push(String(cell.value)))));
  assert.ok(!values.join('\n').includes(email));
});
