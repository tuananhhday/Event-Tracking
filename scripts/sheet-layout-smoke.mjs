import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { chromium } from 'playwright-core';
import { createApp } from '../src/server.mjs';
import { findBrowser } from '../src/browser/launcher.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-sheet-layout-'));
const workbook = new ExcelJS.Workbook(), chosen = 'Khách sạn đặt phòng';
for (let index = 0; index < 30; index++) {
  const name = index === 0 ? 'Tổng hợp Event tracking' : index === 29 ? chosen : `Sheet ${index + 1} · Tracking`;
  const sheet = workbook.addWorksheet(name);
  sheet.addRow(['Luồng', 'Nền tảng', 'Event Name', 'DataLayer Sample']);
  sheet.addRow([name, 'GA4', 'page_view', JSON.stringify({ event: 'page_view', service: index === 29 ? 'hotel' : 'other' })]);
}
const content = Buffer.from(await workbook.xlsx.writeBuffer());
let browser;
const results = [], errors = [];
try {
  browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  for (const mode of ['cdp', 'cdp-ai']) {
    const app = await createApp({ mode, port: 0, runsDir: path.join(directory, mode), initialCases: [], aiClient: { diagnostics: () => ({ enabled: false, configured_key_count: 0 }), close() {} } });
    try {
      const base = await app.listen(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.on('pageerror', error => errors.push(error.message)); await page.goto(base);
      await page.locator('[data-stage="spec"] .stage-head').click();
      await page.locator('#spec-file').setInputFiles({ name: 'Martech_WebOTA_30_sheets.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: content });
      await page.waitForFunction(() => !document.getElementById('sheet-picker-button').disabled);
      assert.equal(await page.locator('#sheet-select').isVisible(), false, 'Native dropdown is replaced by a bounded list of visible text');
      const options = page.locator('#sheet-choices').getByRole('option');
      await page.locator('#sheet-picker-button').click(); assert.equal(await options.count(), 30);
      const list = await page.locator('#sheet-choices').evaluate(element => ({ height: element.clientHeight, scroll: element.scrollHeight, size: getComputedStyle(element.firstElementChild).fontSize, color: getComputedStyle(element.firstElementChild).color }));
      assert.ok(list.height <= 240 && list.scroll > list.height); assert.equal(list.size, '13px'); assert.notEqual(list.color, 'rgb(255, 255, 255)');
      await page.locator('#sheet-search').fill('khach san'); assert.equal(await options.count(), 1);
      assert.equal(await options.textContent(), chosen);
      await page.locator('#sheet-search').press('ArrowDown'); await page.keyboard.press('Enter');
      assert.equal(await page.locator('#sheet').inputValue(), chosen); assert.equal(await page.locator('#sheet-select').inputValue(), chosen);
      assert.equal(await page.locator('#sheet-selected').textContent(), chosen);
      await page.locator('#sheet-picker-button').click(); await page.locator('#sheet-search').press('Escape');
      assert.equal(await page.locator('#sheet-picker-popup').isVisible(), false);
      await page.locator('#sheet-picker-button').click(); await page.locator('#spec-file-status').click();
      assert.equal(await page.locator('#sheet-picker-popup').isVisible(), false);
      const imported = page.waitForResponse(response => response.url().endsWith('/api/import') && response.request().method() === 'POST');
      await page.locator('#import').click(); assert.equal((await imported).status(), 200);
      assert.equal(app.manager.cases[0].provenance.sheet, chosen);
      await page.locator('[data-stage="report"] .stage-head').click();
      for (const width of [2048, 1440, 1024, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const layout = await page.locator('[data-stage="report"]').evaluate(stage => ({
          width: document.documentElement.scrollWidth, viewport: innerWidth,
          buttons: [...stage.querySelectorAll('.stage-body button')].map(button => ({ label: button.textContent.trim(), width: button.clientWidth, clipped: button.scrollHeight > button.clientHeight + 1 || button.scrollWidth > button.clientWidth + 1, font: getComputedStyle(button).fontSize })),
        }));
        assert.ok(layout.width <= layout.viewport + 1, `${mode}: overflow at ${width}`);
        assert.ok(layout.buttons.every(button => !button.clipped && button.width < 300 && parseFloat(button.font) >= 12 && parseFloat(button.font) <= 14), JSON.stringify(layout));
        await page.locator('#sheet-picker-button').click();
        assert.ok(await page.locator('#sheet-choices').getByRole('option', { name: chosen, exact: true }).count());
        await page.locator('#sheet-search').press('Escape');
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.locator('#sheet-picker-button').click(); await page.locator('#sheet-search').fill('khach san');
      await fs.mkdir('.tmp', { recursive: true }); await page.screenshot({ path: `.tmp/sheet-picker-${mode}.png`, fullPage: true });
      await page.locator('#sheet-search').press('Escape');
      results.push({ mode, sheets: 30, searchedByUnaccentedName: true, keyboardSelection: true, correctSheetImported: true, compactButtons: true, widths: [2048, 1440, 1024, 390] });
      await page.close();
    } finally { await app.close(); }
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify({ result: 'PASS', results }, null, 2));
} finally {
  await browser?.close(); assert.ok(path.basename(directory).startsWith('eventqa-sheet-layout-')); await fs.rm(directory, { recursive: true, force: true });
}
