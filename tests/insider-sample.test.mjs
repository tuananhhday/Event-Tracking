import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInsiderSample } from '../src/spec/insider-sample.mjs';

test('Insider JSON retains display event and every default/custom parameter', () => {
  const payload = { event: 'Product Page View', default_parameters: { product_id: 'ITEM-1', taxonomy: ['golf'], quantity: 2 },
    custom_parameters: { event_name: 'A ticketed event title', items: [{ id: 'A' }, { id: 'B' }], enabled: false, total: 0 } };
  const parsed = parseInsiderSample(JSON.stringify(payload), 'product_detail_page_view');
  assert.equal(parsed.status, 'complete'); assert.equal(parsed.format, 'json');
  assert.deepEqual(parsed.payload, payload);
  assert.ok(parsed.parameters.some(p => p.path === 'custom_parameters.items.1.id' && p.group === 'custom'));
});

test('truncated JSON remains unparsed instead of inventing closing syntax', () => {
  const parsed = parseInsiderSample('{"event":"Purchase","default_parameters":{"quantity":2');
  assert.equal(parsed.status, 'unparsed'); assert.equal(parsed.payload, null); assert.ok(parsed.warnings.length);
});

test('Swift custom event arguments are read as literals and retain declared types', () => {
  const parsed = parseInsiderSample(`// iOS (Swift)
let event = Insider.tagEvent("search_hotel")
event?.addParameterWithStringArray()("taxonomy", ["hotel"])
event?.addParameterWithString()("destination", "Sample, City")
event?.addParameterWithDate()("checkin", parseIsoDate("2026-09-07T00:00:00.000Z"))
event?.addParameterWithInt()("quantity", 2)
event?.addParameterWithBoolean()("is_member", false)
event?.build()
// Android (Java)
InsiderEvent event = Insider.Instance.tagEvent("search_hotel");
event.addParameterWithInt("quantity", 999);`, 'search_hotel');
  assert.equal(parsed.status, 'complete'); assert.equal(parsed.sdk_method, 'tagEvent');
  assert.deepEqual(parsed.payload.custom_parameters, { taxonomy: ['hotel'], destination: 'Sample, City', checkin: '2026-09-07T00:00:00.000Z', quantity: 2, is_member: false });
  assert.ok(parsed.parameters.some(p => p.path === 'custom_parameters.checkin' && p.type === 'date'));
});

test('Java-only examples accept typed array literals without executing Java', () => {
  const parsed = parseInsiderSample(`// Android (Java)
InsiderEvent event = Insider.Instance.tagEvent("search_flight");
event.addParameterWithStringArray("taxonomy", new String[]{"flight"});
event.addParameterWithDouble("price", 2.5);
event.build();`, 'search_flight');
  assert.equal(parsed.status, 'complete'); assert.deepEqual(parsed.payload.custom_parameters, { taxonomy: ['flight'], price: 2.5 });
});

test('product SDK construction preserves product defaults and custom attributes', () => {
  const parsed = parseInsiderSample(`let product = Insider.createNewProduct(withID: "ITEM-1", name: "Sample", taxonomy: ["hotel"], imageURL: "https://example.com/a.jpg", price: 100.0, currency: "VND")
product.setQuantity()(2)
product.setCustomAttributeWithString()("hotel_id", "HOTEL-1")
product.setProductURL()("sample://product/ITEM-1")
Insider.visitProductDetailPage(with: product)`, 'product_detail_page_view');
  assert.equal(parsed.status, 'complete'); assert.equal(parsed.payload.event, 'Product Page View');
  assert.deepEqual(parsed.payload.default_parameters, { product_id: 'ITEM-1', product_name: 'Sample', taxonomy: ['hotel'], product_image_url: 'https://example.com/a.jpg', unit_price: 100, currency: 'VND', quantity: 2, url: 'sample://product/ITEM-1' });
  assert.deepEqual(parsed.payload.custom_parameters, { hotel_id: 'HOTEL-1' });
});

test('multiple purchase calls preserve individual products sharing a sale ID', () => {
  const parsed = parseInsiderSample(`let product1 = Insider.createNewProduct(withID: "ITEM-1", name: "First", taxonomy: ["event"], imageURL: "https://example.com/1.jpg", price: 100, currency: "VND")
product1.setQuantity()(1)
Insider.itemPurchased(withSaleID: "ORDER-1", product: product1)
let product2 = Insider.createNewProduct(withID: "ITEM-2", name: "Second", taxonomy: ["event"], imageURL: "https://example.com/2.jpg", price: 50, currency: "VND")
product2.setQuantity()(3)
Insider.itemPurchased(withSaleID: "ORDER-1", product: product2)`, 'confirmation_page_view');
  assert.equal(parsed.status, 'complete'); assert.equal(parsed.records.length, 2);
  assert.deepEqual(parsed.records.map(r => [r.default_parameters.product_id, r.default_parameters.quantity, r.default_parameters.event_group_id]), [['ITEM-1', 1, 'ORDER-1'], ['ITEM-2', 3, 'ORDER-1']]);
});

test('default SDK event without parameters is represented as an event', () => {
  const parsed = parseInsiderSample('Insider.visitHomepage()', 'homepage_view');
  assert.equal(parsed.status, 'complete'); assert.equal(parsed.payload.event, 'Homepage View');
});

test('unresolved SDK expressions remain partial and never execute', () => {
  globalThis.__insiderParserExecuted = false;
  const parsed = parseInsiderSample(`let event = Insider.tagEvent("search_hotel")
event.addParameterWithString("value", (globalThis.__insiderParserExecuted = true))
event.addParameterWithInt("quantity", 2)`, 'search_hotel');
  assert.equal(globalThis.__insiderParserExecuted, false); delete globalThis.__insiderParserExecuted;
  assert.equal(parsed.status, 'partial'); assert.ok(parsed.warnings.length);
  assert.deepEqual(parsed.payload.custom_parameters, { quantity: 2 });
});

test('Insider copied event view preserves group placement, arrays, URL colons, and formatted numbers', () => {
  const parsed = parseInsiderSample(`Product Page View
Event Details
Platform: App
Date: 07/09/2026, 07:00
Time (UTC): 07:00:00
Default Parameters
Product ID: ITEM-1
Name: Sample item
Taxonomy: [voucher]
Quantity: 2
Unit Price: 100,000
URL: sample://product/ITEM-1?time=18:00
Custom Parameters
App Version: 1.0
Platform: AppOTA
Name: Custom product name`, 'product_detail_page_view');
  assert.equal(parsed.status, 'complete');
  assert.deepEqual(parsed.payload.default_parameters, { product_id: 'ITEM-1', product_name: 'Sample item', taxonomy: ['voucher'], quantity: 2, unit_price: 100000, url: 'sample://product/ITEM-1?time=18:00' });
  assert.equal(parsed.payload.custom_parameters.name, 'Custom product name');
  assert.equal(parsed.payload.custom_parameters.platform, 'AppOTA');
  assert.equal(parsed.payload.custom_parameters.app_version, '1.0');
});

test('copied formatted values and item lists stay strings', () => {
  const parsed = parseInsiderSample(`Default Parameters
Product ID: 00001
Custom Parameters
Unit Price String: 100.000
Rateplan Name: [DEMO] Sample fare
Items: [id: ITEM-1; quantity: 2],[id: ITEM-2; quantity: 1]`, 'cart_page_view');
  assert.equal(parsed.status, 'complete');
  assert.equal(parsed.payload.default_parameters.product_id, '00001');
  assert.equal(parsed.payload.custom_parameters.unit_price_string, '100.000');
  assert.equal(parsed.payload.custom_parameters.rateplan_name, '[DEMO] Sample fare');
  assert.equal(parsed.payload.custom_parameters.items, '[id: ITEM-1; quantity: 2],[id: ITEM-2; quantity: 1]');
});

test('text placeholders and references are not accepted as complete event data', () => {
  const partial = parseInsiderSample('Default Param:\nProduct ID: ITEM-1\nURL: <deeplink product>', 'product_detail_page_view');
  assert.equal(partial.status, 'partial');
  const reference = parseInsiderSample('Insider.itemRemovedFromCart(product)\nParam: Y hệt add_to_cart', 'remove_from_cart');
  assert.notEqual(reference.status, 'complete');
  assert.equal(parseInsiderSample('taxonomy: [hotel/flight]', 'listing_page_view').status, 'unparsed');
});
