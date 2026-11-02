import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { importSpec } from '../src/spec/import.mjs';
import { matchEvent } from '../src/core/catalog.mjs';
import { queueEvents } from '../src/collectors/cdp.mjs';

// Layouts and typing habits found in Martech_WebOTA / Martech_AppOTA_Insider workbooks.
async function build(t, sheets) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-layouts-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Martech_WebOTA.xlsx');
  const w = new ExcelJS.Workbook();
  for (const [name, fill] of Object.entries(sheets)) fill(w.addWorksheet(name));
  await w.xlsx.writeFile(file);
  return file;
}
const fired = (queue, item, href = 'https://ota.test/vi') => queueEvents({ queue, item, href, title: '', ts: Date.now() }).map((event, index) => ({ ...event, evidence_id: `EV-${index}` }));

test('a guide sheet imports its event table only, not explanations or the parameter dictionary after it', async t => {
  const file = await build(t, { 'Insider user guide': s => {
    s.addRow(['Data type', 'Định nghĩa']);
    s.addRow(['Event', 'Trả lời câu hỏi: User đã làm gì?']);
    s.addRow(['Event name', 'Luồng', 'Trigger point', 'Sample payload', 'Status']);
    s.addRow(['search_hotel', 'Khách sạn', 'Bấm Tìm kiếm', '{"type":"custom_event","value":[{"event_name":"search_hotel","event_parameters":{"custom":{"destination":"Nha Trang"}}}]}', 'TBU']);
    s.addRow(['4.2 Tra cứu param']);
    s.addRow(['Parameter', 'Luồng', 'Event', 'Các giá trị thường dùng', 'Note']);
    s.addRow(['addon_id', 'Hotel', 'addon_selected, cart_page_view']);
  } });
  const { cases } = await importSpec(file, { sheet: 'Insider user guide' });
  assert.deepEqual(cases.map(c => [c.rules[0].event_name, c.flow]), [['search_hotel', 'Khách sạn']]);
});

test('merged cells with an empty master do not stop the import', async t => {
  const file = await build(t, { 'Merchandise 3009': s => {
    s.addRow(['STT', 'Nền tảng', 'Luồng', 'Event Name', 'Sample Payload']);
    s.addRow([1, 'GA4', 'Merchandise', 'search_submit', '{"event":"search_submit","service":"merchandise"}']);
    s.addRow([null, null, null, null, null]);
    s.mergeCells('A3:C3');
  } });
  const { cases } = await importSpec(file, { sheet: 'Merchandise 3009' });
  assert.deepEqual(cases.map(c => c.rules[0].event_name), ['search_submit']);
});

test('numbered, flow-annotated and combined Event Name cells give the event name', async t => {
  const file = await build(t, { 'GA4 - 31.05': s => {
    s.addRow(['STT', 'Nền tảng', 'Luồng', 'Event Name', 'Sample Payload']);
    s.addRow([1, 'GA4', 'Khách sạn', '03. view_item_list', 'dataLayer.push({ ecommerce: null }); // Clear\n\ndataLayer.push({ event: "view_item_list", ecommerce: { items: [{ item_id: "H1", item_name: "Resort" }] } });']);
    s.addRow([2, 'Insider', '', 'product_detail_page_view (Hotel)', '{"type":"product","value":{"id":"H1"}}']);
    s.addRow([3, 'GA4', 'All', 'purchase / confirmation_page_view', '{"event":"purchase"}']);
  } });
  const { cases } = await importSpec(file, { sheet: 'GA4 - 31.05' });
  assert.deepEqual(cases.map(c => [c.rules[0].event_name, c.flow, c.rules[0].event_aliases ?? []]),
    [['view_item_list', 'Khách sạn', []], ['product_detail_page_view', 'Hotel', []], ['purchase', 'All', ['confirmation_page_view']]]);
  // The GTM clear push before the event is not taken as the sample.
  assert.equal(cases[0].sample.event, 'view_item_list');
  const [event] = fired('dataLayer', { event: 'view_item_list', ecommerce: { items: [{ item_id: 'H2', item_name: 'Villa' }] } });
  assert.equal(matchEvent(cases, event).case_id, cases[0].id);
});

test('hand-typed sample slips are read; the new sample wins and "Không đổi" falls back to the old one', async t => {
  const file = await build(t, { 'GA4 & Insider 3009': s => {
    s.addRow(['STT', 'Nền tảng', 'Luồng', 'Event Name', 'Old DataLayer Sample', 'New DataLayer Sample']);
    s.addRow([1, 'GA4', 'Voucher', 'begin_checkout', '{"event":"begin_checkout"}',
      '{\n  "event": "begin_checkout",\n  "service":"voucher";\n  "entry_source": null, --nếu có ai_session_id thì "ai_explorer"\n  "item_variant":"Hue"\n  "item_variant_id":"2c91"",\n  "coupon": "",\n  "date": 2026-07-18,\n  "item_brand": "Vinpearl",  (lấy propertyName)\n  "items": [\n    ...\n  ]\n}']);
    s.addRow([2, 'GA4', 'Voucher', 'view_item', '{"event":"view_item","service":"voucher"}', 'Không đổi']);
    s.addRow([3, 'Insider', 'Voucher', 'cart_page_view', '', '"type": "cart",\n"value": {"total": 269500}']);
    s.addRow([4, 'GA4', 'Train', 'purchase_fail', '', '"{\n  ""event"": ""purchase_fail""\n}"']);
  } });
  const { cases } = await importSpec(file, { sheet: 'GA4 & Insider 3009' });
  const [checkout, view, cart, failed] = cases.map(c => c.sample);
  assert.deepEqual(checkout, { event: 'begin_checkout', service: 'voucher', entry_source: null, item_variant: 'Hue', item_variant_id: '2c91', coupon: '', date: '2026-07-18', item_brand: 'Vinpearl', items: [] });
  assert.deepEqual(view, { event: 'view_item', service: 'voucher' });
  assert.deepEqual(cart, { type: 'cart', value: { total: 269500 } });
  assert.deepEqual(failed, { event: 'purchase_fail' });
});

test('a cell with several Insider objects gives the one whose type names the row event', async t => {
  const file = await build(t, { 'Tổng hợp Event tracking': s => {
    s.addRow(['STT', 'Nền tảng', 'Luồng', 'Event Name', 'DataLayer Sample']);
    s.addRow([1, 'Insider', 'Golf', 'cart_page_view', '// bỏ vé\n{"type":"remove_from_cart","value":{"id":"T1"}}\n// trang giỏ\n{"type":"cart","value":{"total":6800000,"items":[{"id":"T1"}]}}']);
  } });
  const { cases } = await importSpec(file);
  assert.equal(cases[0].sample.type, 'cart');
});

test('a null in the sample keeps a dynamic field optional in value, and the payload names the flow', async t => {
  const file = await build(t, { 'Tổng hợp Event tracking': s => {
    s.addRow(['STT', 'Nền tảng', 'Luồng', 'Event Name', 'DataLayer Sample']);
    s.addRow([1, 'GA4', 'Golf', 'search_submit', '{"event":"search_submit","service":"golf","destination":"Hải Phòng","destination_id":null}']);
    s.addRow([2, 'Insider', 'All', 'listing_page_view', '{"type":"category","value":{"breadcrumb":["Khách sạn","Phú Quốc"]}}']);
    s.addRow([3, 'Insider', 'Khách sạn', 'listing_page_view', '{"type":"category","value":{"breadcrumb":["Khách sạn","Phú Quốc"]}}']);
    s.addRow([4, 'Insider', 'Golf', 'listing_page_view', '{"type":"category","value":{"breadcrumb":["Golf"]}}']);
  } });
  const { cases } = await importSpec(file);
  const [golf] = fired('dataLayer', { event: 'search_submit', service: 'golf', destination: 'Hải Phòng', destination_id: null });
  assert.equal(matchEvent(cases, golf).verdict, 'PASS');
  // Same sample in "All" and "Khách sạn": the breadcrumb word picks the hotel row.
  const [hotel] = fired('InsiderQueue', { type: 'category', value: { breadcrumb: ['Khách sạn', 'Đà Nẵng'] } });
  assert.equal(matchEvent(cases, hotel).case_id, cases[2].id);
  const [course] = fired('InsiderQueue', { type: 'category', value: { breadcrumb: ['Golf', 'Hải Phòng'] } });
  assert.equal(matchEvent(cases, course).case_id, cases[3].id);
});
