import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../src/server.mjs';
import { shutdownApps } from '../scripts/stop-apps.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function post(app, base, route, data = {}, extraHeaders = {}) {
  return fetch(`${base}${route}`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-eventqa-token': app.csrf, ...extraHeaders,
  }, body: JSON.stringify(data) });
}
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-shutdown-'));
  const app = await createApp({ port: 0, runsDir: dir, ...options });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { app, base, dir };
}
function beginEvidence(app, { step = true } = {}) {
  app.manager.start({ environment: 'SHUTDOWN_REGRESSION_FIXTURE' });
  const active = step ? app.manager.startStep(app.manager.cases[0].id, { search: { destination_name: 'Phú Quốc', adults: 2, nights: 1 } }) : null;
  const event = app.manager.emit({ source: 'GA4', layer: 'JS_QUEUE', event_name: 'search_submit',
    page: { url: 'http://fixture.local/demo' }, payload: { event: 'search_submit', service: 'hotel' },
  });
  return { active, event };
}

test('stop-session interrupts an active step, preserves evidence, exports REVIEW and keeps the app usable', { timeout: 10000 }, async t => {
  const { app, base } = await fixture(t);
  const { active, event } = beginEvidence(app);
  const response = await post(app, base, '/api/stop-session');
  assert.equal(response.status, 200, await response.text());
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.running, false);
  assert.equal(state.currentStep, null);
  assert.equal(state.session.status, 'INTERRUPTED');
  assert.equal(state.steps.find(step => step.id === active.id)?.status, 'INTERRUPTED');
  assert.equal(state.results.find(result => result.step_id === active.id)?.verdict, 'REVIEW');
  assert.ok(state.events.some(record => record.evidence_id === event.evidence_id));
  const comparison = JSON.parse(await fs.readFile(path.join(app.manager.runDir, 'comparison.json'), 'utf8'));
  assert.equal(comparison.results.find(result => result.step_id === active.id)?.verdict, 'REVIEW');
  assert.ok(comparison.events.some(record => record.evidence_id === event.evidence_id));
  assert.ok((await fs.stat(path.join(app.manager.runDir, 'report.xlsx'))).size > 1000);
  const firstCount = app.manager.snapshot().events.length;
  const repeated = await post(app, base, '/api/stop-session');
  assert.equal(repeated.status, 200);
  await repeated.arrayBuffer();
  assert.equal(app.manager.snapshot().events.length, firstCount, 'Stopping twice must not duplicate or lose evidence');
});

test('stop-session completes a capture with no active step instead of refusing shutdown', { timeout: 10000 }, async t => {
  const { app, base } = await fixture(t);
  const { event } = beginEvidence(app, { step: false });
  const stopped = await app.stopSession();
  assert.equal(stopped.interrupted, false);
  assert.equal(app.manager.session.status, 'COMPLETED');
  assert.ok(stopped.snapshot.events.some(record => record.evidence_id === event.evidence_id));
  assert.ok(stopped.files.xlsx);
  assert.equal((await fetch(`${base}/api/state`)).status, 200);
});

test('shutdown routes require the local token and reject an unrelated origin', { timeout: 10000 }, async t => {
  const { app, base } = await fixture(t);
  for (const route of ['/api/stop-session', '/api/shutdown']) {
    const noToken = await post(app, base, route, {}, { 'x-eventqa-token': 'wrong' });
    assert.equal(noToken.status, 403); await noToken.arrayBuffer();
    const badOrigin = await post(app, base, route, {}, { origin: 'https://unrelated.test' });
    assert.equal(badOrigin.status, 403); await badOrigin.arrayBuffer();
  }
  assert.equal((await fetch(`${base}/api/state`)).status, 200, 'Rejected shutdown must leave app available');
});

test('stop-session bypasses an in-flight AI action, cancels it and does not require completing the step first', { timeout: 10000 }, async t => {
  let signalStarted, release;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const pendingExplanation = new Promise(resolve => { release = resolve; });
  let cancelCount = 0;
  const fakeAI = { diagnostics: () => ({ mock: true }),
    async explain() { signalStarted(); return pendingExplanation; },
    close() { cancelCount++; release({ available: false, reason: 'AI_CANCELLED' }); },
  };
  const { app, base } = await fixture(t, { mode: 'cdp-ai', aiClient: fakeAI });
  beginEvidence(app);
  const pending = post(app, base, '/api/step/complete').then(async response => ({ status: response.status, body: await response.json() })).catch(error => ({ error: error.message }));
  t.after(() => release({ available: false, reason: 'TEST_CLEANUP' }));
  await started;
  const response = await post(app, base, '/api/stop-session');
  assert.equal(response.status, 200, await response.text());
  assert.ok(cancelCount >= 1);
  assert.equal(app.manager.session.status, 'COMPLETED');
  assert.ok((await fs.stat(path.join(app.manager.runDir, 'report.xlsx'))).size > 1000);
  await pending;
});

test('shutdown acknowledges the request before closing the listening socket and is idempotent', { timeout: 10000 }, async t => {
  const { app, base } = await fixture(t);
  beginEvidence(app, { step: false });
  const response = await post(app, base, '/api/shutdown');
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const end = Date.now() + 5000;
  while (app.server.listening && Date.now() < end) await pause(25);
  assert.equal(app.server.listening, false);
  await Promise.all([app.close(), app.close()]);
  assert.equal(app.manager.session.status, 'COMPLETED');
  assert.ok((await fs.stat(path.join(app.manager.runDir, 'report.xlsx'))).size > 1000);
});

test('closing the app is bounded even if an already-started AI promise never settles on cancellation', { timeout: 10000 }, async t => {
  let signalStarted, release;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const pendingExplanation = new Promise(resolve => { release = resolve; });
  let cancelled = false;
  const fakeAI = { diagnostics: () => ({ mock: true }),
    async explain() { signalStarted(); return pendingExplanation; },
    close() { cancelled = true; },
  };
  const { app, base } = await fixture(t, { mode: 'cdp-ai', aiClient: fakeAI });
  beginEvidence(app);
  const pending = post(app, base, '/api/step/complete').then(response => response.arrayBuffer()).catch(() => {});
  await started;
  let timer;
  let closedInTime;
  try {
    closedInTime = await Promise.race([
      app.close().then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); }),
    ]);
  } finally {
    clearTimeout(timer);
    release({ available: false, reason: 'TEST_RELEASE_AFTER_CLOSE' });
    await pending;
  }
  assert.equal(cancelled, true);
  assert.equal(closedInTime, true, 'Closing must not wait for a model timeout or unrelated client connection');
  assert.equal(app.server.listening, false);
});

test('stopper discovers an active app without a PID manifest and preserves interrupted-step report evidence', { timeout: 10000 }, async t => {
  const { app, base } = await fixture(t);
  const { active, event } = beginEvidence(app);
  const port = Number(new URL(base).port);
  const results = await shutdownApps({ apps: [{ mode: 'cdp', port }], timeoutMs: 5000 });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'STOPPED');
  assert.equal(app.server.listening, false);
  assert.equal(app.manager.session.status, 'INTERRUPTED');
  const report = JSON.parse(await fs.readFile(path.join(app.manager.runDir, 'comparison.json'), 'utf8'));
  assert.equal(report.results.find(result => result.step_id === active.id)?.verdict, 'REVIEW');
  assert.ok(report.events.some(record => record.evidence_id === event.evidence_id));
  assert.ok((await fs.stat(path.join(app.manager.runDir, 'report.xlsx'))).size > 1000);
});

test('stopper leaves unrelated localhost services alone and treats an offline app as already stopped', { timeout: 10000 }, async t => {
  const requests = [];
  const unrelated = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ mode: 'cdp', process_id: process.pid }));
  });
  await new Promise(resolve => unrelated.listen(0, '127.0.0.1', resolve));
  const port = unrelated.address().port;
  t.after(() => new Promise(resolve => unrelated.close(resolve)));
  const ignored = await shutdownApps({ apps: [{ mode: 'cdp', port }], timeoutMs: 1000 });
  assert.equal(ignored[0].status, 'UNRECOGNIZED');
  assert.equal(unrelated.listening, true);
  assert.deepEqual(requests, [{ method: 'GET', path: '/api/state' }]);
  await new Promise(resolve => unrelated.close(resolve));
  const offline = await shutdownApps({ apps: [{ mode: 'cdp', port }], timeoutMs: 1000 });
  assert.equal(offline[0].status, 'OFFLINE');
  assert.equal(requests.some(request => request.method === 'POST'), false);
});
