import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { findBrowser } from '../src/browser/launcher.mjs';
import { renderHtmlReport } from '../src/report/html.mjs';

process.env.EVENTQA_HEADLESS = '1';
const { createApp } = await import('../src/server.mjs');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-inspection-smoke-'));
let app, browser;
const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const debugPort = socket.address().port; await new Promise(resolve => socket.close(resolve));
try {
  app = await createApp({ mode: 'cdp-ai', runsDir: path.join(directory, 'runs'), port: 0, initialCases: [],
    aiClient: { diagnostics: () => ({ enabled: false, configured_key_count: 0 }), close() {} }, automationOptions: { debugPort, profileDir: path.join(directory, 'profile') } });
  const base = await app.listen(); browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } }), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.getByRole('tab', { name: /Luồng tự động/ }).click();
  const workflow = { name: 'TP2 smoke', url: `${base}/demo`, export_report: false, steps: [{ name: 'Gửi TP2', actions: [
    { type: 'check', locator: { by: 'css', value: '#tp2-wrong-price' }, checked: true },
    { type: 'click', locator: { by: 'css', value: '#tp2-send' } },
  ], expected_events: [{ event_name: 'purchase_demo', source: 'TP2', layer: 'TRACKING_REQUEST' }] }] };
  await page.locator('#automation-file').setInputFiles({ name: 'tp2.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(workflow)) });
  await page.locator('#automation-load-json').click(); await page.locator('#automation-save').click();
  await page.waitForFunction(() => !document.getElementById('automation-run-current').disabled);
  const started = page.waitForResponse(response => response.url().endsWith('/api/automation/run') && response.request().method() === 'POST');
  await page.locator('#automation-run-current').click(); assert.equal((await started).status(), 202); await app.automation.wait();
  assert.equal(app.automation.run.status, 'COMPLETED', JSON.stringify(app.automation.run));
  assert.ok(!(await fs.readdir(app.manager.runDir)).includes('report.xlsx'));
  await page.getByRole('tab', { name: /TP2 ↔ API/ }).click();
  await page.getByRole('button', { name: 'Xem / đối chiếu' }).click();
  await page.locator('#tp2-api-choice').selectOption({ index: 1 });
  await page.waitForFunction(() => document.getElementById('tp2-map-pattern').value.includes('/demo/api/products'));
  await page.locator('#tp2-map-event-id').fill('product_id'); await page.locator('#tp2-map-api-id').fill('data.id');
  await page.locator('#tp2-map-fields').fill(JSON.stringify([{ event_path: 'price', api_path: 'data.price', type: 'number' }]));
  await page.locator('#tp2-save-mapping').click();
  await page.waitForFunction(() => document.getElementById('tp2-comparison').textContent.includes('Lệch'));
  assert.ok((await page.locator('#tp2-decoded').textContent()).includes('500000'));
  await fs.mkdir('.tmp', { recursive: true }); await page.screenshot({ path: '.tmp/tp2-tab.png', fullPage: true });
  await page.locator('#tp2-close').click();
  await page.getByRole('button', { name: 'Xuất báo cáo…', exact: true }).click();
  await page.locator('#export-events').uncheck(); await page.locator('#export-api').check(); await page.locator('#export-format').selectOption('html');
  await page.locator('#export-confirm').click(); await page.locator('#export-dialog').waitFor({ state: 'hidden' });
  const state = app.state(); assert.deepEqual(Object.keys(state.exported), ['api_html']);
  const report = await browser.newPage({ viewport: { width: 1600, height: 1100 } }); await report.goto(pathToFileURL(path.join(app.manager.runDir, 'api-report.html')).href);
  await report.locator('#body tr').first().waitFor(); assert.ok((await report.locator('#body').textContent()).includes('/demo/api/products/ROOM-TP2'));
  await report.locator('#body button').first().click(); await report.locator('#detail').waitFor({ state: 'visible' });
  assert.ok((await report.locator('#detail-body').textContent()).includes('ROOM-TP2')); await report.locator('#close-detail').click();
  await report.screenshot({ path: '.tmp/api-report.png', fullPage: true });
  const xssFile = path.join(directory, 'viewer-xss.html');
  await fs.writeFile(xssFile, renderHtmlReport({ sections: [{ id: 'test', title: 'Test', columns: [{ key: 'name', label: 'Tên' }], rows: Array.from({ length: 120 }, (_, index) => ({ name: index === 0 ? '</script><img src=x onerror="window.executed=true">' : `Row ${index}`, status: 'MATCH', details: { raw: '<script>window.executed=true</script>' } })) }] }));
  await report.goto(pathToFileURL(xssFile).href); assert.equal(await report.locator('#body tr').count(), 50);
  assert.equal(await report.evaluate(() => window.executed), undefined); await report.locator('#next').click(); assert.equal(await report.locator('#body tr').count(), 50);
  await report.locator('#search').fill('Row 119'); assert.equal(await report.locator('#body tr').count(), 1);
  await page.bringToFront(); app.manager.start({ environment: 'END_ONLY_UI_FIXTURE' });
  await page.evaluate(() => EventQA.refresh());
  await page.locator('#bar-secondary').click();
  await page.waitForFunction(() => document.getElementById('finish').disabled);
  assert.equal(app.manager.session.status, 'COMPLETED');
  assert.ok(!(await fs.readdir(app.manager.runDir)).some(name => /^(report\.|comparison\.json|bugs\.md)/.test(name)));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', tp2Capture: true, decoded: true, comparison: 'MISMATCH', noReportOnFinish: true, apiOnly: true, offlineHtml: true, pagination: true, escapedContent: true }, null, 2));
} finally {
  await browser?.close(); await app?.close();
  const target = path.resolve(directory); assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('eventqa-inspection-smoke-'));
  await fs.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
