import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRequest } from '../src/core/decoder.mjs';
import { activityEvent } from '../src/core/activity.mjs';

const request = (params, extra = {}) => decodeRequest({ url: 'https://www.google-analytics.com/g/collect?' + new URLSearchParams(params), ...extra });

test('GA4 compact products decode every transmitted item, retain exact wire fields and never create a queue ecommerce object', () => {
  const [event] = request({ en: 'purchase', cu: 'VND', pr2: 'idSECOND~nmAnother~qt2~pr3.5',
    pr1: 'idSKU-1~nmÁo + 100%~brBrand~caGolf~c2Adult~c3Gear~c4Top~c5Short~vaBlue~pr0~qt0~ds0~lp0~liRELATED~lnRelated products~afShop~cpZERO~piP1~pnPromo~cnBanner~csHero~loSTORE~k0provider~v0Vendor' });
  assert.equal(event.event_name, 'purchase');
  assert.equal(event.network.decode_status, 'DECODED');
  assert.deepEqual(event.network.ga4_decode.item_indexes, [1, 2]);
  assert.equal(event.payload.items.length, 2);
  assert.equal(event.payload.items[0].item_id, 'SKU-1');
  assert.equal(event.payload.items[0].item_name, 'Áo + 100%');
  assert.equal(event.payload.items[0].quantity, 0);
  assert.equal(event.payload.items[0].price, 0);
  assert.equal(event.payload.items[0].discount, 0);
  assert.equal(event.payload.items[0].index, 0);
  assert.equal(event.payload.items[0].promotion_name, 'Promo');
  assert.equal(event.payload.items[0].provider, 'Vendor');
  assert.equal(event.payload.items[1].price, 3.5);
  assert.equal(event.payload.items[1].item_id, 'SECOND');
  assert.equal(event.payload.ecommerce, undefined);
  assert.equal(event.original_payload.pr2, 'idSECOND~nmAnother~qt2~pr3.5');
  const view = activityEvent(event);
  assert.match(view.parameter_origins['default_parameters.items.1.price'], /original_payload\["pr2"\].*compact pr, token 3/);
});

test('compact item decoding performs one URL decoding pass and preserves empty, absent and noninteger numbers', () => {
  const [event] = request({ en: 'view_item', pr1: 'idSKU%2F1~nmLiteral %20 and +~pr1.25~qt0.5', pr3: 'idSparse~nm~pr' });
  assert.equal(event.payload.items[0].item_id, 'SKU%2F1');
  assert.equal(event.payload.items[0].item_name, 'Literal %20 and +');
  assert.equal(event.payload.items[0].quantity, 0.5);
  assert.equal(event.payload.items[1].item_name, '');
  assert.equal(event.payload.items[1].quantity, undefined, 'missing quantity is never fabricated as one');
  assert.equal(event.payload.items[1].price, '', 'empty numeric field is not silently converted to zero');
  assert.deepEqual(event.network.ga4_decode.item_indexes, [1, 3]);
  assert.ok(event.network.ga4_decode.warnings.some(w => w.code === 'INVALID_NUMERIC_ITEM_VALUE'));
});

test('newline collect batches share query metadata but keep each event and item independent', () => {
  const body = new URLSearchParams({ en: 'view_item', pr1: 'idFIRST~qt1', 'ep.currency': 'VND' }).toString() + '\n'
    + new URLSearchParams({ en: 'add_to_cart', pr1: 'idSECOND~qt2', 'ep.currency': 'USD' }).toString();
  const events = request({ v: '2', tid: 'G-DEMO', dl: 'https://example.test/vi/golf', 'ep.currency': 'EUR' }, { body, contentType: 'text/plain', requestId: 'BATCH' });
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => e.event_name), ['view_item', 'add_to_cart']);
  assert.deepEqual(events.map(e => e.payload.items[0].item_id), ['FIRST', 'SECOND']);
  assert.deepEqual(events.map(e => e.payload.currency), ['VND', 'USD']);
  assert.ok(events.every(e => e.payload.tid === 'G-DEMO' && e.network.request_id === 'BATCH'));
  assert.deepEqual(events.map(e => e.network.batch_index), [0, 1]);
  assert.equal(events[1].request_parameter_sources.query['ep.currency'], 'EUR');
  assert.equal(events[1].request_parameter_sources.body['ep.currency'], 'USD');
  assert.equal(events[0].original_payload.pr1, 'idFIRST~qt1');
  assert.equal(events[1].original_payload.pr1, 'idSECOND~qt2');
});

test('duplicate, conflicting and unknown compact fields stay partial instead of picking an arbitrary value', () => {
  const [event] = request({ en: 'purchase', pr1: 'idA~qt1~qt2~xxunrecognized~k0price~v099~k1orphan', 'epn.value': '1' });
  assert.equal(event.payload.items[0].quantity, undefined);
  assert.equal(event.capture.incomplete, true);
  assert.equal(event.network.decode_status, 'PARTIAL');
  const codes = event.network.ga4_decode.warnings.map(w => w.code);
  assert.ok(codes.includes('DUPLICATE_ITEM_FIELD'));
  assert.ok(codes.includes('UNKNOWN_COMPACT_ITEM_FIELD'));
  assert.ok(codes.includes('UNPAIRED_CUSTOM_ITEM_FIELD'));
  assert.ok(event.original_payload.pr1.includes('xxunrecognized'));
  const [collision] = request({ en: 'purchase', pr1: 'idA~pr1~k0price~v099' });
  assert.equal(collision.payload.items[0].price, undefined, 'custom field cannot overwrite a transmitted core value');
  assert.equal(collision.network.decode_status, 'PARTIAL');
});

test('repeated wire keys and alias collisions retain all values and mark ambiguous decoding', () => {
  const [event] = decodeRequest({ url: 'https://www.google-analytics.com/g/collect?en=purchase&pr1=idA&pr1=idB&epn.quantity=0&epn.quantity=2&value=x&ep.value=y' });
  assert.deepEqual(event.original_payload.pr1, ['idA', 'idB']);
  assert.deepEqual(event.payload.quantity, ['0', '2']);
  assert.deepEqual(event.payload.value, ['x', 'y']);
  assert.equal(event.payload.items.length, 0, 'two values for pr1 are not guessed to be two product indexes');
  assert.equal(event.capture.incomplete, true);
  assert.equal(event.network.decode_status, 'PARTIAL');
});

test('sensitive custom compact item values are masked in normalized payload, raw payload, sources and URL', () => {
  const [event] = request({ en: 'view_item', pr1: 'idPRODUCT~k0user_id~v0private-user-identifier~k1provider~v1public-provider~k2email~v2person@example.test' });
  assert.equal(event.payload.items[0].item_id, 'PRODUCT');
  assert.equal(event.payload.items[0].user_id, '[REDACTED]');
  assert.equal(event.payload.items[0].provider, 'public-provider');
  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes('private-user-identifier'));
  assert.ok(!serialized.includes('person@example.test'));
  assert.ok(serialized.includes('public-provider'));
  assert.match(event.network.raw_url_hash, /^[a-f0-9]{64}$/);
  assert.match(event.network.raw_body_hash, /^[a-f0-9]{64}$/);
});

test('compact custom secrets remain masked in POST bodies and nested page URLs', () => {
  const compact = 'idPRODUCT~k0user_id~v0post-private-identifier';
  const page = 'https://example.test/page?' + new URLSearchParams({ pr1: compact });
  const [event] = request({ en: 'view_item', dl: page }, { body: new URLSearchParams({ pr1: compact }).toString(), contentType: 'text/plain' });
  assert.equal(event.payload.items[0].user_id, '[REDACTED]');
  assert.ok(!JSON.stringify(event).includes('post-private-identifier'));
  assert.match(event.network.raw_body_hash, /^[a-f0-9]{64}$/);
});

test('oversized compact fields are explicitly incomplete and hashed without keeping custom secrets', () => {
  const [event] = request({ en: 'view_item', pr1: 'k0user_id~v0private-oversized-identifier' + 'x'.repeat(200000) });
  assert.equal(event.network.decode_status, 'PARTIAL');
  assert.ok(event.network.ga4_decode.warnings.some(w => w.code === 'COMPACT_ITEM_TOO_LARGE'));
  assert.ok(!JSON.stringify(event).includes('private-oversized-identifier'));
  assert.match(event.original_payload.pr1, /^\[OMITTED_COMPACT_ITEM sha256=[a-f0-9]{64}\]$/);
});

test('numeric product index aliases remain ambiguous rather than becoming two products at one wire index', () => {
  const [event] = request({ en: 'view_item', pr1: 'idFIRST', pr01: 'idOTHER' });
  assert.equal(event.network.decode_status, 'PARTIAL');
  assert.deepEqual(event.payload.items, []);
  assert.ok(event.network.ga4_decode.warnings.some(w => w.code === 'AMBIGUOUS_ITEM_INDEX'));
  assert.equal(event.original_payload.pr1, 'idFIRST');
  assert.equal(event.original_payload.pr01, 'idOTHER');
});

test('invalid numeric values are kept as transmitted text rather than coerced into invented numeric values', () => {
  const [event] = request({ en: 'view_item', pr1: 'idA~pr0x10~qtNaN', 'epn.value': '0x20', 'epn.zero': '0', 'epn.blank': '' });
  assert.equal(event.payload.items[0].price, '0x10');
  assert.equal(event.payload.items[0].quantity, 'NaN');
  assert.equal(event.payload.value, '0x20');
  assert.equal(event.payload.zero, 0);
  assert.equal(event.payload.blank, '');
});
