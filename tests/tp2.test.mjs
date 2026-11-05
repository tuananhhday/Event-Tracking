import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeRequest, matchesEndpoint } from '../src/core/decoder.mjs';
import { decodeBase64Json } from '../src/core/tp2.mjs';
import { compareTp2Event, validateTp2Mapping, Tp2MappingStore } from '../src/core/tp2-compare.mjs';
import { apiCallSummary } from '../src/core/api-log.mjs';

const at = milliseconds => new Date(Date.UTC(2026, 10, 4, 3) + milliseconds).toISOString();
const wrap = data => ({ schema: 'iglu:com.snowplowanalytics.snowplow/unstruct_event/jsonschema/1-0-0', data: { schema: 'iglu:example/purchase/jsonschema/1-0-0', data } });
const encode = data => Buffer.from(JSON.stringify(wrap(data))).toString('base64url');
const event = (data = { product_id: 'SKU-01', price: 500000, quantity: 2 }) => ({ ...decodeRequest({ url: 'https://api.example.test/com.snowplowanalytics.snowplow/tp2',
  body: JSON.stringify({ schema: 'iglu:com.snowplowanalytics.snowplow/payload_data/jsonschema/1-0-4', data: [{ e: 'ue', ue_px: encode(data), dtm: Date.parse(at(2000)), url: 'https://example.test/cart' }] }), capturedAt: at(2000) })[0], evidence_id: 'TP2-1', page: { target_id: 'TAB', url: 'https://example.test/cart' } });
const call = (id = 'API-1', price = 500000) => ({ evidence_id: id, captured_at: at(0), finished_at: at(1000), method: 'GET', url: 'https://api.example.test/products', host: 'api.example.test', path: '/products',
  page: { target_id: 'TAB', url: 'https://example.test/cart' }, ok: true, response: { status: 200, body: { json: { data: { items: [{ id: 'OTHER', price: 900000 }, { id: 'SKU-01', price, quantity: 2 }] } } } } });
const mapping = () => validateTp2Mapping({ id: 'MAP', name: 'Product', event_name: 'purchase', api_pattern: '/products', record_path: 'data.items', event_id_path: 'product_id', api_id_path: 'id', fields: [
  { event_path: 'price', api_path: 'price', type: 'number' }, { event_path: 'quantity', api_path: 'quantity', type: 'number' },
] });
const compare = (ev, calls, maps = [mapping()], options) => compareTp2Event(ev, calls.map(apiCallSummary), id => calls.find(item => item.evidence_id === id), maps, options);

test('TP2 batches decode Base64 and URL-safe Base64 into separate schema-named events with sanitized evidence', () => {
  const secret = 'PRIVATE_PASSPORT', encoded = encode({ product_id: 'SKU-01', passport: secret, email: 'private@example.test' });
  const decoded = decodeRequest({ url: 'https://api.example.test/tp2', body: JSON.stringify({ data: [
    { ue_px: encoded, dtm: Date.parse(at(10)) }, { ue_px: Buffer.from(JSON.stringify(wrap({ price: 2 }))).toString('base64') },
  ] }), capturedAt: at(100) });
  assert.equal(matchesEndpoint('https://api.example.test/tp2'), true);
  assert.deepEqual(decoded.map(item => item.event_name), ['purchase', 'purchase']);
  assert.deepEqual(decoded.map(item => item.network.batch_index), [0, 1]);
  assert.equal(decoded[0].tp2.event_at, at(10));
  assert.equal(decoded[0].payload.passport, '[REDACTED]');
  assert.ok(!JSON.stringify(decoded).includes(secret) && !JSON.stringify(decoded).includes(encoded));
  assert.equal(decoded[0].request_payload.ue_px.sha256.length, 64);
});

test('malformed Base64/JSON remains an explicit decode error; plain ue_pr and TP2 page views are supported', () => {
  for (const value of ['a', 'abc%!', Buffer.from('not json').toString('base64')]) assert.throws(() => decodeBase64Json(value));
  const [bad] = decodeRequest({ url: 'https://api.example.test/tp2', body: JSON.stringify({ data: [{ ue_px: 'broken!' }] }) });
  assert.equal(bad.tp2.decode_status, 'ERROR'); assert.equal(bad.event_kind, 'observation');
  const [plain] = decodeRequest({ url: 'https://api.example.test/custom', body: new URLSearchParams({ ue_pr: JSON.stringify(wrap({ price: 1 })) }).toString(), contentType: 'application/x-www-form-urlencoded' });
  assert.equal(plain.payload.price, 1);
  const [page] = decodeRequest({ url: 'https://api.example.test/tp2', body: JSON.stringify({ data: [{ e: 'pv' }] }) });
  assert.equal(page.event_name, 'page_view');
  assert.equal(decodeRequest({ url: 'https://other.example.test/events', body: '42', contentType: 'application/json' })[0].source, 'CUSTOM');
});

test('identity joins the right array item; only prior responses on the same tab can decide the comparison', () => {
  const matching = call(), wrongTab = { ...call('WRONG', 1), page: { target_id: 'OTHER' } }, future = { ...call('FUTURE', 1), finished_at: at(3000) };
  const result = compare(event(), [matching, wrongTab, future]);
  assert.equal(result.status, 'MATCH'); assert.equal(result.api.evidence_id, 'API-1'); assert.equal(result.comparisons.length, 2);
  const changed = { ...call('NEW', 600000), finished_at: at(1500) };
  const mismatch = compare(event(), [matching, changed]);
  assert.equal(mismatch.status, 'MISMATCH'); assert.equal(mismatch.comparisons[0].expected, 600000);
  assert.equal(compare(event(), [wrongTab, future]).status, 'NO_API');
  assert.equal(compare(event(), [{ ...matching, page: {} }]).status, 'NO_API');
});

test('ambiguous IDs, masked/truncated data and absent mappings do not silently pass or report false mismatches', () => {
  const duplicate = call(); duplicate.response.body.json.data.items.push({ id: 'SKU-01', price: 2 });
  assert.equal(compare(event(), [duplicate]).status, 'AMBIGUOUS');
  const truncated = call(); truncated.response.body = { truncated: true, text: '{}' };
  assert.equal(compare(event(), [truncated]).status, 'REVIEW');
  assert.equal(compare(event(), [call()], []).status, 'MATCH'); // Scalar product identity now joins the unique API item automatically.
  assert.equal(compare(event({ price: 1 }), [call()]).status, 'REVIEW');
  const missing = compare(event({ product_id: 'SKU-01' }), [call()]); assert.equal(missing.status, 'MISMATCH');
  const masked = compare(event({ product_id: 'SKU-01', price: '[REDACTED]', quantity: 2 }), [call()]); assert.equal(masked.status, 'REVIEW');
});

test('mapping configuration is validated and persisted without modifying an existing valid configuration on error', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-tp2-'));
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'mapping.json'), store = new Tp2MappingStore(file); await store.load(); await store.save(mapping());
  await assert.rejects(store.save({ ...mapping(), api_pattern: '[' }));
  const reloaded = new Tp2MappingStore(file); await reloaded.load(); assert.equal(reloaded.list().length, 1);
  assert.throws(() => validateTp2Mapping({ ...mapping(), api_id_path: '' }), /cả hai/);
  await reloaded.delete('MAP'); assert.equal(reloaded.list().length, 0);
});

test('dates compare by Vietnam calendar day and invalid dates require review; identifiers keep leading zeroes', () => {
  const dateMapping = validateTp2Mapping({ ...mapping(), fields: [{ event_path: 'checkin', api_path: 'checkin', type: 'date' }] });
  const api = call(); api.response.body.json.data.items[1].checkin = '2026-11-03T18:00:00Z';
  assert.equal(compare(event({ product_id: 'SKU-01', checkin: '2026-11-04' }), [api], [dateMapping]).status, 'MATCH');
  assert.equal(compare(event({ product_id: 'SKU-01', checkin: '2026-11-03' }), [api], [dateMapping]).status, 'MISMATCH');
  assert.equal(compare(event({ product_id: 'SKU-01', checkin: '2026-02-30' }), [api], [dateMapping]).status, 'REVIEW');
  assert.equal(compare(event({ product_id: 'SKU-01', checkin: '2026-02-30T00:00:00Z' }), [api], [dateMapping]).status, 'REVIEW');
  api.response.body.json.data.items[1].id = '001';
  assert.equal(compare(event({ product_id: '1' }), [api]).status, 'NO_API');
});
