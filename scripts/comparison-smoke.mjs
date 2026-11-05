import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowser } from '../src/browser/launcher.mjs';
import { createApp } from '../src/server.mjs';
import { manualCase } from '../src/spec/import.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-comparison-ui-'));
const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
const spec = (id, flow, service) => ({ id, name: 'page_view', flow, source: 'INSIDER', sample: { event: 'page_view', default_parameters: { service } },
  rules: [{ event_name: 'page_view', source: 'INSIDER', layer: 'TRACKING_REQUEST', fields: { 'default_parameters.service': { op: 'eq', value: service } } }] });
const cases = [spec('HOTEL', 'Khách sạn · tìm kiếm và đặt phòng', 'hotel'), spec('MERCH', 'Đồ lưu niệm · tìm sản phẩm và mua hàng', 'merch')];
cases.push({ id: 'ALIAS', name: 'listing_page_view', flow: 'Tên event tương đương', source: 'INSIDER',
  sample: { event: 'Listing Page View', default_parameters: { service: 'hotel' }, custom_parameters: {} },
  rules: [{ event_name: 'listing_page_view', event_aliases: ['Listing Page View'], source: 'INSIDER', layer: 'TRACKING_REQUEST', capture_platform: 'APP_SDK', fields: { 'default_parameters.service': { op: 'eq', value: 'hotel' } } }] });
const productSample = { type: 'product', value: { id: 'SHIRT', name: 'Áo thun', unit_price: 180000, quantity: 1, currency: 'VND' } };
const productCase = manualCase({ source: 'INSIDER', flow: 'Merchandise · chi tiết sản phẩm', event_name: 'product_detail_page_view', sample: JSON.stringify(productSample) }).testCase;
cases.push(productCase);
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
      assert.ok(!(await page.locator('#spec-table thead').textContent()).includes('Trường lệch'));
      await page.locator('.spec-event-name').click();
      await page.locator('#spec-detail-content [data-comparison-verdict="FAIL"]').waitFor();
      const diff = page.locator('#spec-detail-content .event-comparison');
      assert.equal(await diff.getAttribute('data-comparison-mode'), 'differences');
      assert.ok(await diff.locator('.event-diff-row.is-error').count());
      assert.equal(await diff.locator('[data-diff-path="event"]').isVisible(), false);
      await diff.getByRole('button', { name: 'Toàn bộ event', exact: true }).click();
      assert.equal(await diff.locator('[data-diff-path="event"]').isVisible(), true);
      await diff.getByRole('button', { name: 'Chỉ chỗ khác', exact: true }).click();
      await fs.mkdir('.tmp', { recursive: true }); await page.screenshot({ path: `.tmp/event-json-diff-${mode}.png` });
      await page.locator('#spec-detail-content [data-change-comparison-event]').click();
      assert.equal(await page.locator(`[data-preview-comparison="${before.evidence_id}"]`).count(), 0);
      assert.equal(await page.locator(`[data-preview-comparison="${hotel.evidence_id}"]`).count(), 0);
      await page.locator(`[data-preview-comparison="${correct.evidence_id}"]`).click();
      await page.locator('#comparison-preview [data-comparison-verdict="PASS"]').waitFor();
      const buttonSize = await page.locator(`[data-choose-comparison-event="${correct.evidence_id}"]`).evaluate(button => ({ width: button.offsetWidth, height: button.offsetHeight, font: getComputedStyle(button).fontSize, clipped: button.scrollHeight > button.clientHeight + 1 }));
      assert.ok(buttonSize.width < 230 && buttonSize.height <= 48 && buttonSize.font === '14px' && !buttonSize.clipped, JSON.stringify(buttonSize));
      await page.locator(`[data-choose-comparison-event="${correct.evidence_id}"]`).click();
      await page.locator('#comparison-event-dialog').waitFor({ state: 'hidden' });
      assert.equal(app.state().specCoverage.rows[0].status, 'MATCH');
      await page.locator('#spec-detail-content [data-comparison-verdict="PASS"]').waitFor();
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
      await page.locator('#comparison-controls [data-action="select-flow"]').click();
      await page.locator('#comparison-flow-search').fill('Tên event tương đương'); await page.locator('[data-choose-flow]').click();
      await page.locator('#comparison-flow-dialog').waitFor({ state: 'hidden' });
      app.manager.emit({ source: 'INSIDER', layer: 'TRACKING_REQUEST', event_name: 'Listing Page View', page: { target_id: 'TAB', url: `${base}/hotel` },
        payload: { event: 'Listing Page View', default_parameters: { service: 'hotel' }, custom_parameters: {} } });
      await page.evaluate(() => EventQA.refresh()); await page.waitForFunction(() => document.querySelector('.spec-event-name')?.textContent === 'listing_page_view');
      assert.equal(app.state().specCoverage.rows[0].status, 'MATCH');
      await page.locator('.spec-event-name').click(); await page.locator('#spec-detail-content [data-comparison-verdict="PASS"]').waitFor();
      assert.equal(await page.locator('#spec-detail-content .event-diff-row.is-error').count(), 0);
      await page.locator('#spec-detail-close').click();
      await page.locator('#comparison-controls [data-action="select-flow"]').click();
      await page.locator('#comparison-flow-search').fill('Merchandise'); await page.locator('[data-choose-flow]').click();
      await page.locator('#comparison-flow-dialog').waitFor({ state: 'hidden' });
      const productPage = { target_id: 'PRODUCT', url: `${base}/merchandise/duck` };
      const productPush = app.manager.emit({ source: 'INSIDER', layer: 'JS_QUEUE', event_name: 'product_detail_page_view', queue_name: 'InsiderQueue', queue_type: 'product', page: productPage,
        payload: { type: 'product', value: { ...productSample.value, id: 'DUCK', name: 'Vịt con', unit_price: 250000 } } });
      app.manager.emit({ source: 'INSIDER', layer: 'JS_QUEUE', event_name: 'insider_init', queue_type: 'init', page: productPage, payload: { type: 'init' } });
      app.manager.emit({ source: 'INSIDER', layer: 'TRACKING_REQUEST', event_name: 'product_detail_page_view', network: { phase: 'request' }, page: productPage,
        payload: { event: 'pageView', page_type: 'productDetail', product: { id: 'DUCK', name: 'Vịt con', price: { originalValue: 250000, value: 200000, currency: 'VND' }, quantity: 1 } } });
      const wrongVendor = app.manager.emit({ source: 'GA4', layer: 'TRACKING_REQUEST', event_name: 'product_detail_page_view', page: productPage, payload: { event: 'product_detail_page_view' } });
      await page.evaluate(() => EventQA.refresh());
      assert.equal(app.state().specCoverage.rows[0].status, 'MATCH'); assert.equal(app.state().specCoverage.rows[0].seen, 1);
      await page.waitForFunction(() => document.querySelector('.spec-event-name')?.textContent === 'product_detail_page_view');
      await page.locator('.spec-event-name').click(); await page.locator('#spec-detail-content [data-comparison-verdict="PASS"]').waitFor();
      const productDiff = page.locator('#spec-detail-content .event-comparison');
      assert.equal(await productDiff.locator('.event-diff-head').textContent(), 'Đặc tả INSIDERINSIDER · InsiderQueue');
      assert.equal(await productDiff.locator('[data-diff-path^="default_parameters"]').count(), 0);
      const priceRow = productDiff.locator('[data-diff-path="value.unit_price"]');
      assert.ok((await priceRow.textContent()).includes('180000')); assert.ok((await priceRow.textContent()).includes('250000'));
      assert.ok((await priceRow.textContent()).includes('Đạt kiểu số nguyên'));
      assert.ok((await productDiff.textContent()).includes('Đạt quy tắc')); assert.ok((await productDiff.textContent()).includes('chưa được xác nhận với API'));
      assert.equal(await productDiff.locator('.event-diff-row.is-error').count(), 0);
      const sourceCheck = await page.evaluate(async ({ id, selected }) => (await (await fetch(`/api/event?id=${id}&case_id=${selected}`)).json()).spec,
        { id: wrongVendor.evidence_id, selected: productCase.id });
      assert.equal(sourceCheck.verdict, 'FAIL'); assert.equal(sourceCheck.issues[0].code, 'SOURCE_MISMATCH');
      await fs.mkdir('.tmp', { recursive: true }); await page.screenshot({ path: `.tmp/insider-queue-basis-${mode}.png` });
      await page.locator('#spec-detail-content [data-change-comparison-event]').click();
      assert.equal(await page.locator(`[data-preview-comparison="${wrongVendor.evidence_id}"]`).count(), 0);
      await page.locator(`[data-preview-comparison="${productPush.evidence_id}"]`).click();
      await page.locator('#comparison-preview [data-comparison-verdict="PASS"]').waitFor();
      assert.ok((await page.locator('#comparison-preview .event-diff-head').textContent()).includes('INSIDER · InsiderQueue'));
      await page.locator('#comparison-event-dialog [data-action="close-event-picker"]').click(); await page.locator('#spec-detail-close').click();
      await page.getByRole('tab', { name: /Event trực tiếp/ }).click(); await page.locator('[data-action="export-tracking"]').click();
      assert.equal(await page.locator('#export-tracking').isChecked(), true); assert.equal(await page.locator('#export-events').isChecked(), false);
      await page.locator('#export-format').selectOption('all');
      await page.locator('#export-confirm').click(); await page.locator('#export-dialog').waitFor({ state: 'hidden' });
      assert.deepEqual(Object.keys(app.state().exported).sort(), ['tracking_html', 'tracking_json', 'tracking_xlsx']);
      const json = JSON.parse(await fs.readFile(path.join(app.manager.runDir, 'tracking-report.json'), 'utf8'));
      assert.equal(json.inventory.find(row => row.event_name === 'page_view').count, 6);
      results.push({ mode, flowSelection: true, isolatedRetest: true, jsonDiff: true, filterDifferences: true, validAliasPass: true, insiderQueueBasis: true, explicitRuleMeaning: true, sameVendorOnly: true, changeEvidence: true, readableButtons: true, pauseAndSwitch: true, trackingExport: true, readableAt: [1440, 768, 390] });
      await page.close();
    } finally { await app.close(); }
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify({ result: 'PASS', results }, null, 2));
} finally {
  await browser.close();
  assert.ok(path.basename(dir).startsWith('eventqa-comparison-ui-')); await fs.rm(dir, { recursive: true, force: true });
}
