import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

test('late lifecycle replacement preserves awaited AI note/routing on the latest deterministic result and disk', { timeout: 5000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-server-ai-'));
  let signalExplainStarted;
  let resolveExplanation;
  let explainedResult;
  const explainStarted = new Promise(resolve => { signalExplainStarted = resolve; });
  const explanation = new Promise(resolve => { resolveExplanation = resolve; });
  const stubAI = {
    diagnostics: () => ({ enabled: true, mock: true }),
    async explain(result) { explainedResult = result; signalExplainStarted(); return explanation; },
  };
  const app = await createApp({ mode: 'cdp-ai', runsDir: dir, port: 0, aiClient: stubAI });
  const base = await app.listen();
  let pending;
  t.after(async () => {
    resolveExplanation({ available: false, reason: 'TEST_CLEANUP' });
    await pending?.catch(() => {});
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  app.manager.cases = [{ id: 'TC-RACE', name: 'Network mismatch', source: 'GA4', rules: [{
    event_name: 'search_submit', layer: 'TRACKING_REQUEST', count: { min: 1, max: 1 }, fields: { service: { op: 'eq', value: 'hotel' } },
  }] }];
  app.manager.start({ environment: 'MOCK_ONLY' });
  const step = app.manager.startStep('TC-RACE');
  const request = app.manager.emit({ source: 'GA4', layer: 'TRACKING_REQUEST', event_name: 'search_submit', captured_at: step.started_at,
    page: { url: 'https://example.test/search', target_id: 'MOCK-TAB' }, payload: { event: 'search_submit', service: 'merchandise' },
    network: { request_id: 'MOCK-REQUEST', phase: 'request', method: 'POST', url: 'https://example.test/collect' },
  });
  pending = fetch(`${base}/api/step/complete`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': app.csrf }, body: '{}' });
  await explainStarted;
  assert.equal(explainedResult.verdict, 'FAIL');
  const lifecycle = app.manager.emit({ ...request, network: { ...request.network, phase: 'response', status: 500 } });
  const latestBeforeAI = app.manager.results[0];
  assert.notEqual(latestBeforeAI, explainedResult, 'Lifecycle must actually replace the result object to reproduce the race');
  assert.equal(latestBeforeAI.verdict, 'FAIL');
  assert.ok(latestBeforeAI.results[0].issues.some(issue => issue.code === 'HTTP_ERROR' && issue.evidence_id === lifecycle.evidence_id));
  const routing = { model: 'mock/free', key_label: 'key_1', estimated_cost_usd: 0, reserved_cost_usd: 0, attempts: 1, json_mode: 'json_schema' };
  resolveExplanation({ available: true, note: 'Advisory: verify service mapping and HTTP response.', routing });
  const response = await pending;
  assert.equal(response.status, 200);
  const state = await response.json();
  const latest = app.manager.results[0];
  assert.equal(latest, latestBeforeAI);
  assert.equal(latest.ai_note, 'Advisory: verify service mapping and HTTP response.');
  assert.deepEqual(latest.ai_routing, routing);
  assert.equal(latest.verdict, 'FAIL');
  assert.equal(explainedResult.ai_note, undefined, 'The obsolete result object must not receive the note');
  assert.equal(state.results[0].ai_note, latest.ai_note);
  assert.deepEqual(state.results[0].ai_routing, routing);
  assert.equal(state.results[0].verdict, 'FAIL');
  const persisted = JSON.parse(await fs.readFile(path.join(app.manager.runDir, 'session.json'), 'utf8'));
  assert.equal(persisted.results[0].ai_note, latest.ai_note);
  assert.deepEqual(persisted.results[0].ai_routing, routing);
  assert.equal(persisted.results[0].verdict, 'FAIL');
  assert.ok(persisted.results[0].results[0].issues.some(issue => issue.code === 'HTTP_ERROR'));
});

test('AI event explanation receives the event with its specification match and is limited to the AI mode', { timeout: 5000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-server-ai-'));
  let received;
  const stubAI = { diagnostics: () => ({ enabled: true, mock: true }), close() {},
    async explainEvent(input) { received = input; return { available: true, verdict: input.spec.verdict, explanation: { summary: 'ok', problems: [], next_steps: [] } }; } };
  const app = await createApp({ mode: 'cdp-ai', runsDir: dir, port: 0, aiClient: stubAI });
  const plain = await createApp({ mode: 'cdp', runsDir: dir, port: 0, aiClient: stubAI });
  const base = await app.listen(), plainBase = await plain.listen();
  t.after(async () => { await app.close(); await plain.close(); await fs.rm(dir, { recursive: true, force: true }); });
  app.manager.cases = [{ id: 'TC-1', name: 'Search', source: 'GA4', rules: [{ event_name: 'search_submit', layer: 'JS_QUEUE', count: { min: 1, max: 1 }, fields: { service: { op: 'eq', value: 'hotel' } } }] }];
  app.manager.start({ environment: 'MOCK_ONLY' });
  app.manager.startComparison('Chưa phân luồng');
  const page = { url: 'https://example.test/search' };
  const event = app.manager.emit({ source: 'GA4', layer: 'JS_QUEUE', event_name: 'search_submit', captured_at: new Date().toISOString(), page, payload: { event: 'search_submit', service: 'merchandise' } });
  const hit = app.manager.emit({ source: 'GA4', layer: 'TRACKING_REQUEST', event_name: 'search_submit', captured_at: new Date().toISOString(), page, network: { phase: 'request' }, payload: { v: '2', tid: 'G-TEST', event: 'search_submit', service: 'merchandise' } });
  const post = (url, token, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': token }, body: JSON.stringify(body) });
  const response = await post(`${base}/api/ai-explain-event`, app.csrf, { id: event.evidence_id });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).verdict, 'FAIL');
  assert.equal(received.event.evidence_id, event.evidence_id);
  assert.equal(received.spec.case_id, 'TC-1');
  // The AI is told what reached Google, not only what the website pushed.
  assert.equal(received.delivery.status, 'sent');
  assert.equal(received.delivery.hit.evidence_id, hit.evidence_id);
  assert.equal(received.specLoaded, true);
  assert.equal((await post(`${base}/api/ai-explain-event`, app.csrf, { id: 'missing' })).status, 400);
  assert.equal((await post(`${plainBase}/api/ai-explain-event`, plain.csrf, { id: event.evidence_id })).status, 400);
});

test('the AI screen saves a pasted OpenRouter key into .env, keeps other settings and never echoes the key', { timeout: 5000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-server-ai-'));
  const envPath = path.join(dir, '.env');
  await fs.writeFile(envPath, 'AI_ENABLED=false\nOPENROUTER_API_KEY=\nOPENROUTER_ALLOW_PAID=false\n');
  const saved = { AI_ENABLED: process.env.AI_ENABLED, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };
  const stubAI = { diagnostics: () => ({ enabled: false, mock: true }), close() {} };
  const app = await createApp({ mode: 'cdp-ai', runsDir: dir, port: 0, aiClient: stubAI, envPath });
  const plain = await createApp({ mode: 'cdp', runsDir: dir, port: 0, aiClient: stubAI, envPath });
  const base = await app.listen(), plainBase = await plain.listen();
  t.after(async () => {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await app.close(); await plain.close(); await fs.rm(dir, { recursive: true, force: true });
  });
  const post = (url, token, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': token }, body: JSON.stringify(body) });
  const key = 'sk-or-v1-' + 'a'.repeat(40);
  assert.equal((await post(`${base}/api/ai-key`, app.csrf, { key: 'short key' })).status, 400);
  const response = await post(`${base}/api/ai-key`, app.csrf, { key });
  assert.equal(response.status, 200);
  assert.ok(!(await response.text()).includes(key));
  assert.equal(await fs.readFile(envPath, 'utf8'), `AI_ENABLED=true\nOPENROUTER_API_KEY=${key}\nOPENROUTER_ALLOW_PAID=false\n`);
  assert.equal(process.env.AI_ENABLED, 'true');
  assert.equal((await post(`${plainBase}/api/ai-key`, plain.csrf, { key })).status, 400);
  assert.equal((await post(`${base}/api/ai-key`, 'wrong-token', { key })).status, 403);
});

test('stopping a live export cancels a stuck AI wait and keeps final evidence in the report', { timeout: 10000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-report-stop-'));
  let started, release, cancelled = false;
  const notesStarted = new Promise(resolve => { started = resolve; });
  const notes = new Promise(resolve => { release = resolve; });
  const stubAI = { diagnostics: () => ({ enabled: true, configured_key_count: 1 }),
    async reportNotes() { started(); return notes; }, close() { cancelled = true; } };
  const app = await createApp({ mode: 'cdp-ai', runsDir: dir, port: 0, aiClient: stubAI, initialCases: [] });
  const base = await app.listen();
  let pending;
  t.after(async () => { release({ available: false, reason: 'TEST_CLEANUP' }); await pending?.catch(() => {}); await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const emit = name => app.manager.emit({ source: 'GA4', layer: 'TRACKING_REQUEST', event_name: name, payload: { event: name }, network: { phase: 'request' } });
  const post = route => fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': app.csrf }, body: '{}' });
  app.manager.start({ environment: 'MOCK_ONLY' });
  emit('before_export');
  pending = post('export').then(async response => { assert.equal(response.status, 200); await response.arrayBuffer(); });
  await notesStarted;
  const late = emit('during_export');
  const stopped = await post('stop-session');
  assert.equal(stopped.status, 200, await stopped.text());
  await pending;
  assert.equal(cancelled, true);
  const comparison = JSON.parse(await fs.readFile(path.join(app.manager.runDir, 'comparison.json'), 'utf8'));
  assert.equal(comparison.session.status, 'COMPLETED');
  assert.ok(comparison.events.some(event => event.evidence_id === late.evidence_id), 'An earlier export must not overwrite final evidence after stop');
});

test('shutdown releases an AI report wait and writes the completed report without waiting for the provider', { timeout: 10000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-report-close-'));
  let started, release, cancelled = false;
  const notesStarted = new Promise(resolve => { started = resolve; });
  const notes = new Promise(resolve => { release = resolve; });
  const stubAI = { diagnostics: () => ({ enabled: true, configured_key_count: 1 }),
    async reportNotes() { started(); return notes; }, close() { cancelled = true; } };
  const app = await createApp({ mode: 'cdp-ai', runsDir: dir, port: 0, aiClient: stubAI, initialCases: [] });
  const base = await app.listen();
  let pending;
  t.after(async () => { release({ available: false, reason: 'TEST_CLEANUP' }); await pending?.catch(() => {}); await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  app.manager.start({ environment: 'MOCK_ONLY' });
  const event = app.manager.emit({ source: 'GA4', layer: 'TRACKING_REQUEST', event_name: 'finish_event', payload: { event: 'finish_event' }, network: { phase: 'request' } });
  pending = fetch(`${base}/api/finish`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': app.csrf }, body: '{}' }).then(response => response.arrayBuffer()).catch(() => {});
  await notesStarted;
  const closed = await Promise.race([app.close().then(() => true), new Promise(resolve => { const timer = setTimeout(() => resolve(false), 5000); timer.unref(); })]);
  assert.equal(closed, true, 'Shutdown must not depend on the provider resolving its promise');
  assert.equal(cancelled, true);
  await pending;
  const comparison = JSON.parse(await fs.readFile(path.join(app.manager.runDir, 'comparison.json'), 'utf8'));
  assert.equal(comparison.session.status, 'COMPLETED');
  assert.ok(comparison.events.some(record => record.evidence_id === event.evidence_id));
  assert.ok((await fs.stat(path.join(app.manager.runDir, 'report.xlsx'))).size > 1000);
});
