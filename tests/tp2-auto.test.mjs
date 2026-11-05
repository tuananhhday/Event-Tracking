import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRequest } from '../src/core/decoder.mjs';
import { compareTp2Event, validateTp2Mapping } from '../src/core/tp2-compare.mjs';
import { apiCallSummary } from '../src/core/api-log.mjs';
import { suggestTp2Fields } from '../src/core/tp2-auto.mjs';

const at = offset => new Date(Date.UTC(2026, 10, 5) + offset).toISOString();
function event(params, name = 'order') {
  const wrapper = { schema: 'iglu:com.snowplowanalytics.snowplow/unstruct_event/jsonschema/1-0-0', data: {
    schema: 'iglu:example/custom_event/jsonschema/1-0-0', data: { event_name: name, event_params: params },
  } };
  return { ...decodeRequest({ url: 'https://tracking.example.test/tp2', body: JSON.stringify({ data: [{ ue_px: Buffer.from(JSON.stringify(wrapper)).toString('base64url') }] }), capturedAt: at(2000) })[0],
    evidence_id: 'TP2', page: { target_id: 'TAB', url: 'https://example.test/confirmation' } };
}
function call(body, options = {}) {
  return { evidence_id: 'API', captured_at: at(0), finished_at: at(1000), path: '/booking/api/myorder/ORDER-01',
    url: 'https://api.example.test/booking/api/myorder/ORDER-01', method: 'GET', host: 'api.example.test',
    page: { target_id: 'TAB', url: 'https://example.test/confirmation' }, ok: true,
    response: { status: 200, body: { json: body } }, ...options };
}
const compare = (event, calls, options = {}, mappings = []) => compareTp2Event(event, calls.map(apiCallSummary), id => calls.find(call => call.evidence_id === id), mappings, options);

test('decodes ue_px and automatically compares order fields against myorder without a saved mapping', () => {
  const tp2 = event({ orderCode: 'ORDER-01', totalAmount: 500000, currency: 'VND' });
  const api = call({ data: { id: 'ORDER-01', totalPrice: 600000, currencyCode: 'VND' } });
  const result = compare(tp2, [api]);
  assert.equal(result.automatic, true); assert.equal(result.status, 'MISMATCH'); assert.equal(result.api.evidence_id, 'API');
  assert.deepEqual(result.comparisons.map(field => [field.field, field.api_field, field.status]), [
    ['event_params.orderCode', 'data.id', 'MATCH'], ['event_params.totalAmount', 'data.totalPrice', 'MISMATCH'], ['event_params.currency', 'data.currencyCode', 'MATCH'],
  ]);
});

test('click needs no order, but can compare a related API; unknown event names also correlate by identity', () => {
  const tp2 = event({ product_id: 'ROOM-1', price: 500 }, 'affiliate_click');
  assert.equal(compare(tp2, []).status, 'CLICK');
  const api = call({ data: { productCode: 'ROOM-1', price: 500 } }, { path: '/bookable', url: 'https://api.example.test/bookable' });
  assert.equal(compare(tp2, [api]).status, 'MATCH');
  assert.equal(compare(event({ product_id: 'ROOM-1', price: 500 }, 'custom_event'), [api]).status, 'MATCH');
});

test('unrelated APIs, other tabs and future responses cannot produce a passing order', () => {
  const tp2 = event({ orderCode: 'ORDER-01', totalAmount: 100 });
  const api = call({ data: { id: 'ORDER-01', totalPrice: 100 } });
  assert.equal(compare(tp2, [{ ...api, page: { target_id: 'OTHER' } }]).status, 'NO_API');
  assert.equal(compare(tp2, [{ ...api, finished_at: at(3000) }]).status, 'NO_API');
  assert.equal(compare(tp2, [call({ totalAmount: 100 }, { path: '/unrelated', url: 'https://api.example.test/unrelated' })]).status, 'NO_API');
  const unavailable = { ...api, response: { status: 200, body: { truncated: true } } };
  assert.equal(compare(tp2, [unavailable]).status, 'REVIEW');
  assert.equal(compare(tp2, [call({ data: { id: 'ORDER-01', totalPrice: '[REDACTED]' } })]).status, 'REVIEW');
});

test('API selection uses order identity, never matching prices; multiple possible responses require a choice', () => {
  const tp2 = event({ orderCode: 'ORDER-01', totalAmount: 100 });
  const correct = call({ data: { id: 'ORDER-01', totalPrice: 200 } });
  const other = call({ data: { id: 'ORDER-02', totalPrice: 100 } }, { evidence_id: 'OTHER' });
  assert.equal(compare(tp2, [correct, other]).status, 'MISMATCH');
  assert.equal(compare(event({ totalAmount: 100 }), [correct, other]).status, 'AMBIGUOUS');
  assert.equal(compare(event({ totalAmount: 100 }), [correct, other], { apiId: 'OTHER' }).status, 'MATCH');
  assert.equal(compare(tp2, [other]).status, 'MISMATCH');
});

test('productCode is never guessed to be the root order ID; missing and duplicate fields stay visible', () => {
  const tp2 = event({ items: [{ productCode: 'ROOM-1' }], price: 100, affiliateId: 'AFF-1' });
  const api = call({ data: { id: 'ROOM-1', adult: { price: 100 }, child: { price: 100 } } });
  const suggestion = suggestTp2Fields(tp2, api);
  assert.ok(suggestion.fields.every(field => !field.api_path));
  const result = compare(tp2, [api]);
  assert.equal(result.status, 'REVIEW'); assert.equal(result.comparisons.length, 3);
  assert.ok(result.comparisons.every(field => field.status === 'REVIEW'));
});

test('reordered arrays join by product identity; duplicate or missing identities do not use array position', () => {
  const tp2 = event({ orderCode: 'ORDER-01', items: [{ productCode: 'A', price: 10 }, { productCode: 'B', price: 20 }] });
  const api = call({ data: { id: 'ORDER-01', items: [{ product_id: 'B', price: 20 }, { product_id: 'A', price: 10 }] } });
  const result = compare(tp2, [api]);
  assert.equal(result.status, 'MATCH');
  assert.equal(result.comparisons.find(field => field.field === 'event_params.items.0.price').api_field, 'data.items.1.price');
  const duplicate = structuredClone(api); duplicate.response.body.json.data.items.push({ product_id: 'A', price: 10 });
  assert.equal(compare(tp2, [duplicate]).status, 'REVIEW');
  assert.equal(compare(event({ items: [{ price: 10 }] }), [api]).status, 'REVIEW');
});

test('saved array suggestions recompute identity joins for new events rather than reuse old indexes', () => {
  const first = event({ orderCode: 'ORDER-01', items: [{ productCode: 'A', price: 10 }, { productCode: 'B', price: 20 }] });
  const api = call({ data: { id: 'ORDER-01', items: [{ product_id: 'B', price: 20 }, { product_id: 'A', price: 10 }] } });
  const mapping = validateTp2Mapping({ name: 'Order', event_name: 'order', api_pattern: '/myorder', dynamic_items: true, fields: suggestTp2Fields(first, api).fields });
  const next = event({ orderCode: 'ORDER-01', items: [{ productCode: 'B', price: 20 }, { productCode: 'A', price: 10 }] });
  assert.equal(compare(next, [api], {}, [mapping]).status, 'MATCH');
  next.payload.event_params.items[0].price = 99;
  assert.equal(compare(next, [api], {}, [mapping]).status, 'MISMATCH');
});

test('different number/string types and absent business data are not silently accepted', () => {
  assert.equal(compare(event({ totalAmount: '100' }), [call({ data: { totalPrice: 100 } })]).status, 'MISMATCH');
  assert.equal(compare(event({}), [call({ data: {} })]).status, 'REVIEW');
});
