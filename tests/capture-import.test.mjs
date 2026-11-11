import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

const post = (base, token, body) => fetch(`${base}/api/import-capture`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': token }, body: JSON.stringify(body) });

// A capture the F12 snippet would produce: a dataLayer push, a GA4 /g/collect request and an Insider event.
function sampleCapture() {
  const page = 'https://dplatform-web.uat.vinpearlota.com/vi/hotel/detail?id=ROOM-1';
  return { app: 'eventqa-capture', version: 1, page: { url: page, title: 'UAT' }, pushes: [
    { queue: 'dataLayer', item: { event: 'gtm.js' }, historical: true, href: page, title: 'UAT', ts: Date.now() - 5000, index: 0 },
    { queue: 'dataLayer', item: { event: 'add_to_cart', ecommerce: { currency: 'VND', value: 1500000, items: [{ item_id: 'ROOM-1', price: 1500000 }] } }, historical: false, href: page, title: 'UAT', ts: Date.now() - 3000, index: 1 },
  ], requests: [
    { url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST1', method: 'POST', body: 'en=add_to_cart&ep.currency=VND&epn.value=1500000&dl=' + encodeURIComponent(page), content_type: 'text/plain;charset=UTF-8', ts: Date.now() - 2900, page_url: page },
    { url: 'https://unification.useinsider.com/api/event/v1', method: 'POST', body: JSON.stringify({ name: 'cart_page_view', event_params: { c_currency: 'VND', c_total: 1500000 } }), content_type: 'application/json', ts: Date.now() - 2800, page_url: page },
  ] };
}

test('the capture snippet and help page are served', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-cap-'));
  const app = await createApp({ mode: 'cdp-ai', runsDir: dir, port: 0, initialCases: [] });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const js = await fetch(`${base}/capture.js`);
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const jsText = await js.text();
  assert.match(jsText, /eventqa\.capture\.v1/);
  assert.match(jsText, /__eventqaCapture/);
  const pageResponse = await fetch(`${base}/capture`);
  const html = await pageResponse.text();
  assert.match(html, /Bản ghi event từ F12/);
  assert.match(html, /eventqa\.capture\.v1/, 'the page embeds the snippet to copy');
  assert.doesNotMatch(html, /<script>\(\(\) =>/, 'the snippet sits in a textarea, not an executable script');
});

test('importing a capture replays pushes and requests into a session with decoded events', { timeout: 5000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-cap-'));
  const app = await createApp({ mode: 'cdp-ai', runsDir: dir, port: 0, initialCases: [] });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });

  const ok = await post(base, app.csrf, { capture: sampleCapture() });
  const state = await ok.json();
  assert.equal(ok.status, 200, JSON.stringify(state));
  assert.equal(state.running, true);
  assert.equal(state.session.environment, 'IMPORTED_CAPTURE');

  const events = app.manager.snapshot().events;
  const named = events.map(event => `${event.source}/${event.layer}/${event.event_name}`);
  assert.ok(named.includes('GA4/JS_QUEUE/add_to_cart'), `dataLayer push decoded: ${named.join(', ')}`);
  assert.ok(named.includes('GA4/TRACKING_REQUEST/add_to_cart'), 'GA4 collect request decoded');
  assert.ok(events.some(event => event.source === 'INSIDER' && event.layer === 'TRACKING_REQUEST'), 'Insider request decoded');
  // The GA4 request's parameters are decoded from the wire format.
  const sent = events.find(event => event.layer === 'TRACKING_REQUEST' && event.source === 'GA4');
  assert.equal(sent.payload.currency, 'VND');
  assert.equal(sent.payload.value, 1500000);
  // Events are in time order.
  const times = events.map(event => Date.parse(event.captured_at));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));

  // A second import is refused while the session runs; finishing first lets it through.
  assert.equal((await post(base, app.csrf, { capture: sampleCapture() })).status, 400);
  await fetch(`${base}/api/finish`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': app.csrf }, body: JSON.stringify({ exportReport: false }) });
  assert.equal((await post(base, app.csrf, { capture: sampleCapture() })).status, 200);
});

test('import rejects malformed or empty captures and needs the page token', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-cap-'));
  const app = await createApp({ mode: 'cdp', runsDir: dir, port: 0, initialCases: [] });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });

  assert.equal((await post(base, app.csrf, { capture: { app: 'something-else', pushes: [] } })).status, 400);
  assert.equal((await post(base, app.csrf, { capture: { app: 'eventqa-capture', pushes: [], requests: [] } })).status, 400);
  assert.equal((await post(base, app.csrf, {})).status, 400);
  // The plain edition can import too.
  assert.equal((await post(base, app.csrf, { capture: sampleCapture() })).status, 200);
  // The page token is required.
  assert.equal((await fetch(`${base}/api/import-capture`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
});
