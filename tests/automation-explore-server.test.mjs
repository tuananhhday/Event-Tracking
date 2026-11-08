import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function fixture(t, { reply, execute, listTargets } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-explore-server-'));
  let app;
  const executed = [];
  const ai = { diagnostics: () => ({ enabled: true, configured_key_count: 1 }), close() {}, unavailable: () => null, modelAutomation: 'fake',
    async complete(model, system, input, schema, validate) {
      if (schema.properties?.reached) return { available: true, data: { reason: 'Đạt', reached: true }, routing: { model: 'fake', estimated_cost_usd: 0 } };
      const data = reply(input);
      if (data instanceof Promise) return data;
      return validate(data) ? { available: false, reason: 'INVALID_AI_STEP' } : { available: true, data, routing: { model: 'fake', estimated_cost_usd: 0.0001 } };
    } };
  app = await createApp({ mode: 'cdp-ai', port: 0, runsDir: directory, initialCases: [], aiClient: ai, automationOptions: {
    ...(listTargets ? { listTargets } : {}),
    capture: async () => { app.manager.start({ environment: 'MOCK_ONLY' }); return { port: 9223, targetId: 'TEST-TAB' }; },
    connectDriver: async () => ({
      async snapshot() { return { url: 'https://example.test/', title: 'Trang', elements: [{ ref: 'e1', tag: 'input', name: 'Email' }, { ref: 'e2', tag: 'button', name: 'Tìm' }], dialogs: [], headings: [], text: '' }; },
      async locatorFor(ref) { return ref === 'e1' ? { by: 'label', value: 'Email', exact: true } : { by: 'role', role: 'button', value: 'Tìm', exact: true }; },
      async execute(action, context) {
        executed.push(action);
        if (execute) return execute(action, context);
        if (action.type === 'click') app.manager.emit({ source: 'GA4', layer: 'TRACKING_REQUEST', event_name: 'search', page: { target_id: 'TEST-TAB' }, payload: { event: 'search' }, network: { phase: 'request', method: 'POST', url: 'https://t.example.test/g/collect' } });
      },
      async settle() {}, url: () => 'https://example.test/', async disconnect() {},
    }),
  } });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const post = async (route, data = {}) => {
    const response = await fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': app.csrf }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  return { app, base, post, executed };
}

test('AI exploration runs in the background with event capture and returns an unredacted draft workflow', async t => {
  const { app, base, post, executed } = await fixture(t, { reply: input => input.history.length
    ? { status: 'step_done', note: 'Đã tìm', actions: [] }
    : { status: 'act', note: 'Điền email rồi tìm', actions: [{ type: 'fill', ref: 'e1', value: '', variable: 'guest_email', anchor_text: '', optional: false, irreversible: false },
      { type: 'click', ref: 'e2', value: '', variable: '', anchor_text: '', optional: false, irreversible: false }] } });
  const started = await post('automation/explore', { name: 'Tìm', url: 'https://example.test/', browser: 'chrome', instructions: 'guest_email = qa@example.com\n1. Điền email và tìm\n2. Xem kết quả' });
  assert.equal(started.status, 202);
  assert.equal(started.body.exploration.status, 'RUNNING');
  await app.automation.wait();
  const state = await (await fetch(`${base}/api/automation/state`)).json();
  assert.equal(state.exploration.status, 'COMPLETED', state.exploration.error);
  assert.equal(state.exploration.workflow.variables.guest_email, 'qa@example.com', 'the draft keeps the user’s own test data');
  assert.equal(state.exploration.workflow.steps[0].actions[0].value, '{{guest_email}}');
  assert.deepEqual(state.exploration.workflow.steps[0].observed_events, [{ source: 'GA4', event_name: 'search', count: 1 }]);
  assert.equal(executed.find(action => action.type === 'fill').value, 'qa@example.com');
  assert.ok(state.exploration.progress.some(item => /Bước 1\/2/.test(item.message ?? '')));
  assert.equal(app.manager.session.status !== 'RUNNING', true, 'the capture session is closed after exploring');
  assert.equal(state.exploration.usage.calls, 6, 'two steps, each: act, step_done and the end-of-step check');
  const saved = await post('automation/save', { workflow: state.exploration.workflow });
  assert.equal(saved.status, 200);
});

test('exploration can be cancelled while the AI is thinking and explains a disabled AI', async t => {
  let release;
  const { app, post } = await fixture(t, { reply: () => new Promise(resolve => { release = resolve; }) });
  await post('automation/explore', { url: 'https://example.test/', instructions: '1. Tìm\n2. Đặt' });
  while (!release) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await post('automation/run', { ids: ['x'] })).status, 409, 'nothing else starts while AI explores');
  assert.equal((await post('automation/cancel')).status, 200);
  release({ available: false, reason: 'AI_CANCELLED' });
  await app.automation.wait();
  assert.equal(app.automation.state().exploration.status, 'CANCELLED');
  assert.equal((await post('automation/explore', { url: 'ftp://example.test/', instructions: '1. Tìm' })).status, 400);
  assert.match((await post('automation/explore', { instructions: 'Không có website' })).body.error, /website/);
});

test('“wait for login” pauses before AI starts, resumes on request and keeps the test window open', async t => {
  const { app, base, post, executed } = await fixture(t, { reply: () => ({ status: 'step_done', note: 'Xong', actions: [] }) });
  const finishes = [], original = app.automation.finish;
  app.automation.finish = options => { finishes.push(options); return original(options); };
  await post('automation/explore', { url: 'https://example.test/', instructions: 'Tìm khách sạn', waitForLogin: true });
  const state = async () => (await (await fetch(`${base}/api/automation/state`)).json()).exploration;
  while ((await state()).status !== 'WAITING_USER') await new Promise(resolve => setTimeout(resolve, 10));
  assert.match((await state()).waiting.message, /Đăng nhập/);
  assert.deepEqual(executed.map(action => action.type), ['goto'], 'AI does nothing while the user logs in');
  assert.equal((await post('automation/resume')).status, 200);
  await app.automation.wait();
  assert.equal((await state()).status, 'COMPLETED');
  assert.deepEqual(executed.map(action => action.type), ['goto', 'goto']);
  assert.deepEqual(finishes, [{ keepBrowser: true }]);
});

test('after the user logs in (login page → callback → website) exploration continues by itself', async t => {
  const urls = ['https://example.test/vi/account/auth/login?redirectUrl=x', 'https://id.example.test/login', 'https://example.test/vi/account/auth/callback#code=abc', 'https://example.test/vi'];
  let polls = 0;
  const listTargets = async () => [{ id: 'TEST-TAB', url: urls[Math.min(polls++, urls.length - 1)] }];
  const { app, base, post, executed } = await fixture(t, { reply: () => ({ status: 'step_done', note: 'Xong', actions: [] }), listTargets });
  await post('automation/explore', { url: 'https://example.test/', instructions: 'Tìm khách sạn', waitForLogin: true });
  await app.automation.wait();
  const exploration = (await (await fetch(`${base}/api/automation/state`)).json()).exploration;
  assert.equal(exploration.status, 'COMPLETED');
  assert.ok(exploration.progress.some(item => /tự chạy tiếp/.test(item.message ?? '')));
  assert.ok(polls >= 5, 'it waited until the website was shown steadily after the callback');
  assert.deepEqual(executed.map(action => action.type), ['goto', 'goto']);
});
