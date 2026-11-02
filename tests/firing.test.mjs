import test from 'node:test';
import assert from 'node:assert/strict';
import { firingChecks } from '../src/core/firing.mjs';
import { decodeRequest } from '../src/core/decoder.mjs';
import { queueEvents } from '../src/collectors/cdp.mjs';

let n = 0;
const at = ms => new Date(Date.UTC(2026, 9, 30, 0, 0, 0) + ms).toISOString();
const page = { target_id: 'TAB1', url: 'https://vinpearlota.com/vi' };
const insider = (ms, item) => queueEvents({ queue: 'InsiderQueue', item, ts: Date.parse(at(ms)), href: page.url }).map(e => ({ ...e, page, evidence_id: `EV-${++n}` }));
const ga = (ms, item) => queueEvents({ queue: 'dataLayer', item, ts: Date.parse(at(ms)), href: page.url }).map(e => ({ ...e, page, evidence_id: `EV-${++n}` }));
const request = (ms, source, name, payload = {}) => ({ evidence_id: `EV-${++n}`, layer: 'TRACKING_REQUEST', source, event_name: name, captured_at: at(ms), page, payload, network: { phase: 'request' } });
const checksOf = (result, event, rule) => (result.byEvent.get(event.evidence_id) ?? []).filter(c => !rule || c.rule === rule);

test('Insider page data needs a following init, and the pageView hit proves it was sent', () => {
  const [home] = insider(0, { type: 'home' });
  const [init] = insider(5, { type: 'init' });
  const [product] = insider(2000, { type: 'product', value: { id: 'P1' } });
  const result = firingChecks([home, init, request(400, 'INSIDER', 'pageView', { page_type: 'main' }), product]);
  assert.equal(checksOf(result, home, 'INSIDER_INIT')[0].status, 'PASS');
  assert.match(checksOf(result, home, 'DELIVERED')[0].message, /pageView \(page_type=main\)/);
  assert.equal(checksOf(result, product, 'INSIDER_INIT')[0].status, 'FAIL', 'no init after the product push');
});

test('custom events and cart items must reach Insider under their server names', () => {
  const [search] = insider(0, { type: 'custom_event', value: [{ event_name: 'search_hotel', event_parameters: { custom: { checkin: '2026-10-31T00:00:00.000Z', checkin_str: '2026-10-31', checkout: '2026-11-01T00:00:00.000Z' } } }] });
  const [add] = insider(1000, { type: 'add_to_cart', value: { id: 'A' } });
  const [broken] = insider(2000, { type: 'custom_event', value: { event_name: 'login_success' } });
  const result = firingChecks([search, add, broken, request(1003, 'INSIDER', 'search_hotel'), request(1200, 'INSIDER', 'item_added_to_cart')]);
  assert.equal(checksOf(result, search, 'DELIVERED')[0].status, 'PASS');
  assert.equal(checksOf(result, add, 'DELIVERED')[0].status, 'PASS', 'add_to_cart arrives as item_added_to_cart');
  assert.equal(checksOf(result, broken, 'CUSTOM_EVENT_SHAPE')[0].status, 'FAIL');
  const dates = checksOf(result, search, 'DATE_PAIR');
  assert.deepEqual(dates.map(c => c.status), ['PASS', 'FAIL'], 'checkout has no checkout_str');
});

test('GA4 ecommerce needs a reset push, complete items and a /g/collect hit; repeats are flagged', () => {
  const [reset] = ga(0, { ecommerce: null });
  const [select] = ga(1, { event: 'select_item', ecommerce: { items: [{ item_id: 'H1', item_name: 'Hòn Tằm' }] } });
  const [again] = ga(300, { event: 'select_item', ecommerce: { items: [{ item_id: 'H1', item_name: 'Hòn Tằm' }] } });
  const [list] = ga(5000, { event: 'view_item_list', ecommerce: { items: [{ item_id: 'H1' }] } });
  const [coupon] = ga(6000, { event: 'coupon_interacted', action: 'apply' });
  const result = firingChecks([reset, select, again, list, coupon, request(2000, 'GA4', 'select_item')]);
  assert.equal(checksOf(result, select, 'ECOMMERCE_RESET')[0].status, 'PASS');
  assert.equal(checksOf(result, select, 'DELIVERED')[0].status, 'PASS');
  assert.equal(checksOf(result, again, 'DUPLICATE')[0].status, 'FAIL');
  assert.equal(checksOf(result, list, 'ECOMMERCE_RESET')[0].status, 'WARN');
  assert.equal(checksOf(result, list, 'ECOMMERCE_ITEMS')[0].status, 'FAIL');
  assert.equal(checksOf(result, list, 'DELIVERED')[0].status, 'WARN');
  assert.equal(checksOf(result, coupon, 'COUPON_ACTION')[0].status, 'FAIL');
  assert.ok(!result.byEvent.has(reset.evidence_id), 'the reset push itself is not judged');
});

test('Insider hit bodies are base64 JSON; a pageView hit is the page event its page_type names', () => {
  const body = Buffer.from(JSON.stringify({ version: '1.0', event: 'pageView', page_type: 'main', current_url: 'https://vinpearlota.com/vi' })).toString('base64');
  const [record] = decodeRequest({ url: 'https://hit.api.useinsider.com/hit', body, contentType: 'text/plain;charset=UTF-8' });
  assert.equal(record.source, 'INSIDER'); assert.equal(record.event_name, 'homepage_view'); assert.equal(record.payload.event, 'pageView'); assert.equal(record.payload.page_type, 'main');
});

test('Insider.eventManager.dispatch calls and insider_object snapshots become Insider events', () => {
  const [dispatch] = queueEvents({ queue: 'InsiderDispatch', item: { name: 'other_page_view', data: { taxonomy: 'News' } }, ts: Date.now() });
  assert.deepEqual([dispatch.source, dispatch.event_name, dispatch.payload.taxonomy], ['INSIDER', 'other_page_view', 'News']);
  const names = [{ page: { type: 'Listing' } }, { page: { type: 'Product' } }, { transaction: { order_id: 'X' } }].map(item => queueEvents({ queue: 'insider_object', item, ts: Date.now() })[0].event_name);
  assert.deepEqual(names, ['listing_page_view', 'product_detail_page_view', 'confirmation_page_view']);
});
