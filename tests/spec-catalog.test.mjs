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
  const at = second => new Date(Date.UTC(2026, 10, 1, 8, 0, second)).toISOString();
  const event = (layer, source, name, payload, second, extra = {}) => ({ evidence_id: `EV-${++n}`, layer, source, event_name: name, payload, captured_at: at(second), page: { url: 'https://vinpearlota.com/vi/flight/search' }, ...extra });
  // Each push is followed by the vendor hit that sent it, as on the real site.
  const sent = (payload, second) => [event('JS_QUEUE', 'GA4', payload.event, payload, second), event('TRACKING_REQUEST', 'GA4', payload.event, { v: '2', tid: 'G-TEST', ...payload }, second + 1, { network: { phase: 'request' } })];
  const events = [
    ...sent({ event: 'search_submit', service: 'flight', departure_code: 'HAN', destination: 'Nha Trang' }, 0),
    ...sent({ event: 'search_submit', service: 'flight', departure_code: 123 }, 5),
    event('JS_QUEUE', 'INSIDER', 'listing_page_view', { type: 'category', value: { breadcrumb: ['Vé máy bay', 'Hà Nội → Nha Trang'] } }, 10, { queue_name: 'InsiderQueue', queue_type: 'category' }),
    event('JS_QUEUE', 'INSIDER', 'insider_init', { type: 'init' }, 10, { queue_name: 'InsiderQueue', queue_type: 'init' }),
    event('TRACKING_REQUEST', 'INSIDER', 'pageView', { event: 'pageView', page_type: 'category' }, 11, { network: { phase: 'request' } }),
    ...sent({ event: 'promo_click' }, 15),
    event('JS_QUEUE', 'GA4', 'gtm.dom', { event: 'gtm.dom' }, 16),
  ];
  const coverage = specCoverage(cases, events, new Map(), { now: Date.parse(at(59)) });
  const row = stt => coverage.rows.find(r => r.stt === stt);
  assert.equal(row('31').seen, 2, 'flight search goes to the flight row, not the hotel row');
  assert.equal(row('3').seen, 0);
  assert.equal(row('31').status, 'MISMATCH');
  assert.deepEqual(row('31').issues.map(i => [i.code, i.path]), [['WRONG_TYPE', 'departure_code'], ['MISSING_FIELD', 'destination']]);
  assert.equal(row('75').status, 'MATCH', 'Insider listing is placed by its breadcrumb');
  assert.equal(row('67').status, 'NOT_SEEN');
  assert.deepEqual(coverage.unmatched.map(u => u.event_name), ['promo_click'], 'GTM lifecycle events are not reported as outside the spec');
  assert.deepEqual({ seen: coverage.totals.seen, match: coverage.totals.match, mismatch: coverage.totals.mismatch }, { seen: 2, match: 1, mismatch: 1 });
});

// Observed on vinpearlota.com (2026-11-01): Google received page_view with only the page URL and
// title, and search_result_list was pushed to dataLayer but never sent.
test('the specification is judged on what Google received, not on what the website pushed', () => {
  const pageView = { id: 'TC-PV', stt: '1', name: 'All / page_view', source: 'GA4', flow: 'All', sample: { event: 'page_view', page_type: 'home', entry_source: null },
    rules: [{ event_name: 'page_view', source: 'GA4', layer: 'JS_QUEUE', count: { min: 1, max: 1 }, fields: { event: { op: 'eq', value: 'page_view' }, page_type: { op: 'type', value: 'string' }, entry_source: { op: 'type', value: ['null', 'string', 'number', 'boolean', 'object', 'array'] } } }] };
  const results = { id: 'TC-SRL', stt: '2', name: 'Khách sạn / search_result_list', source: 'GA4', flow: 'Khách sạn', sample: { event: 'search_result_list', ecommerce: { item_list_id: 'hotel_search', items: [] } },
    rules: [{ event_name: 'search_result_list', source: 'GA4', layer: 'JS_QUEUE', count: { min: 1, max: 1 }, fields: { event: { op: 'eq', value: 'search_result_list' }, 'ecommerce.item_list_id': { op: 'type', value: 'string' } } }] };
  const at = ms => new Date(Date.UTC(2026, 10, 1, 8, 0, 0) + ms).toISOString();
  const page = { url: 'https://vinpearlota.com/vi/hotel/search?destination=nha-trang', target_id: 'tab' };
  const events = [
    { evidence_id: 'push-pv', layer: 'JS_QUEUE', source: 'GA4', queue_name: 'dataLayer', event_name: 'page_view', page, captured_at: at(0), payload: { event: 'page_view', entry_source: null, page_type: 'listing' } },
    { evidence_id: 'push-srl', layer: 'JS_QUEUE', source: 'GA4', queue_name: 'dataLayer', event_name: 'search_result_list', page, captured_at: at(50), payload: { event: 'search_result_list', ecommerce: { item_list_id: 'hotel_search', items: [] } } },
    { evidence_id: 'hit-pv', layer: 'TRACKING_REQUEST', source: 'GA4', event_name: 'page_view', page, captured_at: at(870), network: { phase: 'request' }, payload: { v: '2', tid: 'G-MHKCK8LTMB', event: 'page_view', dl: page.url, dt: 'Khách sạn' } },
  ];
  const later = specCoverage([pageView, results], events, new Map(), { now: Date.parse(at(60000)) });
  const row = id => later.rows.find(r => r.case_id === id);
  assert.equal(row('TC-PV').status, 'MISMATCH');
  // page_type was pushed but not sent by the GA4 tag; the null entry_source is omitted by GA4 and fine.
  assert.deepEqual(row('TC-PV').issues.map(i => [i.code, i.path, i.pushed]), [['NOT_FORWARDED', 'page_type', 'listing']]);
  assert.equal(row('TC-SRL').status, 'NOT_SENT');
  assert.equal(row('TC-SRL').seen, 0);
  assert.equal(later.totals.not_sent, 1);
  // Seconds after the push the hit may still be in GA4's batch.
  const soon = specCoverage([pageView, results], events, new Map(), { now: Date.parse(at(2000)) });
  assert.equal(soon.rows.find(r => r.case_id === 'TC-SRL').status, 'PENDING');
});
