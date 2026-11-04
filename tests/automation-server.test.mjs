import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

const testCase = { id: 'TC-AUTO', name: 'Search', source: 'GA4', flow: 'Hotel', rules: [{ event_name: 'search_submit', layer: 'TRACKING_REQUEST',
  count: { min: 1, max: 1 }, fields: { search_term: { op: 'ref', value: 'context.search.term' } } }] };
const workflow = (id = 'hotel') => ({ id, name: id, url: 'https://example.test/hotel', variables: { term: 'snack' },
  steps: [{ name: 'Search', case_id: 'TC-AUTO', context: { search: { term: '{{term}}' } }, actions: [
    { type: 'fill', locator: { by: 'label', value: 'Keyword' }, value: '{{term}}' },
    { type: 'click', locator: { by: 'role', role: 'button', value: 'Search' } },
  ] }] });

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-automation-server-'));
  const calls = []; let app, value, connections = 0, aiCalls = 0;
  const ai = { diagnostics: () => ({ enabled: true, configured_key_count: 1 }), close() {},
    async reportNotes() { aiCalls++; throw new Error('Automatic runs must not call AI'); }, ...options.ai };
  app = await createApp({ mode: options.mode ?? 'cdp-ai', port: 0, runsDir: directory, initialCases: [testCase], aiClient: ai,
    automationOptions: { capture: async () => { app.manager.start({ environment: 'MOCK_ONLY' }); return { port: 9223, targetId: 'TEST-TAB' }; },
      connectDriver: async () => { connections++; return {
        async execute(action, context) {
          calls.push(action);
          if (options.execute) return options.execute(action, context, app, connections);
          if (action.type === 'fill') value = action.value;
          if (action.type === 'click') app.manager.emit({ source: 'GA4', layer: 'TRACKING_REQUEST', event_name: 'search_submit',
            page: { target_id: 'TEST-TAB', url: 'https://example.test/hotel' }, payload: { event: 'search_submit', search_term: value },
            network: { phase: 'request', method: 'POST', url: 'https://tracking.example.test/collect' } });
        }, async disconnect() {},
      }; },
    } });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const post = async (route, data = {}, token = app.csrf) => {
    const response = await fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': token }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  return { app, base, calls, post, aiCalls: () => aiCalls };
}

test('saved workflows run sequentially in one QA session and use existing report downloads without AI', async t => {
  const { app, base, calls, post, aiCalls } = await fixture(t);
  for (const id of ['hotel', 'second']) assert.equal((await post('automation/save', { workflow: workflow(id) })).status, 200);
  const started = await post('automation/run', { ids: ['hotel', 'second'], variables: { term: 'actual search' } });
  assert.equal(started.status, 202);
  await app.automation.wait();
  const state = (await (await fetch(`${base}/api/automation/state`)).json());
  assert.equal(state.run.status, 'COMPLETED');
  assert.equal(state.run.results.length, 2);
  assert.equal(state.history.length, 1);
  assert.equal(aiCalls(), 0);
  assert.deepEqual(calls.filter(action => action.type === 'fill').map(action => action.value), ['actual search', 'actual search']);
  assert.deepEqual(app.manager.snapshot().results.filter(result => result.step_id).map(result => result.verdict), ['PASS', 'PASS']);
  const comparison = JSON.parse(await fs.readFile(path.join(app.manager.runDir, 'comparison.json'), 'utf8'));
  assert.equal(comparison.events.length, 2);
  assert.ok(state.run.reports.xlsx && state.run.reports.automation);
  assert.equal((await fetch(`${base}${state.run.reports.xlsx}`)).status, 200);
  const details = await (await fetch(`${base}${state.run.reports.automation}`)).json();
  assert.equal(details.status, 'COMPLETED');
  assert.ok(details.reports.xlsx);
});

test('cancellation interrupts the current case, blocks later workflows and still exports collected evidence', async t => {
  let reached;
  const pendingAction = new Promise(resolve => { reached = resolve; });
  const { app, post, calls } = await fixture(t, { execute: async action => { if (action.type === 'fill') { reached(); return new Promise(() => {}); } } });
  await post('automation/save', { workflow: workflow() });
  await post('automation/save', { workflow: workflow('later') });
  await post('automation/run', { ids: ['hotel', 'later'] });
  await pendingAction;
  assert.equal((await post('step/start', { testCaseId: 'TC-AUTO' })).status, 409);
  assert.equal((await post('automation/cancel')).status, 200);
  await app.automation.wait();
  assert.equal(app.automation.state().run.status, 'CANCELLED');
  assert.equal(calls.filter(action => action.type === 'goto').length, 1);
  assert.equal(app.manager.steps[0].status, 'INTERRUPTED');
  assert.equal(app.manager.snapshot().results[0].verdict, 'REVIEW');
  assert.ok((await fs.stat(path.join(app.manager.runDir, 'report.xlsx'))).size > 1000);
});

test('Kết thúc cancels an active automatic run without exporting', async t => {
  let reached;
  const pendingAction = new Promise(resolve => { reached = resolve; });
  const { app, post, aiCalls } = await fixture(t, { execute: async action => { if (action.type === 'fill') { reached(); return new Promise(() => {}); } } });
  await post('automation/save', { workflow: workflow() });
  await post('automation/run', { ids: ['hotel'] }); await pendingAction;
  assert.equal((await post('finish', { exportReport: false })).status, 200);
  assert.equal(app.automation.run.status, 'CANCELLED'); assert.notEqual(app.manager.session.status, 'RUNNING');
  assert.equal(app.manager.steps[0].status, 'INTERRUPTED'); assert.equal(app.manager.snapshot().results[0].verdict, 'REVIEW'); assert.equal(aiCalls(), 0);
  const names = await fs.readdir(app.manager.runDir);
  assert.ok(names.includes('workflow-results.json')); assert.ok(!names.includes('report.xlsx') && !names.includes('report.html'));
});

test('a completed automatic run with export_report disabled keeps evidence without generating reports', async t => {
  const { app, post, aiCalls } = await fixture(t);
  await post('automation/save', { workflow: { ...workflow(), export_report: false } });
  await post('automation/run', { ids: ['hotel'], aiNotes: true }); await app.automation.wait();
  assert.equal(app.automation.run.status, 'COMPLETED'); assert.equal(app.automation.run.reports, undefined);
  assert.equal(aiCalls(), 0); const names = await fs.readdir(app.manager.runDir);
  assert.ok(names.includes('events.jsonl') && names.includes('workflow-results.json')); assert.ok(!names.includes('report.xlsx'));
});

test('a failed workflow reconnects the driver for the next one and leaves failed actions reviewable', async t => {
  const { app, post } = await fixture(t, { execute: async (_action, _context, _app, connection) => { if (connection === 1) throw new Error('Locator no longer exists'); } });
  const second = workflow('next'); delete second.steps[0].case_id;
  await post('automation/save', { workflow: workflow() }); await post('automation/save', { workflow: second });
  await post('automation/run', { ids: ['hotel', 'next'] }); await app.automation.wait();
  assert.deepEqual(app.automation.run.results.map(result => result.status), ['FAILED', 'COMPLETED']);
  assert.equal(app.manager.snapshot().results[0].verdict, 'REVIEW');
  assert.equal(app.automation.run.status, 'FAILED');
});

test('AI drafting validates generated actions, disables schedules and ignores fabricated page snapshots', async t => {
  let input;
  const { post } = await fixture(t, { ai: { modelSpec: 'MOCK', async complete(_model, _prompt, data, _schema, validate) {
    input = data; const generated = { ...workflow(), schedule: { enabled: true, time: '07:00', timezone: 'Asia/Ho_Chi_Minh', days: [1] } };
    assert.equal(validate(generated), null);
    return { available: true, data: generated };
  } } });
  const result = await post('automation/draft', { name: 'My test', url: 'https://example.test/hotel', instructions: 'Search a hotel', page: { controls: ['forged'] } });
  assert.equal(result.status, 200);
  assert.equal(result.body.available, true);
  assert.equal(result.body.workflow.schedule.enabled, false);
  assert.equal(input.page, null);
  assert.deepEqual(input.catalogue[0].context_refs, [{ field: 'search_term', ref: 'context.search.term' }]);
  assert.equal(result.body.workflow.name, 'My test');
});

test('automation mutations require the session token and reject invalid scripts before any action', async t => {
  const { app, post, calls } = await fixture(t);
  assert.equal((await post('automation/save', { workflow: workflow() }, 'wrong')).status, 403);
  const invalid = workflow(); invalid.steps[0].actions = [{ type: 'evaluate', script: 'bad code' }];
  assert.equal((await post('automation/save', { workflow: invalid })).status, 400);
  await post('automation/save', { workflow: workflow() });
  assert.equal((await post('automation/run', { ids: ['hotel'], variables: { term: null } })).status, 400);
  assert.equal(calls.length, 0);
  assert.equal(app.manager.session, undefined);
});

test('the regular edition does not expose automation controls or mutations', async t => {
  const { base, post } = await fixture(t, { mode: 'cdp' });
  assert.equal((await fetch(`${base}/api/automation/state`)).status, 404);
  assert.equal((await post('automation/save', { workflow: workflow() })).status, 404);
});

test('an invalid scheduled workflow is reported without blocking other scheduled workflows', async t => {
  const { app, post } = await fixture(t);
  const invalid = workflow('stale'); invalid.steps[0].case_id = 'REMOVED-CASE';
  await post('automation/save', { workflow: invalid }); await post('automation/save', { workflow: workflow('valid') });
  await app.automation.enqueue(['stale', 'valid'], { trigger: 'schedule', scheduled_date: '2026-11-04' });
  await app.automation.wait();
  assert.deepEqual(app.automation.run.results.map(result => result.status), ['FAILED', 'COMPLETED']);
  assert.ok(app.automation.run.reports.xlsx);
  assert.equal(app.manager.snapshot().results.find(result => result.step_id)?.verdict, 'PASS');
  await app.automation.enqueue(['stale'], { trigger: 'schedule', scheduled_date: '2026-11-05' });
  await app.automation.wait();
  assert.equal(app.automation.run.status, 'FAILED');
  assert.equal(app.automation.run.session_id, undefined);
  assert.match(app.automation.run.error, /REMOVED-CASE/);
});

test('closing during optional automation report notes cancels the wait and keeps the final report', async t => {
  let started;
  const writingNotes = new Promise(resolve => { started = resolve; });
  const { app, post } = await fixture(t, { ai: { reportNotes() { started(); return new Promise(() => {}); } } });
  await post('automation/save', { workflow: workflow() });
  await post('automation/run', { ids: ['hotel'], aiNotes: true });
  await writingNotes;
  let timer;
  try {
    await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Closing waited for AI')), 4000); })]);
  } finally { clearTimeout(timer); }
  assert.ok((await fs.stat(path.join(app.manager.runDir, 'report.xlsx'))).size > 1000);
  assert.equal(app.server.listening, false);
});

test('Kết thúc during automatic report notes cancels the export and allows a later explicit export', async t => {
  let started;
  const writingNotes = new Promise(resolve => { started = resolve; });
  const { app, post } = await fixture(t, { ai: { reportNotes() { started(); return new Promise(() => {}); } } });
  await post('automation/save', { workflow: workflow() });
  await post('automation/run', { ids: ['hotel'], aiNotes: true }); await writingNotes;
  const stopped = await post('finish', { exportReport: false });
  assert.equal(stopped.status, 200); assert.equal(stopped.body.exported, null);
  assert.ok(!(await fs.readdir(app.manager.runDir)).includes('report.xlsx'));
  const exported = await post('export', { aiNotes: false, selection: { contents: ['events'], formats: ['html'] } });
  assert.equal(exported.status, 200); assert.ok(exported.body.exported.html);
});
