import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { manualCase } from '../src/spec/import.mjs';
import { decodeRequest } from '../src/core/decoder.mjs';
import { createApp } from '../src/server.mjs';

// What a QC pastes from the DataLayer Sample cell: the ecommerce reset, then the event.
const pasted = "dataLayer.push({ ecommerce: null });\ndataLayer.push({ event: 'view_item', ecommerce: { currency: 'VND', value: 1000000, items: [{ item_id: 'ROOM-1', item_name: 'Deluxe', price: 1000000 }] } });";

test('a pasted sample becomes a specification row read like an Excel row; the event name can come from the sample', () => {
  const { testCase } = manualCase({ source: 'GA4', flow: 'Khách sạn', description: 'Bấm Xem phòng', sample: pasted });
  assert.deepEqual([testCase.rules[0].event_name, testCase.source, testCase.flow, testCase.description, testCase.provenance.manual], ['view_item', 'GA4', 'Khách sạn', 'Bấm Xem phòng', true]);
  assert.deepEqual(testCase.rules[0].fields.event, { op: 'eq', value: 'view_item' });
  assert.deepEqual(testCase.rules[0].fields['ecommerce.items.0.price'], { op: 'type', value: 'integer' });
  assert.equal(testCase.sample.ecommerce.value, 1000000);
  // An Insider event as R1511 writes it; a second entry of the same event gets its own id.
  const insider = manualCase({ source: 'INSIDER', flow: 'Golf', sample: JSON.stringify({ event: 'Product Page View', default_parameters: { product_id: 'x' }, custom_parameters: { holes: 18 } }) }).testCase;
  assert.equal(insider.capture_platform, 'APP_SDK');
  assert.notEqual(manualCase({ sample: pasted }, [testCase]).testCase.id, testCase.id);
  assert.throws(() => manualCase({ event_name: 'view_item', sample: 'khi bấm xem phòng' }), /Chưa đọc được payload mẫu/);
  assert.throws(() => manualCase({ event_name: 'view_item' }), /Dán payload mẫu/);
});

test('an event typed in the app is saved, checked against what the website sends, and kept when a file is imported', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-manual-'));
  const reviewedPath = path.join(dir, 'reviewed-cases.json');
  const app = await createApp({ port: 0, runsDir: dir, initialCases: [], reviewedPath });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const post = (name, body) => fetch(`${base}/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': app.csrf }, body: JSON.stringify(body) });
  const response = await post('manual-case', { event_name: '', source: 'GA4', flow: 'Khách sạn', sample: pasted });
  assert.equal(response.status, 200);
  const { manualCase: added, cases } = await response.json();
  assert.equal(added.event_name, 'view_item');
  assert.ok(added.fields.includes('ecommerce.items.0.item_id'));
  assert.deepEqual(cases.map(c => c.id), [added.id]);
  assert.equal(JSON.parse(await fs.readFile(reviewedPath, 'utf8')).cases[0].id, added.id, 'saved for the next start');
  assert.equal((await post('manual-case', { event_name: 'view_item', sample: 'chưa có mẫu' })).status, 400);
  // The website sends view_item as the sample says: the typed row is matched.
  app.manager.start({ environment: 'MOCK_ONLY' });
  const [hit] = decodeRequest({ url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST', body: 'en=view_item&cu=VND&epn.value=1000000&pr1=idROOM-1~nmDeluxe~pr1000000', contentType: 'text/plain' });
  app.manager.emit({ ...hit, page: { url: 'https://hotel.test/vi/hotel/room', target_id: 'tab' } });
  const row = (await (await fetch(`${base}/api/state?compact=1`)).json()).specCoverage.rows[0];
  assert.deepEqual([row.event_name, row.flow, row.seen, row.status], ['view_item', 'Khách sạn', 1, 'MATCH']);
  // Importing a specification file keeps the typed event beside it.
  const file = path.join(dir, 'spec.json');
  await fs.writeFile(file, JSON.stringify({ cases: [{ id: 'TC-FILE-1', name: 'search_submit', source: 'GA4', rules: [{ event_name: 'search_submit', layer: 'JS_QUEUE', fields: {} }] }] }));
  const imported = await post('import', { path: file });
  assert.equal(imported.status, 200);
  assert.deepEqual((await imported.json()).cases.map(c => c.id), ['TC-FILE-1', added.id]);
});
