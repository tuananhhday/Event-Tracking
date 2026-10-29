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
