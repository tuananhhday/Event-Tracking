import test from 'node:test';
import assert from 'node:assert/strict';
import { queueEvents } from '../src/collectors/cdp.mjs';
import { decodeRequest } from '../src/core/decoder.mjs';
import { eventKind, isBusinessEvent } from '../src/core/event-kind.mjs';

const record = (queue, item) => ({ queue, item, ts: Date.now() });

test('Insider internal signals and page-less snapshots remain evidence without becoming business actions', () => {
  const [internal] = queueEvents(record('InsiderDispatch', { name: 'sdk:ready', data: { loaded: true } }));
  const [state] = queueEvents(record('insider_object', { user: { uuid: 'U1' } }));
  const [init] = queueEvents(record('InsiderQueue', { type: 'init' }));
  assert.equal(internal.event_kind, 'observation');
  assert.equal(state.event_kind, 'observation');
  assert.equal(init.event_kind, 'system');
  assert.equal(isBusinessEvent(internal), false);
  assert.equal(isBusinessEvent(state), false);
  assert.equal(isBusinessEvent(init), false);
});

test('insider_object page snapshots are the page views specifications define with it', () => {
  const [product] = queueEvents(record('insider_object', { page: { type: 'Product' }, product: { id: 'P1', custom: { service: 'hotel' } } }));
  const [listing] = queueEvents(record('insider_object', { page: { type: 'Listing' }, listing: { breadcrumb: ['Khách sạn', 'Nha Trang'] } }));
  const [order] = queueEvents(record('insider_object', { transaction: { order_id: 'BXUZ9U9PCB', total: 7300000 } }));
  assert.deepEqual([product, listing, order].map(event => [event.event_name, event.event_kind]),
    [['product_detail_page_view', 'business'], ['listing_page_view', 'business'], ['confirmation_page_view', 'business']]);
  assert.deepEqual(product.payload.product.custom, { service: 'hotel' });
});

test('InsiderQueue cart types used by golf, attraction and train specifications keep their names', () => {
  const [added] = queueEvents(record('InsiderQueue', { type: 'item_added_to_cart', value: { id: 'A_10_1100', quantity: 2 } }));
  const [removed] = queueEvents(record('InsiderQueue', { type: 'item_removed_from_cart', value: { id: 'A_10_1100', quantity: 1 } }));
  const [typo] = queueEvents(record('InsiderQueue', { type: 'item_revmoved_from_cart', value: {} }));
  assert.deepEqual([added, removed].map(event => [event.event_name, event.event_kind]), [['item_added_to_cart', 'business'], ['item_removed_from_cart', 'business']]);
  // An unknown type is shown as is, so a misspelt push is visible instead of silently matched.
  assert.deepEqual([typo.event_name, typo.event_kind], ['insider_item_revmoved_from_cart', 'observation']);
});

test('documented Insider page dispatch and explicit custom events preserve their full data', () => {
  const [page] = queueEvents(record('InsiderDispatch', { name: 'other_page_view', data: { taxonomy: 'News', custom: { slug: 'article' } } }));
  const [custom] = queueEvents(record('InsiderDispatch', { name: 'custom_event', data: { event_name: 'search_hotel', event_parameters: { custom: { rooms: 2 } } } }));
  assert.equal(page.event_kind, 'business');
  assert.deepEqual(page.payload, { taxonomy: 'News', custom: { slug: 'article' } });
  assert.equal(custom.event_kind, 'business');
  assert.equal(custom.event_name, 'search_hotel');
  assert.equal(custom.dispatch_name, 'custom_event');
  assert.deepEqual(custom.queue_payload.data, custom.payload);
});

test('Insider custom event batches retain the original push and isolate each event payload', () => {
  const item = { type: 'custom_event', value: [
    { event_name: 'search_hotel', event_parameters: { custom: { destination: 'City A', rooms: 2 } } },
    { event_name: 'select_hotel', event_parameters: { custom: { product_id: 'P1', price: 200 } } },
  ] };
  const events = queueEvents(record('InsiderQueue', item));
  assert.deepEqual(events.map(event => [event.event_name, event.event_kind, event.queue_batch_index, event.queue_batch_size]), [
    ['search_hotel', 'business', 0, 2], ['select_hotel', 'business', 1, 2],
  ]);
  assert.deepEqual(events[0].queue_payload, item);
  assert.deepEqual(events[1].payload.value, [item.value[1]]);
  assert.equal(events[0].payload.value[0].event_parameters.custom.price, undefined, 'parameters are never merged between events');
});

test('an Insider request keeps the complete sanitized batch and stable per-event rule paths', () => {
  const body = { partner: 'test', user_id: 'private-user', events: [
    { event_name: 'search_hotel', event_params: { custom: { rooms: 2, email: 'private@example.test' } } },
    { event_name: 'select_hotel', event_params: { custom: { product_id: 'P1', price: 200 } } },
  ] };
  const events = decodeRequest({ url: 'https://unification.useinsider.com/api/event/', body: JSON.stringify(body), contentType: 'application/json' });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => [event.event_kind, event.network.batch_index, event.network.batch_size]), [['business', 0, 2], ['business', 1, 2]]);
  assert.equal(events[0].payload.event_params.custom.rooms, 2);
  assert.equal(events[0].payload.event_params.custom.price, undefined);
  assert.equal(events[1].payload.event_params.custom.price, 200);
  assert.equal(events[0].request_payload.events.length, 2);
  assert.equal(events[0].request_payload.user_id, '[REDACTED]');
  assert.equal(events[0].request_payload.events[0].event_params.custom.email, '[REDACTED]');
  assert.equal(events[1].request_payload.events[0].event_params.custom.email, '[REDACTED]');
});

test('opaque payloads do not leak raw content through complete-request evidence', () => {
  const opaque = 'unreadable-vendor-data-'.repeat(4);
  const [event] = decodeRequest({ url: 'https://example.test/collect', body: JSON.stringify({ data: opaque }), contentType: 'application/json' });
  assert.equal(event.event_kind, 'observation');
  assert.equal(event.payload.decode_status, 'UNPARSED');
  assert.ok(!JSON.stringify(event).includes(opaque));
  const mixed = decodeRequest({ url: 'https://example.test/collect', body: JSON.stringify({ events: [{ event_name: 'search' }, { data: opaque }] }), contentType: 'application/json' });
  assert.equal(mixed[0].event_name, 'search');
  assert.ok(!JSON.stringify(mixed).includes(opaque), 'another event in the batch cannot reintroduce opaque content');
});

test('legacy evidence classification distinguishes config, arbitrary queue state and explicit events', () => {
  assert.equal(eventKind({ event_name: 'gtm.dom', source: 'GA4' }), 'system');
  assert.equal(eventKind({ event_name: 'tracking_request', layer: 'TRACKING_REQUEST' }), 'observation');
  assert.equal(eventKind({ event_name: 'state', queue_name: 'dataLayer', payload: { type: 'state' } }), 'observation');
  assert.equal(eventKind({ event_name: 'search_hotel', queue_name: 'dataLayer', payload: { event: 'search_hotel' } }), 'business');
});

test('an Insider SDK transport name alone is retained as diagnostic observation', () => {
  const [signal] = decodeRequest({ url: 'https://unification.useinsider.com/api/event/', body: JSON.stringify({ name: 'segment_response', type: 'sdk', data: { ready: true } }), contentType: 'application/json' });
  assert.equal(signal.event_kind, 'observation');
  assert.deepEqual(signal.payload.data, { ready: true });
  assert.equal(signal.request_payload.name, 'segment_response');
});
