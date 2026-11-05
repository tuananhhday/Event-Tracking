// Real UI -> mocked AI planner -> saved flows -> real Playwright -> captured events.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import JSZip from 'jszip';
import { chromium } from 'playwright-core';
import { findBrowser } from '../src/browser/launcher.mjs';
process.env.EVENTQA_HEADLESS = '1';
const { createApp } = await import('../src/server.mjs');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-guide-smoke-'));
const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const debugPort = socket.address().port; await new Promise(resolve => socket.close(resolve));
let app, browser, aiCalls = 0, capturedEvents = 0;
try {
  const template = JSON.parse(await fs.readFile(new URL('../examples/automation-demo.json', import.meta.url), 'utf8'));
  app = await createApp({ mode: 'cdp-ai', port: 0, runsDir: path.join(directory, 'runs'), automationOptions: { debugPort, profileDir: path.join(directory, 'profile') },
    aiClient: { diagnostics: () => ({ enabled: true, configured_key_count: 1 }), close() {},
      async complete(_model, _system, input, _schema, validate) {
        aiCalls++; assert.ok(input.page.controls.some(control => control.label === 'Điểm đến'), 'The actual website must be read before planning');
        const workflows = [1, 2].map(number => ({ ...structuredClone(template), name: `Tìm khách sạn ${number}`, url: input.url, export_report: false }));
        for (const workflow of workflows) workflow.steps[1].case_id = 'TC-HOTEL-SEARCH-001';
        const data = { workflows }; assert.equal(validate(data), null); return { available: true, data };
      } } });
  const base = await app.listen(); browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1150 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.getByRole('tab', { name: 'Luồng tự động', exact: true }).click();
  await page.locator('#automation-url').fill(`${base}/demo`);
  const description = 'Luồng 1: tìm khách sạn Phú Quốc.\nLuồng 2: tìm lại khách sạn.\nNhập 2 người lớn, ở 1 đêm. Bấm Tìm khách sạn, chờ event search_submit.';
  await page.locator('#automation-instructions').fill(description);
  await page.locator('#automation-draft').click();
  await page.waitForFunction(() => document.querySelectorAll('#automation-plan-choice option').length === 2);
  assert.equal(aiCalls, 1); assert.equal(app.manager.session, undefined, 'Planning must not execute the workflow');
  assert.equal(await page.locator('#automation-advanced').getAttribute('open'), null);
  // Changing natural-language instructions invalidates the previously generated plan.
  await page.locator('#automation-instructions').fill(description + '\nGiữ dữ liệu đã nhập.');
  assert.equal(await page.locator('#automation-save').isDisabled(), true);
  await page.locator('#automation-draft').click();
  await page.waitForFunction(() => !document.getElementById('automation-save').disabled);
  assert.equal(aiCalls, 2);
  await page.locator('#automation-plan-choice').selectOption('1');
  await page.locator('#automation-preview details summary').first().click();
  await page.locator('[data-plan-step="0"][data-plan-key="name"]').fill('Điền dữ liệu tìm kiếm');
  await page.locator('[data-plan-step="0"][data-plan-key="name"]').press('Tab');
  await page.locator('#automation-save').click();
  await page.waitForFunction(() => !document.getElementById('automation-run-current').disabled);
  assert.equal(app.automation.state().workflows.length, 2);
  assert.match(app.automation.state().workflows[1].instructions, /Giữ dữ liệu/);
  assert.equal(app.automation.state().workflows[1].steps[0].name, 'Điền dữ liệu tìm kiếm');
  const started = page.waitForResponse(response => response.url().endsWith('/api/automation/run') && response.request().method() === 'POST');
  await page.locator('#automation-run-current').click(); assert.equal((await started).status(), 202); await app.automation.wait();
  assert.equal(app.automation.run.status, 'COMPLETED', JSON.stringify(app.automation.run));
  assert.equal(app.automation.run.results.length, 2);
  assert.ok(app.manager.snapshot().events.some(event => event.event_name === 'search_submit'));
  capturedEvents = app.manager.snapshot().events.length;
  assert.equal(aiCalls, 2, 'Running saved workflows must not call AI');
  // Word import populates the same description editor without executing anything.
  await page.waitForFunction(() => !document.getElementById('automation-new').disabled);
  await page.locator('#automation-new').click();
  const word = new JSZip(); word.file('word/document.xml', '<w:document><w:p><w:r><w:t>Luồng 1: Nhập Phú Quốc rồi bấm Tìm khách sạn.</w:t></w:r></w:p></w:document>');
  await page.locator('#automation-file').setInputFiles({ name: 'flows.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await word.generateAsync({ type: 'nodebuffer' }) });
  await page.waitForFunction(() => document.getElementById('automation-instructions').value.includes('Nhập Phú Quốc'));
  assert.equal(await page.locator('#automation-save').isDisabled(), true); assert.equal(aiCalls, 2);
  // A genuinely absent field fails honestly and shows the controls the actual
  // browser saw, rather than requiring a user to open developer tools.
  await page.waitForFunction(() => !document.getElementById('automation-file').disabled);
  const invalidTarget = { name: 'Missing target diagnostic', url: `${base}/demo`, export_report: false, steps: [{ name: 'Missing field', actions: [{ type: 'fill', locator: { by: 'label', value: 'NONEXISTENT_FIELD' }, value: 'PRIVATE_TEST_VALUE', timeout_ms: 500 }] }] };
  await page.locator('#automation-file').setInputFiles({ name: 'missing-target.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalidTarget)) });
  await page.locator('#automation-save').click();
  await page.waitForFunction(() => !document.getElementById('automation-run-current').disabled);
  const failed = page.waitForResponse(response => response.url().endsWith('/api/automation/run') && response.request().method() === 'POST');
  await page.locator('#automation-run-current').click(); await failed; await app.automation.wait();
  assert.equal(app.automation.run.status, 'FAILED');
  await page.locator('#automation-observed-controls').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#automation-observed-controls').textContent()).includes('Điểm đến'));
  assert.equal(JSON.stringify(app.automation.run).includes('PRIVATE_TEST_VALUE'), false);
  assert.deepEqual(errors, []);
  await fs.mkdir('.tmp', { recursive: true }); await page.screenshot({ path: '.tmp/automation-guide-smoke.png', fullPage: true });
  console.log(JSON.stringify({ result: 'PASS', typedInstructions: true, realPageInspection: true, planner: 'MOCK', savedFlows: 2, playwrightRuns: 2, stalePlanBlocked: true, noJsonNeeded: true, wordImport: true, missingTargetReported: true, capturedEvents }, null, 2));
} finally {
  await browser?.close(); await app?.close();
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(directory).startsWith('eventqa-guide-smoke-'));
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
