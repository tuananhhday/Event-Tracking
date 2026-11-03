// Full application smoke: UI -> saved workflow -> Chrome -> event QA -> existing downloads.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../src/browser/launcher.mjs';

process.env.EVENTQA_HEADLESS = '1';
const { createApp } = await import('../src/server.mjs');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-automation-app-'));
let app, browser;
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const debugPort = socket.address().port;
await new Promise(resolve => socket.close(resolve));
try {
  app = await createApp({ mode: 'cdp-ai', port: 0, runsDir: path.join(directory, 'runs'),
    aiClient: { diagnostics: () => ({ enabled: false, configured_key_count: 0 }), close() {}, complete() { throw new Error('Smoke must never call AI'); } },
    automationOptions: { debugPort, profileDir: path.join(directory, 'profile') } });
  const origin = await app.listen();
  browser = await chromium.launch({ executablePath: findBrowser(process.env.EVENTQA_SMOKE_BROWSER || 'chrome'), headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('tab', { name: 'Luồng tự động', exact: true }).click();
  const workflow = JSON.parse(await fs.readFile(new URL('../examples/automation-demo.json', import.meta.url), 'utf8'));
  workflow.url = `${origin}/demo`; workflow.steps[1].case_id = 'TC-HOTEL-SEARCH-001';
  await page.locator('#automation-file').setInputFiles({ name: 'demo.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(workflow)) });
  await page.locator('#automation-load-json').click();
  await page.locator('#automation-save').click();
  await page.locator('#automation-run-current').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('automation-run-current').disabled);
  const response = page.waitForResponse(value => value.url().endsWith('/api/automation/run') && value.request().method() === 'POST');
  await page.locator('#automation-run-current').click();
  assert.equal((await response).status(), 202);
  await app.automation.wait();
  await page.waitForFunction(() => document.querySelector('#automation-run .automation-run-overview')?.textContent.includes('Hoàn tất'));
  assert.equal(app.automation.run.status, 'COMPLETED', JSON.stringify(app.automation.run));
  const qa = app.manager.snapshot().results.find(result => result.test_case_id === 'TC-HOTEL-SEARCH-001' && result.step_id);
  assert.equal(qa?.verdict, 'PASS', JSON.stringify(qa));
  await page.getByRole('button', { name: 'Mở phần báo cáo', exact: true }).click();
  await page.locator('#downloads a[href="/download/report.xlsx"]').waitFor({ state: 'visible' });
  assert.equal((await page.request.get(`${origin}/download/report.xlsx`)).status(), 200);
  assert.equal((await page.request.get(`${origin}/download/workflow-results.json`)).status(), 200);
  assert.deepEqual(errors, []);
  const screenshot = path.resolve('.tmp/automation-app-smoke.png');
  await fs.mkdir(path.dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(JSON.stringify({ result: 'PASS', ui: true, savedWorkflow: true, realChrome: true, qa: qa.verdict, reports: app.automation.run.reports, screenshot }, null, 2));
} finally {
  await browser?.close();
  await app?.close();
  const target = path.resolve(directory), temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(target.startsWith(temporaryRoot) && path.basename(target).startsWith('eventqa-automation-app-'));
  await fs.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
