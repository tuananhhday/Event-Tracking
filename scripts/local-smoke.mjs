// End-to-end test of our own local demo and dashboard using raw CDP.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { launchBrowser } from '../src/browser/launcher.mjs';
import { listTargets, CDPConnection } from '../src/collectors/cdp.mjs';

const browserName = process.env.EVENTQA_SMOKE_BROWSER || 'chrome';
if (!['chrome', 'edge'].includes(browserName)) throw Error('EVENTQA_SMOKE_BROWSER must be chrome or edge.');
const port = Number(process.env.EVENTQA_SMOKE_PORT || (browserName === 'edge' ? 4474 : 4473));
const debugPort = Number(process.env.EVENTQA_SMOKE_CDP_PORT || (browserName === 'edge' ? 9330 : 9329));
const output = path.resolve(browserName === 'chrome' ? 'runs/local-smoke' : 'runs/local-smoke-edge'); await fs.mkdir(output, { recursive: true });
const app = await createApp({ port, runsDir: path.join(output, 'sessions') });
let browser, connection;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, description, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await predicate()) return; await sleep(100); } throw Error(`Timeout: ${description}`); }
const api = async (endpoint, data = {}) => { const response = await fetch(`http://127.0.0.1:${port}/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EventQA-Token': app.csrf }, body: JSON.stringify(data) }); const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result; };
try {
  await app.listen();
  browser = await launchBrowser({ browser: browserName, port: debugPort, headless: true, url: 'about:blank', profileDir: path.join(output, 'profile') });
  const target = (await listTargets(debugPort))[0]; connection = new CDPConnection(target.webSocketDebuggerUrl); await connection.connect();
  await api('start', { attach: true, browser: browserName, url: `http://127.0.0.1:${port}/demo`, debugPort, targetId: target.id });
  await connection.send('Page.navigate', { url: `http://127.0.0.1:${port}/demo` });
  await waitFor(async () => { const r = await connection.send('Runtime.evaluate', { expression: '!!document.getElementById("hotel")' }); return r.result.value; }, 'demo loaded');
  const tests = [
    ['TC-HOTEL-SEARCH-001', { search: { destination_name: 'Phú Quốc', adults: 2, nights: 1 } }, 'hotel', 'PASS', {}],
    ['TC-MERCH-SEARCH-001', { search: { term: 'snack' } }, 'merch', 'PASS', {}],
    ['TC-INSIDER-DETAIL-001', { product: { id: 'SKU-001' } }, 'insider', 'PASS', {}],
    ['TC-HOTEL-SEARCH-001', { search: { destination_name: 'Phú Quốc', adults: 2, nights: 1 } }, 'hotel', 'FAIL', { missing: true }],
    ['TC-INSIDER-DETAIL-001', { product: { id: 'SKU-001' } }, 'insider', 'FAIL', { skipNetwork: true }],
  ];
  const outcomes = [];
  for (let index = 0; index < tests.length; index++) {
    const [id, context, button, expected, options] = tests[index];
    const before = app.manager.store.events().length;
    await api('step/start', { testCaseId: id, context });
    await connection.send('Runtime.evaluate', { expression: `document.getElementById("missing").checked=${Boolean(options.missing)};document.getElementById("skip-network").checked=${Boolean(options.skipNetwork)}` });
    await connection.send('Runtime.evaluate', { expression: `document.getElementById(${JSON.stringify(button)}).click()` });
    if (options.skipNetwork) {
      await waitFor(() => app.manager.store.events().slice(before).some(e => e.layer === 'JS_QUEUE' && e.step_id === app.manager.currentStep.id), 'Insider queue event without tracking request');
    } else {
      await waitFor(() => app.manager.store.events().slice(before).some(e => e.network?.phase === 'response' && e.step_id === app.manager.currentStep.id), 'tracking response');
    }
    const result = await api('step/complete'); const latest = result.results.find(r => r.step_id === result.steps.at(-1).id); assert.equal(latest.verdict, expected, JSON.stringify(latest));
    if (options.skipNetwork) {
      assert.equal(latest.results.find(r => r.layer === 'JS_QUEUE')?.verdict, 'PASS');
      assert.equal(latest.results.find(r => r.layer === 'TRACKING_REQUEST')?.verdict, 'FAIL');
      assert.equal(app.manager.store.events().slice(before).some(e => e.layer === 'TRACKING_REQUEST' && e.step_id === latest.step_id), false);
    }
    outcomes.push({ test_case_id: id, scenario: options.skipNetwork ? 'queue-present-network-missing' : options.missing ? 'missing-destination-id' : 'valid', verdict: latest.verdict, layers: latest.results.map(r => ({ layer: r.layer, verdict: r.verdict })) });
  }
  const finished = await api('finish'); assert.ok(finished.exported.xlsx);
  const download = await fetch(`http://127.0.0.1:${port}${finished.exported.xlsx}`); assert.equal(download.status, 200); assert.ok((await download.arrayBuffer()).byteLength > 1000);
  const rejected = await fetch(`http://127.0.0.1:${port}/api/step/start`, { method: 'POST', body: '{}' }); assert.equal(rejected.status, 403);
  await connection.send('Page.navigate', { url: `http://127.0.0.1:${port}` });
  await connection.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  await waitFor(async () => { const r = await connection.send('Runtime.evaluate', { expression: 'document.getElementById("event-count")?.textContent' }); return Number(r.result.value) > 0; }, 'dashboard rendered');
  // Reflect this smoke's browser and URL in the next-session controls for a clear screenshot.
  await connection.send('Runtime.evaluate', { expression: `document.getElementById("browser").value=${JSON.stringify(browserName)};document.getElementById("debug-port").value=${debugPort};document.getElementById("url").value=${JSON.stringify(`http://127.0.0.1:${port}/demo`)}` });
  const rendered = await connection.send('Runtime.evaluate', { expression: 'JSON.stringify({title:document.title,eventCount:document.getElementById("event-count")?.textContent,error:document.getElementById("error")?.textContent,bodyWidth:document.body.scrollWidth,viewportWidth:innerWidth})', returnByValue: true });
  const dashboard = JSON.parse(rendered.result.value);
  assert.equal(dashboard.error?.trim(), '', JSON.stringify(dashboard));
  assert.ok(dashboard.bodyWidth <= dashboard.viewportWidth, JSON.stringify(dashboard));
  const screenshot = await connection.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await fs.writeFile(path.join(output, 'dashboard.png'), Buffer.from(screenshot.data, 'base64'));
  await fs.writeFile(path.join(output, 'observations.json'), JSON.stringify({ tested_at: new Date().toISOString(), browser: browserName, outcomes, session_id: app.manager.session.id, event_count: finished.eventCount, report_dir: app.manager.runDir, csrf_rejected: true, dashboard }, null, 2));
  console.log(JSON.stringify({ browser: browserName, outcomes, reportDir: app.manager.runDir, screenshot: path.join(output, 'dashboard.png') }, null, 2));
} finally {
  // Close the owned browser before the HTTP server so its dashboard polling
  // cannot keep teardown waiting on active requests.
  if (connection && !connection.closed) await connection.send('Browser.close').catch(() => {});
  connection?.close();
  if (browser?.process && !browser.process.killed) browser.process.kill();
  await app.close();
}
