import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { moneyKey, apiPrices, priceChecks } from '../src/core/api-prices.mjs';
import { activityEntries } from '../src/core/activity.mjs';
import { decodeRequest } from '../src/core/decoder.mjs';
import { loadRun } from '../src/core/session.mjs';
import { exportReports } from '../src/report/export.mjs';
import { createApp } from '../src/server.mjs';

const iso = ms => new Date(Date.UTC(2026, 10, 2, 9, 0, 0) + ms).toISOString();
const page = { url: 'https://hotel.test/vi/hotel/nha-trang', target_id: 'tab' };
const hotelApi = { data: { hotel: { id: 'H-NT-01', slug: 'vinpearl-resort-nha-trang', name: 'Vinpearl Resort Nha Trang', totalCount: 2, currencyCode: 'VND',
  rooms: [{ roomTypeId: 'DLX', name: 'Deluxe', maxAdults: 2, discountPercent: 17, promoCode: 'SUMMER', price: { value: 1000000, currency: 'VND', originalValue: 1200000 } },
    { roomTypeId: 'STE', name: 'Suite', price: { value: '2500000', currency: 'VND' } }] },
  guest: { name: 'Nguyễn Văn A', totalSpent: 9000000 } } };
// A GA4 hit as it leaves the browser: view_item of one room.
const ga4Hit = (id, fields, ms = 1000) => ({ ...decodeRequest({ url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST', body: new URLSearchParams(fields).toString(), contentType: 'text/plain' })[0],
  evidence_id: id, captured_at: iso(ms), page });
const viewItem = (id, price, ms) => ga4Hit(id, { en: 'view_item', cu: 'VND', 'epn.value': String(price), pr1: `idDLX~nmDeluxe~pr${price}~qt1` }, ms);
const record = (prices, ms = 0, tab = 'tab') => ({ captured_at: iso(ms), url: 'https://api.hotel.test/rooms', method: 'GET', page: { ...page, target_id: tab }, prices });
const check = (events, records) => priceChecks(activityEntries(events, { now: Date.parse(iso(60000)) }), records).checks;

test('money fields are told apart from counts, rates and ids', () => {
  for (const key of ['price', 'unit_price', 'salePrice', 'totalAmount', 'pricePerNight', 'green_fee', 'originalValue', 'tax']) assert.ok(moneyKey(key), key);
  for (const key of ['totalCount', 'priceType', 'discountPercent', 'taxRate', 'totalNights', 'quantity', 'productId', 'holes', 'value']) assert.ok(!moneyKey(key), key);
  assert.ok(moneyKey('value', { bareValue: true }), 'GA4 value');
});

test('an API response keeps only its prices, each with the ids and name of its product; people are not products', () => {
  const prices = apiPrices(hotelApi);
  assert.deepEqual(prices.map(entry => [entry.path, entry.value, entry.name ?? null]), [
    ['data.hotel.rooms[0].price.value', 1000000, 'Deluxe'], ['data.hotel.rooms[0].price.originalValue', 1200000, 'Deluxe'],
    ['data.hotel.rooms[1].price.value', 2500000, 'Suite'], ['data.guest.totalSpent', 9000000, null]]);
  assert.deepEqual(prices[0].ids, ['DLX', 'H-NT-01', 'vinpearl-resort-nha-trang'], 'currencyCode and promoCode are not product ids');
  assert.ok(!JSON.stringify(prices).includes('Nguyễn'), 'a guest name is never kept');
});

test('a price sent to Google that differs from the website API for the same product is a mismatch (500.000 sent, API 1.000.000)', () => {
  const records = [record(apiPrices(hotelApi))];
  const wrong = check([viewItem('EV-1', 500000)], records);
  assert.deepEqual(wrong.map(c => [c.field, c.sent, c.status, c.api.value, c.api.path]), [
    ['items[0].price', 500000, 'MISMATCH', 1000000, 'data.hotel.rooms[0].price.value'], ['value', 500000, 'MISMATCH', 1000000, 'data.hotel.rooms[0].price.value']]);
  assert.deepEqual(wrong[0].candidates.map(other => other.value), [1000000, 1200000], 'the other prices of the room are listed');
  assert.deepEqual(check([viewItem('EV-2', 1000000)], records).map(c => c.status), ['MATCH', 'MATCH']);
  // An API response that came after the event (the next click), on another tab or long before does not count.
  assert.deepEqual(check([viewItem('EV-3', 500000, 1000)], [record(apiPrices(hotelApi), 2500), record(apiPrices(hotelApi), 0, 'other'), record(apiPrices(hotelApi), -31 * 60000)]).map(c => c.status), ['NO_API', 'NO_API']);
});

test('the product is the most specific one in the API, a stale price is a mismatch, and only prices of the same kind are compared', () => {
  const golf = price => ({ data: { club: { id: 'c0ffee00-1111-2222-3333-444455556666', slug: 'vinpearl-hp-golf', name: 'Vinpearl Golf Hải Phòng', currency: 'VND',
    courses: [{ code: 'A', teeTimes: [{ time: '05:30', price }] }, { code: 'B', teeTimes: [{ time: '06:00', price: 4500000 }] }] } } });
  const records = [record(apiPrices(golf(4500000)), 0), record(apiPrices(golf(1000000)), 3000), record(apiPrices(golf(7000000)), 4000, 'other')];
  const cart = { ...decodeRequest({ url: 'https://unification.useinsider.com/api/event/v1/insert', contentType: 'application/json', body: JSON.stringify({ event_name: 'item_added_to_cart',
    event_params: { pid: 'vinpearl-hp-golf_18_A_1_05:30', na: 'A Course', cu: 'VND', up: 4500000, usp: 4500000, qu: 1, c_green_fee: 3120000 } }) })[0], evidence_id: 'EV-CART', captured_at: iso(6000), page };
  const courseB = ga4Hit('EV-B', { en: 'begin_checkout', cu: 'VND', 'epn.value': '9000000', pr1: 'idvinpearl-hp-golf_18_B~nmB Course~pr4500000~qt2~k0golf_club_id~v0c0ffee00-1111-2222-3333-444455556666' }, 7000);
  const promo = ga4Hit('EV-P', { en: 'select_promotion', 'epn.price': '4500000' }, 8000);
  const checks = check([cart, courseB, promo], records);
  const by = (id, field) => checks.find(c => c.evidence_id === id && c.field === field);
  // Course A is now priced 1.000.000; the cart still sends the earlier 4.500.000.
  assert.equal(by('EV-CART', 'unit_price').status, 'MISMATCH');
  assert.equal(by('EV-CART', 'unit_price').api.value, 1000000);
  assert.equal(by('EV-CART', 'unit_price').stale.value, 4500000);
  // A green fee is not a tee-time price: nothing to compare it with.
  assert.equal(by('EV-CART', 'custom_parameters.green_fee').status, 'NO_API');
  // Course B, two players: price and price × quantity.
  assert.equal(by('EV-B', 'items[0].price').status, 'MATCH');
  assert.deepEqual([by('EV-B', 'value').status, by('EV-B', 'value').api.times], ['MATCH', 2]);
  // No product id: the value is among the page's API prices.
  assert.equal(by('EV-P', 'custom_parameters.price').status, 'MATCH_PAGE');
});

test('the Giá vs API tab, the event detail and the report show a sent price that differs from the website API', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-prices-'));
  const app = await createApp({ port: 0, runsDir: dir, initialCases: [] });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  app.manager.start({ environment: 'MOCK_ONLY' });
  app.manager.emitApi(record(apiPrices(hotelApi)));
  const { evidence_id, ...hit } = viewItem('unused', 500000);
  const sent = app.manager.emit(hit);
  const { checks, summary, api_prices: returned } = await (await fetch(`${base}/api/prices`)).json();
  assert.deepEqual([summary.total, summary.mismatch, summary.api_responses], [2, 2, 1]);
  assert.deepEqual(checks.map(c => [c.status, c.sent, c.api.value]), [['MISMATCH', 500000, 1000000], ['MISMATCH', 500000, 1000000]]);
  // The prices the API returned are listed too, with their product.
  assert.deepEqual(returned[0].prices.slice(0, 2).map(entry => [entry.name, entry.path, entry.value]), [['Deluxe', 'data.hotel.rooms[0].price.value', 1000000], ['Deluxe', 'data.hotel.rooms[0].price.originalValue', 1200000]]);
  // Each event in the list carries the price sent and the API price.
  const [row] = (await (await fetch(`${base}/api/activity?compact=1`)).json()).events;
  assert.deepEqual(row.prices.map(p => [p.field, p.sent, p.api, p.status]), [['items[0].price', 500000, 1000000, 'MISMATCH'], ['value', 500000, 1000000, 'MISMATCH']]);
  assert.equal((await (await fetch(`${base}/api/state?compact=1`)).json()).prices.mismatch, 2);
  assert.deepEqual((await (await fetch(`${base}/api/event?id=${sent.evidence_id}`)).json()).prices.map(c => c.field), ['items[0].price', 'value']);
  const files = await exportReports(app.manager.snapshot(), dir);
  assert.match(await fs.readFile(files.bugs, 'utf8'), /view_item: items\[0\]\.price gửi 500\.000, API 1\.000\.000/);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(files.xlsx);
  assert.equal(workbook.getWorksheet('Giá vs API').getRow(2).getCell(7).value, 'Lệch API');
  app.manager.finish();
  assert.equal(loadRun(app.manager.runDir).api.length, 1, 'kept with the session evidence');
});
