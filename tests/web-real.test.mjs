import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';

const reviewed = fileURLToPath(new URL('../imports/reviewed-cases.json', import.meta.url));
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-real-'));
  const app = await createApp({ mode: 'cdp', port: 0, runsDir: dir, initialCases: [] });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const post = (route, data) => fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': app.csrf }, body: JSON.stringify(data) });
  return { app, base, post };
}
// Saving rules writes imports/reviewed-cases.json; restore whatever the user had.
async function keepReviewedSpec(t) {
  const before = await fs.readFile(reviewed, 'utf8').catch(() => null);
  t.after(async () => { if (before === null) await fs.rm(reviewed, { force: true }); else await fs.writeFile(reviewed, before); });
}

test('real-site mode starts without demo cases and summarizes live evidence by event', async t => {
  const { app, base } = await fixture(t);
  const empty = await (await fetch(`${base}/api/state`)).json();
  assert.equal(empty.cases.length, 0); assert.equal(empty.specSource, 'none');
  assert.ok(empty.vendors.ga4 && empty.vendors.meta);
  app.manager.start({ environment: 'REAL_FIXTURE' });
  const emit = (name, phase) => app.manager.emit({ source: 'GA4', layer: phase ? 'TRACKING_REQUEST' : 'JS_QUEUE', event_name: name, page: { url: 'https://shop.example.vn/p/1?q=x' }, payload: { event: name }, ...(phase ? { network: { request_id: 'r1', phase } } : {}) });
  emit('page_view'); const last = emit('page_view'); emit('page_view', 'request'); emit('page_view', 'failed');
  const state = await (await fetch(`${base}/api/state`)).json();
  const queue = state.eventSummary.find(g => g.layer === 'JS_QUEUE');
  const request = state.eventSummary.find(g => g.layer === 'TRACKING_REQUEST');
  assert.equal(queue.count, 2); assert.equal(queue.last_evidence_id, last.evidence_id); assert.deepEqual(queue.pages, ['shop.example.vn/p/1']);
  assert.equal(request.count, 1, 'lifecycle records are not counted as events'); assert.equal(request.failed, 1);
  const fetched = await (await fetch(`${base}/api/event?id=${last.evidence_id}`)).json();
  assert.equal(fetched.event.evidence_id, last.evidence_id);
  assert.equal((await fetch(`${base}/api/event?id=EV-missing`)).status, 404);
  app.manager.finish();
});

test('rules can be saved and removed during a running session, but not while a step records', async t => {
  await keepReviewedSpec(t);
  const { app, post } = await fixture(t);
  const testCase = { id: 'TC-LIVE-1', name: 'live', rules: [{ event_name: 'page_view', layer: 'JS_QUEUE', count: { min: 1, max: 1 }, fields: { event: { op: 'eq', value: 'page_view' } } }] };
  app.manager.start({ environment: 'REAL_FIXTURE' });
  assert.equal((await post('save-case', { case: testCase })).status, 200);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(app.manager.runDir, 'expected.json'), 'utf8')).cases.map(c => c.id), ['TC-LIVE-1']);
  app.manager.startStep('TC-LIVE-1', {});
  assert.equal((await post('save-case', { case: { ...testCase, name: 'changed' } })).status, 400);
  app.manager.completeStep();
  assert.equal((await post('delete-case', { id: 'TC-LIVE-1' })).status, 400, 'a case with steps in this session is kept');
  assert.equal((await post('save-case', { case: { ...testCase, id: 'TC-LIVE-2' } })).status, 200);
  assert.equal((await post('delete-case', { id: 'TC-LIVE-2' })).status, 200);
  assert.deepEqual(app.manager.cases.map(c => c.id), ['TC-LIVE-1']);
  app.manager.finish();
});

test('endpoint allowlist updates validate regexes and are reported in state', async t => {
  const { post } = await fixture(t);
  assert.equal((await post('endpoints', { patterns: ['(unclosed'] })).status, 400);
  assert.equal((await post('endpoints', { patterns: [] })).status, 400);
  const state = await (await post('endpoints', { patterns: ['^ubt-sin\\.tripcdn\\.com/bee/collect$'] })).json();
  assert.deepEqual(state.patterns, ['^ubt-sin\\.tripcdn\\.com/bee/collect$']);
});
