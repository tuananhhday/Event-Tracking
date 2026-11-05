// Browser smoke against local fixtures only. No accounts, keys or external sites.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser, createTestPage, closeOwnedBrowser } from '../src/browser/launcher.mjs';
import { CDPCollector, listTargets } from '../src/collectors/cdp.mjs';
import { connectAutomationBrowser } from '../src/automation/playwright.mjs';
import { runWorkflow } from '../src/automation/runner.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-automation-'));
const browserName = process.env.EVENTQA_SMOKE_BROWSER || 'chrome';
const demo = await fs.readFile(new URL('../src/web/demo.html', import.meta.url), 'utf8');
const events = [];
let unexpectedClicks = 0, browser, collector, driver;
const server = http.createServer(async (request, response) => {
  const route = new URL(request.url, 'http://127.0.0.1').pathname;
  if (route === '/demo/g/collect' || route === '/demo/insider/events') {
    for await (const chunk of request) { /* drain fixture body */ }
    response.writeHead(204); response.end(); return;
  }
  if (route === '/unexpected') { unexpectedClicks++; response.end('LOCAL_ONLY'); return; }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (route === '/demo') {
    response.end(demo.replace('window.dataLayer = []; window.InsiderQueue = [];', 'window.dataLayer = []; window.InsiderQueue = []; window.dataLayer.push({event:"automation_page_ready"});'));
  } else if (route === '/controls') {
    response.end(`<!doctype html><title>Local controls</title>
      <label style="display:none">Loại báo cáo<select><option value="daily">Hằng ngày</option></select></label>
      <label for="report-type">Loại báo cáo</label><select id="report-type"><option value="daily">Hằng ngày</option><option value="weekly">Hằng tuần</option></select>
      <label>Ghi nhớ<input type="checkbox" id="remember"></label>
      <label>Mã<input id="code" placeholder="Nhập mã" data-testid="local-code"></label>
      <label>Mật khẩu<input type="password" value="SENSITIVE_PASSWORD_123"></label>
      <label>Ghi chú<textarea>SENSITIVE_TEXTAREA_123</textarea></label>
      <output>SENSITIVE_OUTPUT_123</output><p id="done"></p>
      <script>document.getElementById('code').onkeydown=e=>{if(e.key==='Enter')document.getElementById('done').textContent=document.getElementById('report-type').value+':'+document.getElementById('remember').checked+':'+e.target.value}</script>`);
  } else if (route === '/cancel') {
    response.end(`<!doctype html><title>Cancel fixture</title><p>Local cancellation</p><script>setTimeout(()=>{const b=document.createElement('button');b.id='later';b.textContent='Later';b.onclick=()=>fetch('/unexpected');document.body.appendChild(b)},250)</script>`);
  } else { response.writeHead(404); response.end('Local fixture not found'); }
});

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function waitFor(predicate, description, timeoutMs = 5000, signal) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    signal?.throwIfAborted();
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`Timeout: ${description}`);
}
async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, port = await freePort();
  browser = await launchBrowser({ browser: browserName, port, headless: true, profileDir: path.join(directory, 'profile') });
  const decoyId = await createTestPage({ port, headless: true, reuse: 'startup' });
  const targetId = await createTestPage({ port, headless: true });
  assert.notEqual(targetId, decoyId);
  collector = new CDPCollector({ port, targetId, endpointPatterns: ['/demo/g/collect', '/demo/insider/events'], onEvent: event => events.push(event) });
  await collector.start({});
  driver = await connectAutomationBrowser({ port, targetId });
  let currentStep, stepOffset = 0;
  const completed = [];
  const flow = {
    id: 'WF-LOCAL-SMOKE', name: 'Local browser automation', url: `${origin}/demo`,
    steps: [{
      id: 'hotel', name: 'Điền form và tìm khách sạn', actions: [
        { type: 'fill', locator: { by: 'label', value: 'Điểm đến', exact: true }, value: 'Đà Nẵng' },
        { type: 'fill', locator: { by: 'label', value: 'Người lớn', exact: true }, value: 3 },
        { type: 'fill', locator: { by: 'label', value: 'Số đêm', exact: true }, value: 2 },
        { type: 'check', locator: { by: 'label', value: 'Bỏ destination_id để tạo lỗi', exact: true }, checked: false },
        { type: 'click', locator: { by: 'role', role: 'button', value: 'Tìm khách sạn', exact: true } },
        { type: 'assert_text', locator: { by: 'css', value: '#output' }, text: 'Đà Nẵng' },
        { type: 'assert_url', url: `${origin}/demo` },
      ], expected_events: [{ event_name: 'search_submit', source: 'GA4', layer: 'TRACKING_REQUEST' }],
    }, {
      id: 'controls', name: 'Select, checkbox, phím và chờ phần tử', actions: [
        { type: 'goto', url: `${origin}/controls` },
        { type: 'select', locator: { by: 'label', value: 'Loại báo cáo', exact: true }, value: 'weekly' },
        { type: 'check', locator: { by: 'label', value: 'Ghi nhớ', exact: true }, checked: true },
        { type: 'fill', locator: { by: 'testId', value: 'local-code' }, value: 'LOCAL123' },
        { type: 'press', locator: { by: 'placeholder', value: 'Nhập mã' }, key: 'Enter' },
        { type: 'wait_for', locator: { by: 'css', value: '#done' }, state: 'visible' },
        { type: 'assert_text', locator: { by: 'css', value: '#done' }, text: 'weekly:true:LOCAL123' },
      ],
    }],
  };
  const outcome = await runWorkflow(flow, {
    driver,
    onStepStart: step => { currentStep = step.id; stepOffset = events.length; },
    onStepComplete: step => completed.push(step.id),
    waitForEvents: (expected, { timeoutMs, signal }) => waitFor(() => expected.every(want => events.slice(stepOffset).some(event => event.event_name === want.event_name
      && (!want.source || event.source === want.source) && (!want.layer || event.layer === want.layer) && (!event.network?.phase || event.network.phase === 'request'))), currentStep, timeoutMs, signal),
  });
  assert.equal(outcome.status, 'COMPLETED', JSON.stringify(outcome));
  assert.deepEqual(completed, ['hotel', 'controls']);
  const queued = events.find(event => event.layer === 'JS_QUEUE' && event.event_name === 'search_submit');
  assert.equal(queued?.payload.destination, 'Đà Nẵng'); assert.equal(queued?.payload.quantity_adult, 3);
  assert.ok(events.some(event => event.event_name === 'automation_page_ready' && !event.historical), 'collector must attach before initial navigation');
  const snapshot = await driver.inspect();
  assert.equal(snapshot.url, `${origin}/controls`);
  assert.ok(snapshot.controls.some(control => control.locator?.by === 'testId' && control.locator.value === 'local-code'));
  assert.ok(snapshot.controls.some(control => control.sensitive));
  for (const secret of ['SENSITIVE_PASSWORD_123', 'SENSITIVE_TEXTAREA_123', 'SENSITIVE_OUTPUT_123', 'LOCAL123']) assert.equal(JSON.stringify(snapshot).includes(secret), false);
  const screenshot = path.join(directory, 'controls.png'); await driver.screenshot(screenshot);
  assert.ok((await fs.stat(screenshot)).size > 1000);
  assert.equal((await listTargets(port)).find(target => target.id === decoyId)?.url, 'about:blank', 'driver must not act on the first unrelated tab');

  await driver.execute({ type: 'goto', url: `${origin}/cancel` });
  const controller = new AbortController();
  const pending = driver.execute({ type: 'click', locator: { by: 'css', value: '#later' }, timeout_ms: 3000 }, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(new Error('LOCAL_CANCEL')), 30);
  try { await assert.rejects(pending, /LOCAL_CANCEL/); } finally { clearTimeout(timer); }
  await driver.disconnect(); driver = null;
  await sleep(400);
  assert.equal(unexpectedClicks, 0, 'an aborted pending click must never execute later');
  assert.ok((await listTargets(port)).some(target => target.id === targetId), 'disconnect must leave the test browser open');
  driver = await connectAutomationBrowser({ port, targetId });
  assert.equal((await driver.inspect()).url, `${origin}/cancel`);
  await driver.disconnect(); driver = null;
  await collector.stop(); collector = null;
  console.log(JSON.stringify({ result: 'PASS', localOnly: true, exactTarget: true, steps: completed, capturedEvents: events.length,
    inputValuesExcludedFromInspection: true, cancellationPreventsLateClick: true, disconnectPreservesBrowser: true }, null, 2));
} finally {
  await driver?.disconnect().catch(() => {});
  await collector?.stop().catch(() => {});
  if (browser) await closeOwnedBrowser(browser);
  await new Promise(resolve => server.close(resolve));
  const target = path.resolve(directory), temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(target.startsWith(temporaryRoot) && path.basename(target).startsWith('eventqa-automation-'));
  await fs.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
