import test from 'node:test';
import assert from 'node:assert/strict';
import { queueEvents } from '../src/collectors/cdp.mjs';
import { extractSamples } from '../src/spec/import.mjs';
import { specCoverage } from '../src/core/catalog.mjs';

const record = (queue, item, href = 'https://vinpearlota.com/vi') => ({ queue, item, ts: Date.now(), href });

test('InsiderQueue pushes are named like the tracking specification', () => {
  const custom = queueEvents(record('InsiderQueue', { type: 'custom_event', value: [{ event_name: 'login_success', event_parameters: {} }, { event_name: 'search_flight', event_parameters: {} }] }));
  assert.deepEqual(custom.map(e => e.event_name), ['login_success', 'search_flight'], 'one push can carry several custom events');
  assert.deepEqual(custom[1].payload.value, [{ event_name: 'search_flight', event_parameters: {} }]);
  const names = ['home', 'category', 'product', 'cart', 'purchase', 'init'].map(type => queueEvents(record('InsiderQueue', { type }))[0].event_name);
  assert.deepEqual(names, ['homepage_view', 'listing_page_view', 'product_detail_page_view', 'cart_page_view', 'confirmation_page_view', 'insider_init']);
  assert.equal(queueEvents(record('dataLayer', { ecommerce: null }))[0].event_name, 'ecommerce_reset');
  assert.equal(queueEvents(record('dataLayer', { event: 'view_item' }))[0].event_name, 'view_item');
});

test('workbook samples are read despite prose, comments, several objects, placeholders and truncation', () => {
  assert.deepEqual(extractSamples('Apply thành công 1 voucher:\n{ "type": "custom_event", "value": [{ "event_name": "coupon_applied" }] }')[0].value[0].event_name, 'coupon_applied');
  assert.equal(extractSamples('// 1. Tab Khách sạn\n{ "type": "category" }\n// 2. Nha Trang\n{ "type": "category", "value": {} }').length, 2);
  assert.equal(extractSamples('Insider.eventManager.dispatch("other_page_view", {\n  taxonomy: "News",\n  slug: Slug của trang (nếu không có để trống)\n});')[0].slug, 'Slug của trang (nếu không có để trống)');
  const truncated = extractSamples('dataLayer.push({\n  event: "view_item_list",\n  ecommerce: {\n    items: [\n      { item_id: "HAN-SGN", price: 1722381 },\n      { item_id: "HAN-');
  assert.equal(truncated[0].ecommerce.items[0].item_id, 'HAN-SGN');
  assert.deepEqual(extractSamples('process.exit()'), [], 'code is never executed');
});

test('captured events are assigned to the specification row of their flow and checked against its sample', () => {
  const ga4 = (stt, flow, service, extra = {}) => ({ id: `TC-${stt}`, stt: String(stt), name: `${flow} / search_submit`, source: 'GA4', flow, sample: { event: 'search_submit', service, ...extra },
    rules: [{ event_name: 'search_submit', source: 'GA4', layer: 'JS_QUEUE', count: { min: 1, max: 1 }, fields: { event: { op: 'eq', value: 'search_submit' }, service: { op: 'eq', value: service }, departure_code: { op: 'type', value: 'string' }, destination: { op: 'ref', value: 'context.search.destination_name' } } }] });
  const listing = (stt, flow, crumb) => ({ id: `TC-${stt}`, stt: String(stt), name: `${flow} / listing_page_view`, source: 'INSIDER', flow, sample: { type: 'category', value: { breadcrumb: [crumb] } },
    rules: [{ event_name: 'listing_page_view', source: 'INSIDER', layer: 'JS_QUEUE', count: { min: 1, max: 1 }, fields: { type: { op: 'eq', value: 'category' }, 'value.breadcrumb': { op: 'type', value: 'array' } } }] });
  const cases = [ga4(3, 'Khách sạn', 'hotel'), ga4(31, 'Vé máy bay', 'flight'), listing(67, 'Khách sạn', 'Khách sạn'), listing(75, 'Vé máy bay', 'Vé máy bay')];
  let n = 0;
  const event = (layer, source, name, payload, url = 'https://vinpearlota.com/vi/flight/search') => ({ evidence_id: `EV-${++n}`, layer, source, event_name: name, payload, captured_at: new Date().toISOString(), page: { url } });
  const events = [
    event('JS_QUEUE', 'GA4', 'search_submit', { event: 'search_submit', service: 'flight', departure_code: 'HAN', destination: 'Nha Trang' }),
    event('JS_QUEUE', 'GA4', 'search_submit', { event: 'search_submit', service: 'flight', departure_code: 123 }),
    event('JS_QUEUE', 'INSIDER', 'listing_page_view', { type: 'category', value: { breadcrumb: ['Vé máy bay', 'Hà Nội → Nha Trang'] } }),
    event('JS_QUEUE', 'GA4', 'promo_click', { event: 'promo_click' }),
    event('JS_QUEUE', 'GA4', 'gtm.dom', { event: 'gtm.dom' }),
  ];
  const coverage = specCoverage(cases, events);
  const row = stt => coverage.rows.find(r => r.stt === stt);
  assert.equal(row('31').seen, 2, 'flight search goes to the flight row, not the hotel row');
  assert.equal(row('3').seen, 0);
  assert.equal(row('31').status, 'MISMATCH');
  assert.deepEqual(row('31').issues.map(i => [i.code, i.path]), [['MISSING_CONTEXT', 'destination'], ['WRONG_TYPE', 'departure_code'], ['MISSING_FIELD', 'destination']]);
  assert.equal(row('75').status, 'MATCH', 'Insider listing is placed by its breadcrumb');
  assert.equal(row('67').status, 'NOT_SEEN');
  assert.deepEqual(coverage.unmatched.map(u => u.event_name), ['promo_click'], 'GTM lifecycle events are not reported as outside the spec');
  assert.deepEqual({ seen: coverage.totals.seen, match: coverage.totals.match, mismatch: coverage.totals.mismatch }, { seen: 2, match: 1, mismatch: 1 });
});

test('automatic coverage cannot accept a dynamic value without independent step context', () => {
  const c = { id: 'GOLF', name: 'Golf', source: 'GA4', flow: 'Golf', rules: [{ event_name: 'search_submit', layer: 'JS_QUEUE',
    fields: { destination: { op: 'ref', value: 'context.search.destination_name' } } }] };
  const e = { evidence_id: 'DYNAMIC', source: 'GA4', layer: 'JS_QUEUE', event_name: 'search_submit',
    page: { url: 'https://example.test/vi/golf' }, payload: { destination: 'Some destination' } };
  const row = specCoverage([c], [e]).rows[0];
  assert.equal(row.status, 'REVIEW');
  assert.equal(row.pass, 0);
  assert.ok(row.issues.some(i => i.code === 'MISSING_CONTEXT'));
});
