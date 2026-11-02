import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRequest } from '../src/core/decoder.mjs';
import { eventKind } from '../src/core/event-kind.mjs';
import { linkDeliveries, deliveryStatus, notForwarded, ga4HitAsPush } from '../src/core/delivery.mjs';
import { activityEntries } from '../src/core/activity.mjs';

// Requests and pushes as recorded on vinpearlota.com on 2026-11-01.
const at = ms => new Date(Date.UTC(2026, 10, 1, 8, 0, 0) + ms).toISOString();
const page = { url: 'https://vinpearlota.com/vi/hotel/search?destination=nha-trang', target_id: 'tab' };
let n = 0;
const push = (queue_name, source, event_name, payload, ms, extra = {}) => ({ evidence_id: `push-${++n}`, layer: 'JS_QUEUE', queue_name, source, event_name, payload, captured_at: at(ms), page, ...extra });
const hit = (source, event_name, payload, ms) => ({ evidence_id: `hit-${++n}`, layer: 'TRACKING_REQUEST', source, event_name, payload, captured_at: at(ms), page, network: { phase: 'request' } });

test('only requests that carry an event are recorded: Google Signals copies are not events', () => {
  const query = 'v=2&tid=G-MHKCK8LTMB&cid=1.2&_p=1&dl=https%3A%2F%2Fvinpearlota.com%2Fvi';
  assert.deepEqual(decodeRequest({ url: `https://stats.g.doubleclick.net/g/collect?${query}`, method: 'POST' }), []);
  const [pageView] = decodeRequest({ url: `https://analytics.google.com/g/collect?${query}&en=page_view`, method: 'POST' });
  assert.deepEqual([pageView.source, pageView.event_name], ['GA4', 'page_view']);
  // A GA4 hit to the site's own (server-side) endpoint whose body could not be read stays as evidence.
  assert.equal(decodeRequest({ url: `https://sgtm.example.vn/g/collect?${query}`, method: 'POST' }).length, 1);
});

test("Insider's user sync hit is SDK setup, its pageView hit is the page view", () => {
  const user = hit('INSIDER', 'user', { event: 'user', custom_attributes: {}, email_optin: false }, 0);
  const pageView = hit('INSIDER', 'pageView', { event: 'pageView', page_type: 'category' }, 0);
  assert.equal(eventKind(user), 'system');
  assert.equal(eventKind(pageView), 'business');
});

test('each push is linked to the vendor hit that sent it; a push no request carried is not sent', () => {
  const events = [
    push('dataLayer', 'GA4', 'page_view', { event: 'page_view', page_type: 'listing', entry_source: null }, 0),
    push('InsiderQueue', 'INSIDER', 'listing_page_view', { type: 'category', value: { breadcrumb: ['hotel', ''] } }, 10, { queue_type: 'category' }),
    push('dataLayer', 'GA4', 'search_result_list', { event: 'search_result_list', ecommerce: { item_list_id: 'hotel_search', items: [] } }, 40),
    push('InsiderQueue', 'INSIDER', 'insider_init', { type: 'init' }, 60, { queue_type: 'init' }),
    hit('GA4', 'page_view', { v: '2', tid: 'G-MHKCK8LTMB', event: 'page_view', dl: page.url }, 870),
    hit('INSIDER', 'pageView', { event: 'pageView', page_type: 'category', category: ['hotel', ''] }, 967),
  ];
  const links = linkDeliveries(events);
  const [pv, listing, results] = events;
  assert.equal(links.sentBy.get(pv.evidence_id).event_name, 'page_view');
  assert.equal(links.sentBy.get(listing.evidence_id).event_name, 'pageView', 'Insider page data is sent as pageView after init');
  assert.equal(links.sentBy.has(results.evidence_id), false);
  assert.equal(deliveryStatus(results, links, Date.parse(at(3000))), 'pending', 'GA4 may still be batching');
  assert.equal(deliveryStatus(results, links, Date.parse(at(60000))), 'not_sent');
  // Google received page_view without the pushed page_type; the null entry_source is omitted by GA4 and is not reported.
  assert.deepEqual(notForwarded(pv, links.sentBy.get(pv.evidence_id)), ['page_type']);

  const rows = activityEntries(events, { links, now: Date.parse(at(60000)) }).filter(row => row.event_kind === 'business');
  assert.deepEqual(rows.map(row => [row.event_name, row.delivery, row.layers.join('+')]), [
    ['page_view', 'sent', 'JS_QUEUE+TRACKING_REQUEST'],
    ['listing_page_view', 'sent', 'JS_QUEUE+TRACKING_REQUEST'],
    ['search_result_list', 'not_sent', 'JS_QUEUE'],
  ]);
  // The GA4 row shows what Google received, so the unsent page_type is not presented as tracked.
  assert.equal(rows[0].json.custom_parameters.page_type, undefined);
});

test('Insider custom, cart, dispatch and insider_object pushes are linked to the hits Insider sends for them', () => {
  const custom = push('InsiderQueue', 'INSIDER', 'search_hotel', { type: 'custom_event', value: [{ event_name: 'search_hotel', event_parameters: {} }] }, 0, { queue_type: 'custom_event' });
  const cart = push('InsiderQueue', 'INSIDER', 'add_to_cart', { type: 'add_to_cart', value: { id: 'T1' } }, 100, { queue_type: 'add_to_cart' });
  const golf = push('InsiderQueue', 'INSIDER', 'item_added_to_cart', { type: 'item_added_to_cart', value: { id: 'G1' } }, 200, { queue_type: 'item_added_to_cart' });
  const other = push('InsiderDispatch', 'INSIDER', 'other_page_view', { taxonomy: 'News' }, 300, { queue_type: 'dispatch' });
  const object = push('insider_object', 'INSIDER', 'confirmation_page_view', { transaction: { order_id: 'BX1' } }, 2500, { queue_type: 'insider_object' });
  const hits = [hit('INSIDER', 'search_hotel', { event_name: 'search_hotel' }, 400), hit('INSIDER', 'item_added_to_cart', { event_name: 'item_added_to_cart' }, 500),
    hit('INSIDER', 'item_added_to_cart', { event_name: 'item_added_to_cart' }, 600), hit('INSIDER', 'pageView', { event: 'pageView', page_type: 'other' }, 700),
    hit('INSIDER', 'pageView', { event: 'pageView', page_type: 'confirmation' }, 1500)];
  const links = linkDeliveries([custom, cart, golf, other, object, ...hits]);
  assert.deepEqual([custom, cart, golf, other, object].map(item => links.sentBy.get(item.evidence_id)?.evidence_id), hits.map(item => item.evidence_id));
});

test('a GA4 hit reads like the push it stands for', () => {
  const [hitEvent] = decodeRequest({ url: 'https://analytics.google.com/g/collect?v=2&tid=G-TEST&en=search_result_list&cu=VND&epn.value=0&ep.item_list_id=hotel_search&epn.result_count=0', method: 'POST' });
  const received = ga4HitAsPush(hitEvent.payload);
  assert.equal(received.ecommerce.item_list_id, 'hotel_search');
  assert.equal(received.ecommerce.currency, 'VND');
  assert.equal(received.ecommerce.result_count, 0);
  const pushed = push('dataLayer', 'GA4', 'search_result_list', { event: 'search_result_list', ecommerce: { item_list_id: 'hotel_search', result_count: 0, items: [] } }, 0);
  assert.deepEqual(notForwarded(pushed, hitEvent), []);
});

test('the dashboard counts each event Google/Insider received once, not the push and its hit twice', async t => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const { createApp } = await import('../src/server.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-delivery-'));
  const app = await createApp({ port: 0, runsDir: dir, initialCases: [] });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  app.manager.start({ environment: 'MOCK_ONLY' });
  const now = Date.now(), iso = ms => new Date(now - 60000 + ms).toISOString();
  const tab = { url: 'https://vinpearlota.com/vi', target_id: 'tab' };
  app.manager.emit({ layer: 'JS_QUEUE', source: 'GA4', queue_name: 'dataLayer', event_name: 'page_view', captured_at: iso(0), page: tab, payload: { event: 'page_view' } });
  app.manager.emit({ layer: 'JS_QUEUE', source: 'GA4', queue_name: 'dataLayer', event_name: 'search_result_list', captured_at: iso(10), page: tab, payload: { event: 'search_result_list' } });
  app.manager.emit({ layer: 'JS_QUEUE', source: 'GA4', queue_name: 'dataLayer', event_name: 'gtm.dom', captured_at: iso(20), page: tab, payload: { event: 'gtm.dom' } });
  app.manager.emit({ layer: 'TRACKING_REQUEST', source: 'GA4', event_name: 'page_view', captured_at: iso(900), page: tab, network: { phase: 'request' }, payload: { v: '2', event: 'page_view' } });
  const state = await (await fetch(base + '/api/state?compact=1')).json();
  assert.deepEqual(state.delivery, { sent: 1, kinds: 1, not_sent: 1, pending: 0 });
});
