import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionManager, loadRun } from '../src/core/session.mjs';
import { comparisonCoverage } from '../src/core/comparison.mjs';
import { prepareReportData } from '../src/report/export.mjs';
import { exportSelection } from '../src/report/selection.mjs';
import { trackingSection } from '../src/report/models.mjs';
import { createApp } from '../src/server.mjs';

const spec = (id, flow, service) => ({ id, name: 'page_view', source: 'INSIDER', flow, sample: { event: 'page_view', default_parameters: { service } }, rules: [
  { source: 'INSIDER', layer: 'TRACKING_REQUEST', event_name: 'page_view', fields: { 'default_parameters.service': { op: 'eq', value: service } } },
] });
const cases = [spec('HOTEL', 'Khách sạn', 'hotel'), spec('MERCH', 'Đồ lưu niệm', 'merch')];
const observed = (service = 'hotel', other = {}) => ({ source: 'INSIDER', layer: 'TRACKING_REQUEST', event_name: 'page_view', payload: { event: 'page_view', default_parameters: { service } }, page: { target_id: 'TAB', url: 'https://example.test/hotel' }, ...other });
async function managerFor(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-flow-selection-'));
  const manager = new SessionManager({ runsDir: dir, cases: structuredClone(cases) });
  t.after(async () => { manager.abort(); await fs.rm(dir, { recursive: true, force: true }); });
  manager.start(); return manager;
}
const coverage = manager => comparisonCoverage(manager.cases, manager.snapshot().events, manager.session.spec_comparison, { steps: manager.steps });

test('imported rows stay neutral until an explicit flow choice; evidence from before selection never matches', async t => {
  const manager = await managerFor(t), before = manager.emit(observed());
  assert.ok(coverage(manager).rows.every(row => row.status === 'NOT_SELECTED'));
  assert.equal(coverage(manager).unmatched.length, 0);
  manager.startComparison('Khách sạn');
  assert.equal(coverage(manager).rows.length, 1); assert.equal(coverage(manager).rows[0].status, 'NOT_SEEN');
  assert.equal(before.comparison_attempt_id, null);
  manager.emit(observed());
  assert.equal(coverage(manager).rows[0].case_id, 'HOTEL'); assert.equal(coverage(manager).rows[0].status, 'MATCH');
  manager.startComparison('Đồ lưu niệm');
  assert.equal(coverage(manager).rows[0].case_id, 'MERCH'); assert.equal(coverage(manager).rows[0].status, 'NOT_SEEN');
  manager.emit(observed('hotel', { historical: true }));
  assert.equal(coverage(manager).rows[0].status, 'NOT_SEEN');
  manager.emit(observed('merch'));
  assert.equal(coverage(manager).rows[0].status, 'MATCH');
});

test('retesting isolates failures and reports the latest attempt, including selected flows with no evidence', async t => {
  const manager = await managerFor(t);
  manager.startComparison('Khách sạn'); manager.emit(observed('merch'));
  assert.equal(coverage(manager).rows[0].status, 'MISMATCH');
  const first = manager.session.spec_comparison.active_id;
  manager.startComparison('Khách sạn'); assert.equal(coverage(manager).rows[0].seen, 0);
  manager.emit(observed());
  manager.startComparison('Đồ lưu niệm'); manager.stopComparison();
  manager.emit(observed('merch'));
  const prepared = prepareReportData(manager.snapshot());
  assert.deepEqual(prepared.report.map(row => [row.key, row.status]), [['HOTEL', 'MATCH'], ['MERCH', 'NOT_SEEN']]);
  const files = await exportSelection(manager.snapshot(), manager.runDir, { contents: ['events'], formats: ['json'] });
  const report = JSON.parse(await fs.readFile(files.json, 'utf8'));
  assert.deepEqual(report.counts, { PASS: 1, FAIL: 0, REVIEW: 0, NOT_EXECUTED: 1 });
  assert.equal(manager.snapshot().events[0].comparison_attempt_id, first);
  manager.finish();
  const saved = loadRun(manager.runDir);
  assert.equal(saved.session.spec_comparison.attempts.length, 3);
  assert.deepEqual(prepareReportData(saved).report.map(row => row.status), ['MATCH', 'NOT_SEEN']);
});

test('changing evidence is limited to the same attempt and vendor, compares actual names, and can return to auto', async t => {
  const manager = await managerFor(t);
  manager.startComparison('Khách sạn'); const old = manager.emit(observed());
  manager.startComparison('Khách sạn'); const correct = manager.emit(observed());
  assert.throws(() => manager.selectComparisonEvent('HOTEL', old.evidence_id), /lượt đối chiếu/);
  const wrongVendor = manager.emit(observed('hotel', { source: 'GA4' }));
  assert.throws(() => manager.selectComparisonEvent('HOTEL', wrongVendor.evidence_id), /nền tảng/);
  const otherName = manager.emit(observed('hotel', { event_name: 'checkout', payload: { event: 'checkout', default_parameters: { service: 'hotel' } } }));
  manager.selectComparisonEvent('HOTEL', otherName.evidence_id);
  assert.equal(coverage(manager).rows[0].status, 'MISMATCH');
  assert.ok(coverage(manager).rows[0].issues.some(issue => issue.code === 'EVENT_NAME_MISMATCH'));
  assert.match(prepareReportData(manager.snapshot()).report[0].comment, /event_name.*checkout/);
  manager.selectComparisonEvent('HOTEL', correct.evidence_id);
  assert.equal(coverage(manager).rows[0].status, 'MATCH'); assert.equal(coverage(manager).rows[0].manual, true);
  manager.selectComparisonEvent('HOTEL', null); assert.equal(coverage(manager).rows[0].manual, undefined);
});

test('late network responses retain the request attempt; automation steps explicitly scope their cases', async t => {
  const manager = await managerFor(t);
  const first = manager.startComparison('Khách sạn');
  manager.emit(observed('hotel', { network: { request_id: 'REQ', phase: 'request' } }));
  manager.startComparison('Đồ lưu niệm');
  const response = manager.emit(observed('hotel', { network: { request_id: 'REQ', phase: 'response', status: 204 } }));
  assert.equal(response.comparison_attempt_id, first.id); assert.equal(coverage(manager).rows[0].seen, 0);
  manager.startStep('HOTEL'); manager.emit(observed()); manager.completeStep();
  assert.equal(manager.session.spec_comparison.active_id, null);
  assert.equal(coverage(manager).rows[0].case_id, 'HOTEL'); assert.equal(coverage(manager).rows[0].status, 'MATCH');
});

test('tracking inventory exports observed names and every occurrence independently of spec comparison', async t => {
  const manager = await managerFor(t);
  manager.emit(observed()); manager.emit(observed());
  manager.emit(observed('hotel', { network: { phase: 'response', status: 204 } }));
  manager.emit(observed('hotel', { event_name: 'insider_init' }));
  const section = trackingSection(manager.snapshot().events);
  assert.equal(section.rows.length, 1); assert.equal(section.rows[0].count, 2);
  const files = await exportSelection(manager.snapshot(), manager.runDir, { contents: ['tracking'], formats: ['json', 'xlsx', 'html'] });
  const json = JSON.parse(await fs.readFile(files.tracking_json, 'utf8'));
  assert.equal(json.inventory[0].details['Các lần xuất hiện'].length, 2);
  assert.ok((await fs.readFile(files.tracking_html, 'utf8')).includes('page_view'));
  assert.deepEqual(prepareReportData(manager.snapshot()).report, []);
});

test('comparison HTTP routes require a chosen flow and expose only its candidates; unchosen details have no spec verdict', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-flow-http-'));
  const app = await createApp({ port: 0, runsDir: dir, initialCases: structuredClone(cases) }); const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  app.manager.start(); const before = app.manager.emit(observed());
  const post = async (route, data = {}) => { const response = await fetch(`${base}/api/comparison/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': app.csrf }, body: JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  assert.equal((await (await fetch(`${base}/api/event?id=${before.evidence_id}`)).json()).spec, null);
  assert.equal((await post('retest')).status, 400);
  assert.equal((await post('start', { flow: 'Khách sạn' })).status, 200);
  const current = app.manager.emit(observed());
  const candidates = await (await fetch(`${base}/api/comparison/candidates?case_id=HOTEL`)).json();
  assert.deepEqual(candidates.events.map(event => event.evidence_id), [current.evidence_id]);
  assert.equal((await post('event', { case_id: 'HOTEL', evidence_id: before.evidence_id })).status, 400);
  assert.equal((await post('event', { case_id: 'HOTEL', evidence_id: current.evidence_id })).status, 200);
  const detail = await (await fetch(`${base}/api/event?id=${current.evidence_id}&case_id=HOTEL`)).json();
  assert.equal(detail.spec.verdict, 'PASS');
  assert.equal((await post('retest')).body.specCoverage.rows[0].status, 'NOT_SEEN');
});
