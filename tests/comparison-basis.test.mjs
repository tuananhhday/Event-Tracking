import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createApp } from '../src/server.mjs';
import { manualCase } from '../src/spec/import.mjs';
import { compareSelectedEvent, matchTracked, trackedView } from '../src/core/catalog.mjs';
import { insiderHitView } from '../src/core/insider-hit.mjs';

const sample = { type: 'product', value: { id: 'SAMPLE-SHIRT', name: 'Áo thun', url: 'https://example.test/merchandise/shirt', unit_price: 180000,
  unit_sale_price: 100000, quantity: 1, currency: 'VND', custom: { category: 'Áo', provider: 'Cửa hàng', unit_price_string: '180.000' } } };
const webCase = () => manualCase({ source: 'INSIDER', flow: 'Merchandise', event_name: 'product_detail_page_view', sample: JSON.stringify(sample) }).testCase;
const queueValue = { ...sample.value, id: 'ACTUAL-DUCK', name: 'Vịt con', unit_price: 250000, unit_sale_price: 200000 };
const wirePayload = { event: 'pageView', page_type: 'productDetail', product: { id: queueValue.id, name: queueValue.name, url: queueValue.url,
  price: { originalValue: queueValue.unit_price, value: queueValue.unit_sale_price, currency: 'VND' }, quantity: 1, customAttributes: queueValue.custom } };
const hit = { evidence_id: 'HIT', source: 'INSIDER', layer: 'TRACKING_REQUEST', event_name: 'product_detail_page_view', payload: wirePayload,
  network: { phase: 'request' }, page: { target_id: 'TAB', url: 'https://example.test/merchandise/duck' } };

async function appFor(t, cases) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-comparison-basis-'));
  const app = await createApp({ port: 0, runsDir: dir, initialCases: cases });
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const base = await app.listen(); app.manager.start(); app.manager.startComparison('Merchandise');
  return { app, detail: async (event, selected) => {
    const response = await fetch(`${base}/api/event?id=${event.evidence_id}&case_id=${selected.id}`);
    assert.equal(response.status, 200); return response.json();
  } };
}

test('web Insider comparison displays the exact queue payload checked, while preserving the linked request separately', async t => {
  const selected = webCase(), { app, detail } = await appFor(t, [selected]);
  const push = app.manager.emit({ ...hit, layer: 'JS_QUEUE', payload: { type: 'product', value: queueValue }, queue_name: 'InsiderQueue', queue_type: 'product', network: undefined });
  app.manager.emit({ ...hit, layer: 'JS_QUEUE', event_name: 'insider_init', queue_type: 'init', payload: { type: 'init' }, network: undefined });
  const request = app.manager.emit(hit), result = await detail(push, selected);
  assert.equal(result.spec.verdict, 'PASS');
  assert.equal(result.spec.comparison.evidence_id, push.evidence_id);
  assert.equal(result.spec.comparison.format, 'RAW');
  assert.deepEqual(result.comparison_payload, push.payload);
  assert.equal(result.comparison_payload.default_parameters, undefined, 'do not compare a queue contract to a recorded-hit structure');
  assert.equal(result.delivery.hit.evidence_id, request.evidence_id);
  const price = result.spec.checks.find(check => check.path === 'value.unit_price');
  assert.deepEqual([price.op, price.expected, price.actual, price.verdict], ['type', 'integer', 250000, 'PASS']);

  const context = { window: {} }; vm.runInNewContext(await fs.readFile(new URL('../src/web/shared/comparison-view.js', import.meta.url), 'utf8'), context);
  const model = context.window.EventQAComparison.build(selected, result), html = context.window.EventQAComparison.render(model);
  assert.equal(model.actualLabel, 'Thực tế · Insider');
  assert.equal(model.expectedLabel, 'Theo đặc tả · Insider');
  assert.match(model.basisNote, /dữ liệu Insider trên website/);
  assert.equal(model.errors, 0);
  assert.equal(model.checked, Object.keys(selected.rules[0].fields).length);
  assert.ok(!model.lines.some(line => line.path.startsWith('default_parameters') || line.path === 'event'));
  const row = model.lines.find(line => line.path === 'value.unit_price');
  assert.match(row.left, /180000/); assert.match(row.right, /250000/); assert.match(row.note, /Đúng kiểu dữ liệu: số nguyên/);
  assert.match(html, /Chưa thấy lỗi/); assert.match(row.note, /Chưa kiểm tra nội dung/);
  assert.match(html, /chưa được xác nhận đúng\/sai/);
});

test('fixed-value Insider rules fail on actual queue values, even when a linked request exists', async t => {
  const selected = webCase(); selected.rules[0].fields['value.unit_price'] = { op: 'eq', value: 180000 };
  const { app, detail } = await appFor(t, [selected]);
  const push = app.manager.emit({ ...hit, layer: 'JS_QUEUE', payload: { type: 'product', value: queueValue }, queue_type: 'product', network: undefined });
  app.manager.emit({ ...hit, layer: 'JS_QUEUE', event_name: 'insider_init', queue_type: 'init', payload: { type: 'init' }, network: undefined });
  app.manager.emit(hit);
  const result = await detail(push, selected);
  assert.equal(result.spec.verdict, 'FAIL');
  assert.ok(result.spec.issues.some(issue => issue.path === 'value.unit_price' && issue.actual === 250000 && issue.expected === 180000));
  assert.equal(result.comparison_payload.value.unit_price, 250000);
});

test('Insider request contracts retain raw wire shape or recorded parameter shape according to the actual evaluated rule', async t => {
  const recorded = manualCase({ source: 'INSIDER', flow: 'Merchandise', event_name: hit.event_name,
    sample: JSON.stringify(insiderHitView(hit.event_name, wirePayload)) }).testCase;
  recorded.id = 'RECORDED';
  const raw = { ...webCase(), id: 'RAW-HIT', sample: wirePayload, rules: [{ source: 'INSIDER', layer: 'TRACKING_REQUEST', event_name: hit.event_name,
    fields: { 'product.price.value': { op: 'eq', value: 200000 } } }] };
  const { app, detail } = await appFor(t, [raw, recorded]), event = app.manager.emit(hit);
  const result = await detail(event, recorded);
  assert.equal(result.spec.verdict, 'PASS'); assert.equal(result.spec.comparison.format, 'INSIDER_RECORDED');
  assert.deepEqual(result.comparison_payload, insiderHitView(hit.event_name, wirePayload));
  const requestResult = await detail(event, raw);
  assert.equal(requestResult.spec.verdict, 'PASS'); assert.equal(requestResult.spec.comparison.format, 'RAW');
  assert.deepEqual(requestResult.comparison_payload, wirePayload);
});

test('explicit comparison rejects opposite vendors even for identical names and matching fields', async t => {
  for (const [expectedSource, actualSource] of [['GA4', 'INSIDER'], ['INSIDER', 'GA4']]) {
    const selected = { ...webCase(), source: expectedSource, rules: [{ source: expectedSource, layer: 'TRACKING_REQUEST', event_name: hit.event_name, fields: { event: { op: 'eq', value: 'same' } } }] };
    const other = { ...hit, source: actualSource, payload: { event: 'same' } };
    assert.equal(matchTracked([selected], other), null);
    const result = compareSelectedEvent(selected, other);
    assert.equal(result.verdict, 'FAIL'); assert.equal(result.issues[0].code, 'SOURCE_MISMATCH'); assert.deepEqual(result.checks, []);
  }
  const selected = webCase(), { app, detail } = await appFor(t, [selected]);
  const result = await detail(app.manager.emit({ ...hit, source: 'GA4' }), selected);
  assert.equal(result.spec.verdict, 'FAIL'); assert.equal(result.spec.issues[0].code, 'SOURCE_MISMATCH');
});

test('a previous-attempt request cannot turn a new queue comparison into a sent match', async t => {
  const selected = webCase(), { app, detail } = await appFor(t, [selected]);
  app.manager.emit(hit); app.manager.startComparison('Merchandise');
  const push = app.manager.emit({ ...hit, layer: 'JS_QUEUE', payload: { type: 'product', value: queueValue }, queue_type: 'product', network: undefined });
  app.manager.emit({ ...hit, layer: 'JS_QUEUE', event_name: 'insider_init', queue_type: 'init', payload: { type: 'init' }, network: undefined });
  const result = await detail(push, selected);
  assert.equal(result.spec.verdict, 'PENDING'); assert.equal(result.delivery.hit, null);
  assert.deepEqual(result.comparison_payload, push.payload);
});

test('GA4 comparison keeps missing server fields absent rather than substituting the dataLayer push', () => {
  const selected = { id: 'GA4', source: 'GA4', rules: [{ source: 'GA4', layer: 'JS_QUEUE', event_name: 'page_view', fields: { page_type: { op: 'eq', value: 'listing' } } }] };
  const event = { evidence_id: 'GA4-HIT', source: 'GA4', layer: 'TRACKING_REQUEST', event_name: 'page_view', payload: { event: 'page_view' } };
  const result = matchTracked([selected], event);
  assert.equal(result.verdict, 'FAIL'); assert.equal(result.comparison.format, 'GA4_RECEIVED');
  assert.deepEqual(trackedView(event, result.comparison.format), { event: 'page_view' });
});
