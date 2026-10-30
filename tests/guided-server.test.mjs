import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { queueEvents } from '../src/collectors/cdp.mjs';
import { loadRun } from '../src/core/session.mjs';
import ExcelJS from 'exceljs';
import { importSpec } from '../src/spec/import.mjs';

const cases = [
  { id: 'G-GA4', name: 'Search', source: 'GA4', flow: 'Golf', description: 'Tìm sân golf và mở kết quả.', needs_review: false,
    sample: { event: 'search_submit', service: 'golf', destination: 'Sample' }, rules: [{ event_name: 'search_submit', layer: 'JS_QUEUE', fields: {
      event: { op: 'eq', value: 'search_submit' }, service: { op: 'eq', value: 'golf' }, destination: { op: 'ref', value: 'context.search.destination_name' },
    } }] },
  { id: 'G-INS', name: 'Insider search', source: 'INSIDER', flow: 'Golf', description: 'Tìm sân golf và mở kết quả.', needs_review: false,
    sample: { type: 'custom_event', value: [{ event_name: 'search_golf' }] }, rules: [{ event_name: 'search_golf', layer: 'JS_QUEUE', fields: { type: { op: 'eq', value: 'custom_event' } } }] },
  { id: 'G-FAIL', name: 'Failed payment', source: 'GA4', flow: 'Golf', description: 'Nhánh thanh toán thất bại.', rules: [{ event_name: 'purchase_fail', layer: 'JS_QUEUE', fields: { event: { op: 'eq', value: 'purchase_fail' } } }] },
];
const target = 'https://uat.example.test/vi/golf';
const proposal = { title: 'Kiểm tra Golf', steps: [
  { title: 'Tìm sân', instruction: 'Nhấn tìm kiếm sân golf.', expected_case_ids: ['G-GA4', 'G-INS'] },
  { title: 'Thanh toán lỗi', instruction: 'Kiểm tra nhánh thanh toán lỗi khi có kịch bản tương ứng.', expected_case_ids: ['G-FAIL'], optional: true, branch: 'failure' },
] };
async function fixture(t, available = true, initialCases = cases) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-guided-server-'));
  const aiInputs = [];
  const ai = { modelSpec: 'auto', close() {}, diagnostics: () => ({ enabled: true, configured_key_count: 1 }),
    async complete(_model, _system, input, _schema, validate) {
      aiInputs.push(input);
      const ids = new Set(input.requirements.map(r => r.id));
      const steps = proposal.steps.map(s => ({ ...s, expected_case_ids: s.expected_case_ids.filter(id => ids.has(id)) })).filter(s => s.expected_case_ids.length);
      const planned = new Set(steps.flatMap(s => s.expected_case_ids));
      for (const r of input.requirements.filter(r => !planned.has(r.id))) steps.push({ title: r.id, instruction: r.trigger || 'Thực hiện yêu cầu đã chọn.', expected_case_ids: [r.id] });
      const selectedPlan = { ...proposal, steps };
      assert.equal(validate(selectedPlan), null);
      return available ? { available: true, data: selectedPlan, routing: { model: 'mock/free' } } : { available: false, reason: 'OPENROUTER_UNAVAILABLE' };
    },
    async explain() { return { available: true, note: 'Điểm đến tracking khác lựa chọn trong bước.', routing: { model: 'mock/free' } }; } };
  const app = await createApp({ mode: 'cdp-ai', port: 0, runsDir: dir, initialCases: structuredClone(initialCases), aiClient: ai });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const post = async (route, data = {}, token = app.csrf) => {
    const response = await fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': token }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  };
  // Reuse an existing controlled capture, exactly as switching from diagnostics
  // into guided mode does. Tests emit synthetic observations, never visit UAT.
  app.manager.start({ target_url: target, capture_queues: true });
  return { app, base, post, aiInputs };
}

test('invalid or App selections fail before AI planning and never silently expand the chosen scope', async t => {
  const flight = { ...cases[0], id: 'F-GA4', flow: 'Flight' };
  const mobile = { ...cases[0], id: 'MOBILE', target_platform: 'APP' };
  const { app, post, aiInputs } = await fixture(t, true, [...cases, flight, mobile]);
  for (const ids of [undefined, [], ['unknown'], ['G-GA4', 'G-GA4'], ['F-GA4'], ['G-GA4', 'MOBILE']]) {
    const response = await post('guided/plan', { url: target, flow: 'Golf', selectedCaseIds: ids });
    assert.equal(response.status, 400, JSON.stringify(ids));
    assert.ok(response.data.error);
  }
  assert.equal(aiInputs.length, 0);
  assert.equal(app.state().guided.plan, null);
});

test('selected-only API sends full requirements to AI and persists truthful unrun and excluded coverage', async t => {
  const common = { ...cases[0], id: 'COMMON', flow: 'All luồng' };
  const flight = { ...cases[0], id: 'FLIGHT', flow: 'Flight' };
  const { app, base, post, aiInputs } = await fixture(t, true, [...cases, common, flight]);
  const planned = await post('guided/plan', { url: target, flow: 'Golf', selectedCaseIds: ['G-GA4', 'COMMON'] });
  assert.equal(planned.status, 200);
  const guide = planned.data.guided;
  assert.deepEqual(guide.plan.case_ids, ['G-GA4', 'COMMON']);
  assert.deepEqual(aiInputs[0].requirements.map(r => r.id), ['G-GA4', 'COMMON']);
  assert.deepEqual(aiInputs[0].requirements[0].events[0].parameter_requirements, cases[0].rules[0].fields);
  assert.deepEqual(guide.plan.selection.excluded_case_ids, ['G-INS', 'G-FAIL']);
  assert.deepEqual(guide.plan.selection.out_of_scope_case_ids, ['FLIGHT']);
  assert.equal(guide.completeness.selected, 2); assert.equal(guide.completeness.remaining, 2);
  await post('guided/step/skip', { stepId: guide.plan.steps[0].id });
  const finished = await post('guided/finish');
  assert.equal(finished.status, 200);
  assert.equal(finished.data.guided.completeness.skipped, 1);
  assert.equal(finished.data.guided.completeness.remaining, 1);
  assert.equal(finished.data.guided.completeness.complete, false);
  const saved = loadRun(app.manager.runDir);
  assert.deepEqual(saved.session.guided.selection.selected_case_ids, ['G-GA4', 'COMMON']);
  assert.equal(saved.session.guided.completeness.executed, 0);
  const report = await (await fetch(base + finished.data.exported.json)).json();
  assert.equal(report.scope.completeness.selected, 2);
  assert.equal(report.scope.completeness.skipped, 1);
  assert.equal(report.scope.completeness.remaining, 1);
});

test('common requirements are not included unless selected explicitly', async t => {
  const { post, aiInputs } = await fixture(t, true, [...cases, { ...cases[0], id: 'COMMON', flow: 'All luồng' }]);
  const planned = await post('guided/plan', { url: target, flow: 'Golf', selectedCaseIds: ['G-GA4'] });
  assert.equal(planned.status, 200);
  assert.deepEqual(aiInputs[0].requirements.map(r => r.id), ['G-GA4']);
  assert.deepEqual(planned.data.guided.plan.case_ids, ['G-GA4']);
  assert.ok(planned.data.guided.plan.selection.excluded_case_ids.includes('COMMON'));
});

test('guided API guides an action, checks exact sources, shows expected/actual and exports the same evidence', async t => {
  const { app, base, post } = await fixture(t);
  assert.equal((await post('guided/plan', { url: target, flow: 'Golf', selectedCaseIds: cases.map(c => c.id) }, 'wrong')).status, 403);
  const planned = await post('guided/plan', { url: target, flow: 'Golf', selectedCaseIds: cases.map(c => c.id) });
  assert.equal(planned.status, 200);
  assert.equal(planned.data.guided.plan.guidance_source, 'ai');
  assert.equal(planned.data.guided.plan.steps.length, 2);
  const [step, optional] = planned.data.guided.plan.steps;
  app.manager.emit({ source: 'GA4', layer: 'JS_QUEUE', queue_name: 'dataLayer', event_name: 'search_submit', historical: true,
    page: { url: target }, payload: { event: 'search_submit', service: 'golf', destination: 'Hải Phòng' } });
  assert.equal((await post('guided/step/start', { stepId: step.id, context: { search: { destination_name: 'Hải Phòng' } } })).status, 200);
  const scope = app.manager.currentStep;
  const wrong = app.manager.emit({ source: 'GA4', layer: 'JS_QUEUE', queue_name: 'dataLayer', event_name: 'search_submit', captured_at: scope.started_at,
    page: { url: target }, payload: { event: 'search_submit', service: 'golf', destination: 'HCM' } });
  const [queue] = queueEvents({ queue: 'InsiderQueue', href: target, item: { type: 'custom_event', value: [{ event_name: 'search_golf', event_parameters: {} }] } });
  app.manager.emit(queue);
  app.manager.emit({ source: 'INSIDER', layer: 'TRACKING_REQUEST', event_name: 'search_golf', page: { url: target }, payload: { event_name: 'search_golf', event_params: {} }, network: { phase: 'request', request_id: 'N1' } });
  app.manager.emit({ source: 'GA4', layer: 'JS_QUEUE', queue_name: 'dataLayer', event_name: 'promo_click', page: { url: target }, payload: { event: 'promo_click', service: 'golf' } });
  const completed = await post('guided/step/complete');
  assert.equal(completed.status, 200);
  const result = completed.data.guided.results[0];
  assert.equal(result.step_id, step.id);
  assert.equal(result.comparisons.find(r => r.source === 'GA4').actual_count, 1, 'backlog cannot satisfy the action');
  assert.equal(result.comparisons.find(r => r.source === 'INSIDER').actual_count, 1, 'queue and network are separate observations');
  const difference = result.comparisons.find(r => r.source === 'GA4').wrong_parameters.find(p => p.path === 'destination');
  assert.equal(difference.expected, 'Hải Phòng'); assert.equal(difference.actual, 'HCM'); assert.equal(difference.evidence_id, wrong.evidence_id);
  assert.deepEqual(result.extra_events.map(e => e.event_name), ['promo_click']);
  assert.equal(app.manager.currentStep, null);
  const skipped = await post('guided/step/skip', { stepId: optional.id });
  assert.equal(skipped.data.guided.results[1].verdict, 'NOT_EXECUTED');
  const finished = await post('guided/finish');
  assert.equal(finished.status, 200); assert.ok(finished.data.exported.xlsx);
  const report = await fetch(base + finished.data.exported.xlsx);
  assert.equal(report.status, 200); assert.ok((await report.arrayBuffer()).byteLength > 1000);
  const saved = loadRun(app.manager.runDir);
  assert.equal(saved.session.guided.results.length, 2);
  assert.equal(saved.steps[0].guided, true);
});

test('unavailable AI is labeled as requirements guidance and does not fabricate an AI review', async t => {
  const { post } = await fixture(t, false);
  const result = await post('guided/plan', { url: target, flow: 'Golf', selectedCaseIds: cases.map(c => c.id) });
  assert.equal(result.status, 200);
  assert.equal(result.data.guided.plan.guidance_source, 'requirements');
  assert.equal(result.data.guided.plan.ai.available, false);
  assert.ok(result.data.guided.plan.warnings.length);
});

test('guided pages show the simple upload-first flow while diagnostics stay accessible separately', async t => {
  const { app, base } = await fixture(t);
  const response = await fetch(base + '/guided');
  const html = await response.text();
  assert.equal(response.status, 200); assert.ok(html.includes('id="requirement-file"'));
  assert.ok(html.includes(app.csrf)); assert.ok(!html.includes('__CSRF__'));
  assert.equal((await fetch(base + '/assets/guided.js')).status, 200);
  assert.ok((await (await fetch(base + '/advanced')).text()).includes('data-mode="cdp-ai"'));
});

test('wire event samples and contradictory queue samples retain the correct source contract', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-guided-import-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'WebOTA.xlsx');
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Tổng hợp Event tracking');
  sheet.addRow(['Nền tảng', 'Luồng', 'Event Name', 'Event Description', 'DataLayer Sample']);
  sheet.addRow(['Insider', 'Golf', 'search_golf', 'Tìm sân golf', JSON.stringify({ event_name: 'search_golf', event_params: { c_destination: 'Sample' } })]);
  sheet.addRow(['Insider', 'Golf', 'cart_page_view', 'Xem giỏ hàng', JSON.stringify({ type: 'remove_from_cart', value: { id: 'sample' } })]);
  await workbook.xlsx.writeFile(file);
  const result = await importSpec(file);
  assert.equal(result.cases[0].target_platform, 'WEB');
  assert.equal(result.cases[0].rules[0].layer, 'TRACKING_REQUEST');
  assert.ok(result.cases[0].rules[0].fields['event_params.c_destination']);
  assert.equal(result.cases[1].sample_conflict, true);
  assert.ok(result.cases[1].spec_conflicts.length);
});

test('stopping during target lookup prevents a delayed browser/session launch', async t => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const pendingLookup = new Promise(resolve => { release = resolve; });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-guided-cancel-'));
  const app = await createApp({ port: 0, runsDir: dir, initialCases: [], lookup: () => { started(); return pendingLookup; } });
  const base = await app.listen();
  t.after(async () => { release({ address: '127.0.0.1' }); await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const post = (route, body = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': app.csrf }, body: JSON.stringify(body) });
  const opening = post('/api/start', { url: 'https://lookup.example.test/' });
  await entered;
  assert.equal((await post('/api/stop-session')).status, 200);
  release({ address: '127.0.0.1' });
  assert.equal((await opening).status, 200);
  assert.equal(app.manager.session, undefined);
});
