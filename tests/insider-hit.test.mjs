import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { decodeRequest } from '../src/core/decoder.mjs';
import { insiderHitView } from '../src/core/insider-hit.mjs';
import { activityEntries } from '../src/core/activity.mjs';
import { firingChecks } from '../src/core/firing.mjs';
import { specCoverage } from '../src/core/catalog.mjs';
import { importSpec } from '../src/spec/import.mjs';

// Hits the Insider web SDK sent on vinpearlota.com's golf flow (2026-11-01).
const product = { id: '68fe86a4-17e3-45a2-a5cd-b7b37104b2b9', category: ['golf'], imgUrl: 'https://public-assets.vinpearlota.com/golf.jpg', name: 'Vinpearl Golf Hải Phòng',
  url: 'https://vinpearlota.com/vi/golf/vinpearl-hp-golf', price: { value: 4500000, currency: 'VND', originalValue: 4500000 }, quantity: 1,
  customAttributes: { using_date: '2026-11-01T00:00:00.000Z', using_date_str: '2026-11-01', destination: 'HP', golf_club_id: '68fe86a4-17e3-45a2-a5cd-b7b37104b2b9', holes: 18, players: 0 }, productAttributes: {} };
const pageHit = fields => decodeRequest({ url: 'https://hit.api.useinsider.com/hit', body: Buffer.from(JSON.stringify({ version: '1.0', partner_name: 'votaprod', event: 'pageView', session_id: 's', language: 'vi_VN', ...fields })).toString('base64') })[0];
const cartHit = { partner: 'votaprod', source: 'web', event_name: 'item_added_to_cart', timestamp: 1793551806, event_params: { c_tee_time: '05:30', c_destination: 'HP', c_holes: 18,
  pid: 'vinpearl-hp-golf_18_A_1_05:30', na: 'A Course - Điểm phát bóng 1 - 05:30', cu: 'VND', nc_cu: 'VND', up: 4500000, nc_up: 4500000, usp: 4500000, url: 'https://vinpearlota.com/vi/golf/vinpearl-hp-golf', piu: 'https://public-assets.vinpearlota.com/golf.jpg', qu: 1, ta: ['golf'] } };

test('Insider page hits are named and listed as Insider records them (Product Page View, as in R1511)', () => {
  const productView = pageHit({ page_type: 'productDetail', current_url: product.url, product });
  assert.equal(productView.event_name, 'product_detail_page_view');
  assert.deepEqual(insiderHitView(productView.event_name, productView.payload), {
    event: 'Product Page View',
    default_parameters: { product_id: product.id, product_name: product.name, product_image_url: product.imgUrl, taxonomy: ['golf'], unit_price: 4500000, unit_sale_price: 4500000, currency: 'VND', quantity: 1, url: product.url },
    custom_parameters: product.customAttributes,
  });
  const listing = pageHit({ page_type: 'category', category: ['Golf'], products: [] });
  assert.deepEqual(insiderHitView(listing.event_name, listing.payload), { event: 'Listing Page View', default_parameters: { taxonomy: ['Golf'] }, custom_parameters: {} });
  assert.deepEqual(['main', 'other', 'cart'].map(type => pageHit({ page_type: type }).event_name), ['homepage_view', 'other_page_view', 'cart_page_view']);
});

test('Insider event-API hits use Insider parameter names: Item Added to Cart as in R1511', () => {
  const [hit] = decodeRequest({ url: 'https://unification.useinsider.com/api/event/v1/insert', body: JSON.stringify(cartHit), contentType: 'application/json' });
  const view = insiderHitView(hit.event_name, hit.payload);
  assert.equal(view.event, 'Item Added to Cart');
  assert.deepEqual(view.default_parameters, { product_id: 'vinpearl-hp-golf_18_A_1_05:30', product_name: 'A Course - Điểm phát bóng 1 - 05:30', currency: 'VND', unit_price: 4500000, unit_sale_price: 4500000,
    url: 'https://vinpearlota.com/vi/golf/vinpearl-hp-golf', product_image_url: 'https://public-assets.vinpearlota.com/golf.jpg', quantity: 1, taxonomy: ['golf'] });
  assert.deepEqual(view.custom_parameters, { tee_time: '05:30', destination: 'HP', holes: 18 });
});

test('a repeat is the same vendor, event and page again within seconds; a GA4 and an Insider page view are not, nor a second GA4 property', () => {
  const at = ms => new Date(Date.UTC(2026, 10, 1, 16, 50, 0) + ms).toISOString();
  const page = { url: product.url, target_id: 'tab' };
  const hit = (id, source, name, payload, ms, url = page.url) => ({ evidence_id: id, layer: 'TRACKING_REQUEST', source, event_name: name, payload, captured_at: at(ms), page: { ...page, url }, network: { phase: 'request' } });
  const events = [
    hit('ga-pv', 'GA4', 'page_view', { v: '2', tid: 'G-LK3M5B2Y8Y', event: 'page_view' }, 0),
    hit('ga-pv-b', 'GA4', 'page_view', { v: '2', tid: 'G-2NDPROPRTY', event: 'page_view' }, 20),
    hit('in-pv-1', 'INSIDER', 'product_detail_page_view', { event: 'pageView', page_type: 'productDetail', product }, 500),
    hit('in-pv-2', 'INSIDER', 'product_detail_page_view', { event: 'pageView', page_type: 'productDetail', product }, 4600),
    hit('ga-pv-2', 'GA4', 'page_view', { v: '2', tid: 'G-LK3M5B2Y8Y', event: 'page_view' }, 8300, `${page.url}?date=2026-11-07`),
  ];
  const rows = activityEntries(events, { now: Date.parse(at(60000)) });
  assert.deepEqual(rows.map(row => [row.display_name, row.repeat?.after_ms ?? null]), [['page_view', null], ['page_view', null], ['Product Page View', null], ['Product Page View', 4100], ['page_view', 8300]]);
  assert.equal(rows[0].measurement_id, 'G-LK3M5B2Y8Y');
  const repeats = [...firingChecks(events).byEvent.values()].flat().filter(check => check.rule === 'DUPLICATE').map(check => check.message);
  assert.equal(repeats.length, 2);
  assert.match(repeats[1], /URL chỉ khác tham số/);
});

test('web Insider hits are checked against an AppOTA_Insider sheet (R1511) without the app-only fields', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-r1511-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Martech_AppOTA_Insider.xlsx');
  const w = new ExcelJS.Workbook(), s = w.addWorksheet('R1511');
  const app = { app_version: '1.0', device_manufacturer: 'Google', device_model: 'Pixel 6 Pro', os_version: '17', platform: 'AppOTA' };
  s.addRow(['Luồng', 'Event Name', 'Mô tả', 'Chi tiết event']);
  s.addRow(['Golf', 'listing_page_view', 'Kết quả tìm kiếm Golf', JSON.stringify({ event: 'Listing Page View', default_parameters: { taxonomy: ['golf'] }, custom_parameters: { ...app, breadcrumb: ['Golf'] } })]);
  s.addRow(['Golf', 'product_detail_page_view', 'Chi tiết sân', JSON.stringify({ event: 'Product Page View', default_parameters: { currency: 'VND', product_id: 'x', product_name: 'y', quantity: 1, taxonomy: ['golf'], unit_price: 1, unit_sale_price: 1, url: 'u' }, custom_parameters: { ...app, holes: 18, players: 0, using_date_str: '2026-09-07' } })]);
  s.addRow(['Golf', 'add_to_cart', 'Chọn tee time', JSON.stringify({ event: 'Item Added to Cart', default_parameters: { currency: 'VND', product_id: 'x', quantity: 1, taxonomy: ['golf'] }, custom_parameters: { ...app, tee_time: '18:00' } })]);
  await w.xlsx.writeFile(file);
  const { cases } = await importSpec(file, { sheet: 'R1511' });
  const [cart] = decodeRequest({ url: 'https://unification.useinsider.com/api/event/v1/insert', body: JSON.stringify(cartHit), contentType: 'application/json' });
  const events = [pageHit({ page_type: 'category', category: ['Golf'], products: [] }), pageHit({ page_type: 'productDetail', product }), cart]
    .map((event, index) => ({ ...event, evidence_id: `EV-${index}`, captured_at: new Date(Date.UTC(2026, 10, 1) + index * 1000).toISOString() }));
  const coverage = specCoverage(cases, events);
  const row = name => coverage.rows.find(r => r.event_name === name);
  assert.equal(row('product_detail_page_view').status, 'MATCH', 'app-only fields are not expected from the web');
  assert.equal(row('add_to_cart').status, 'MATCH', 'found through the name Insider shows');
  // Real differences stay: the web sends taxonomy "Golf" and no breadcrumb.
  assert.equal(row('listing_page_view').status, 'MISMATCH');
  assert.deepEqual(row('listing_page_view').issues.map(issue => [issue.code, issue.path]), [['VALUE_MISMATCH', 'default_parameters.taxonomy'], ['MISSING_FIELD', 'custom_parameters.breadcrumb']]);
});
