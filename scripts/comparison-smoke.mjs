import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../src/browser/launcher.mjs';
import { createApp } from '../src/server.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-comparison-ui-'));
const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
const spec = (id, flow, service) => ({ id, name: 'page_view', flow, source: 'INSIDER', sample: { event: 'page_view', default_parameters: { service } },
  rules: [{ event_name: 'page_view', source: 'INSIDER', layer: 'TRACKING_REQUEST', fields: { 'default_parameters.service': { op: 'eq', value: service } } }] });
const cases = [spec('HOTEL', 'Khách sạn · tìm kiếm và đặt phòng', 'hotel'), spec('MERCH', 'Đồ lưu niệm · tìm sản phẩm và mua hàng', 'merch')];
const errors = [], results = [];
try {
  for (const mode of ['cdp', 'cdp-ai']) {
    const app = await createApp({ mode, port: 0, runsDir: path.join(dir, mode), initialCases: [], aiClient: { diagnostics: () => ({ enabled: false, configured_key_count: 0 }), close() {} } });
    try {
      const base = await app.listen(), page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
      page.on('pageerror', error => errors.push(`${mode}: ${error.message}`));
      await page.goto(base);
      await page.locator('[data-stage="spec"] .stage-head').click();
      await page.locator('#spec-file').setInputFiles({ name: 'hotel-merch.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ cases })) });
      await page.waitForFunction(() => document.getElementById('spec-file-status').textContent.includes('hotel-merch.json'));
      await page.locator('#import').click();
      await page.waitForFunction(() => document.getElementById('spec-table').textContent.includes('Chưa chọn luồng'));
      app.manager.start({ target_url: `${base}/demo` });
      const emit = service => app.manager.emit({ source: 'INSIDER', layer: 'TRACKING_REQUEST', event_name: 'page_view', payload: { event: 'page_view', default_parameters: { service } }, page: { target_id: 'TAB', url: `${base}/hotel` } });
      const before = emit('hotel'); await page.evaluate(() => EventQA.refresh());
      assert.ok(!await page.locator('[data-stage="step"]').isVisible());
      assert.equal(app.state().specCoverage.totals.seen, 0);
      await page.locator('#comparison-controls [data-action="select-flow"]').click();
      await page.locator('#comparison-flow-search').fill('Khách sạn');
      assert.equal(await page.locator('[data-choose-flow]').count(), 1);
      await page.locator('[data-choose-flow]').click();
      await page.locator('#comparison-flow-dialog').waitFor({ state: 'hidden' });
      const hotel = emit('hotel'); await page.evaluate(() => EventQA.refresh());
      assert.equal(app.state().specCoverage.rows.length, 1); assert.equal(app.state().specCoverage.rows[0].status, 'MATCH');
      await page.waitForFunction(() => document.getElementById('spec-table').textContent.includes('Khớp'));
      assert.ok((await page.locator('#spec-table').textContent()).includes('Khớp'));
      await page.locator('[data-action="retest-flow"]').click();
      await page.waitForFunction(() => document.getElementById('spec-table').textContent.includes('Chưa thấy trong lượt này'));
      emit('merch'); const correct = emit('hotel'); await page.evaluate(() => EventQA.refresh());
      assert.equal(app.state().specCoverage.rows[0].status, 'MISMATCH');
      await page.locator('[data-change-comparison-event]').click();
      assert.equal(await page.locator(`[data-choose-comparison-event="${before.evidence_id}"]`).count(), 0);
      assert.equal(await page.locator(`[data-choose-comparison-event="${hotel.evidence_id}"]`).count(), 0);
      await page.locator(`[data-choose-comparison-event="${correct.evidence_id}"]`).click();
      await page.locator('#comparison-event-dialog').waitFor({ state: 'hidden' });
      assert.equal(app.state().specCoverage.rows[0].status, 'MATCH');
      await page.locator('[data-spec-detail]').click();
      await page.locator('#spec-detail-dialog').waitFor({ state: 'visible' });
      assert.ok((await page.locator('#spec-detail-content').textContent()).includes('hotel'));
      await page.locator('#spec-detail-close').click();
      await page.locator('[data-action="pause-comparison"]').click();
      emit('merch'); await page.evaluate(() => EventQA.refresh()); assert.equal(app.state().specCoverage.rows[0].status, 'MATCH');
      await page.locator('#comparison-controls [data-action="select-flow"]').click();
      await page.locator('#comparison-flow-search').fill('Đồ lưu niệm'); await page.locator('[data-choose-flow]').click();
      await page.locator('#comparison-flow-dialog').waitFor({ state: 'hidden' });
      assert.equal(app.state().specCoverage.rows[0].status, 'NOT_SEEN'); emit('merch'); await page.evaluate(() => EventQA.refresh());
      assert.equal(app.state().specCoverage.rows[0].case_id, 'MERCH'); assert.equal(app.state().specCoverage.rows[0].status, 'MATCH');
      await page.waitForFunction(() => document.querySelector('#comparison-controls h2').textContent.includes('Đồ lưu niệm') && document.getElementById('spec-table').textContent.includes('Khớp'));
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1080 });
        const size = await page.evaluate(() => ({ body: document.documentElement.scrollWidth, viewport: innerWidth, text: getComputedStyle(document.querySelector('#spec-table td')).fontSize }));
        assert.ok(size.body <= size.viewport + 1, `${mode} has page overflow at ${width}: ${JSON.stringify(size)}`);
        assert.ok(parseFloat(size.text) >= 12 && parseFloat(size.text) <= 14, 'Keep the original compact table typography');
      }
      await page.setViewportSize({ width: 1440, height: 1080 });
      await page.evaluate(() => scrollTo(0, 0));
      await fs.mkdir('.tmp', { recursive: true }); await page.screenshot({ path: `.tmp/comparison-${mode}.png`, fullPage: true });
      await page.getByRole('tab', { name: /Event trực tiếp/ }).click(); await page.locator('[data-action="export-tracking"]').click();
      assert.equal(await page.locator('#export-tracking').isChecked(), true); assert.equal(await page.locator('#export-events').isChecked(), false);
      await page.locator('#export-format').selectOption('all');
      await page.locator('#export-confirm').click(); await page.locator('#export-dialog').waitFor({ state: 'hidden' });
      assert.deepEqual(Object.keys(app.state().exported).sort(), ['tracking_html', 'tracking_json', 'tracking_xlsx']);
      const json = JSON.parse(await fs.readFile(path.join(app.manager.runDir, 'tracking-report.json'), 'utf8'));
      assert.equal(json.inventory[0].count, 6);
      results.push({ mode, flowSelection: true, isolatedRetest: true, changeEvidence: true, pauseAndSwitch: true, trackingExport: true, readableAt: [1440, 768, 390] });
      await page.close();
    } finally { await app.close(); }
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify({ result: 'PASS', results }, null, 2));
} finally {
  await browser.close();
  assert.ok(path.basename(dir).startsWith('eventqa-comparison-ui-')); await fs.rm(dir, { recursive: true, force: true });
}
