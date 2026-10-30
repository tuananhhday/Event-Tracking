import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { activityEvent } from '../src/core/activity.mjs';
import { createApp } from '../src/server.mjs';
import { specCoverage } from '../src/core/catalog.mjs';
import { firingChecks } from '../src/core/firing.mjs';
import { validateCase } from '../src/core/rules.mjs';
import { queueEvents } from '../src/collectors/cdp.mjs';
import { decodeRequest } from '../src/core/decoder.mjs';

const base = { evidence_id: 'EV-1', event_name: 'cart_page_view', source: 'INSIDER', layer: 'TRACKING_REQUEST', captured_at: '2026-10-30T00:00:00Z' };
test('beforeSend is unwrapped into its business event and retains the SDK envelope as provenance', () => {
  const envelope = { partner: 'test', source: 'web', events: [{ event_name: 'golf_checkout', timestamp: 123, event_params: { c_product_id: 'golf-1', c_total: 3150000, c_quantity: 1, ta: 'golf' } }] };
  const [event] = queueEvents({ queue: 'InsiderDispatch', item: { name: 'Ucd:event:beforeSend', data: envelope } });
  assert.equal(event.event_name, 'golf_checkout');
  assert.equal(event.queue_type, 'sdk_before_send');
  assert.deepEqual(event.original_payload, envelope);
  const a = activityEvent(event);
  assert.equal(a.json.event, 'Golf Checkout');
  assert.equal(a.json.custom_parameters.total, 3150000);
  assert.equal(a.json.custom_parameters.quantity, 1);
  assert.equal(a.json.default_parameters.ta, 'golf');
  assert.equal(a.json.default_parameters.partner, undefined);
  assert.equal(a.json.default_parameters.events, undefined);
  assert.equal(a.json.custom_parameters.app_version, undefined);
  assert.equal(a.observation, 'sdk_before_send');
  assert.equal(a.parameter_origins['custom_parameters.total'], 'original_payload.events[0].event_params.c_total');
});

test('Golf request comparisons read normalized fields and only report genuinely absent sample fields', () => {
  const actual = { event_name: 'golf_checkout', event_params: { c_product_id: 'golf-1', c_name: 'Selected golf', c_total: 3150000, c_currency: 'VND', c_using_date: '2026-11-07T00:00:00.000Z', c_using_date_str: '2026-11-07', c_destination: 'HCM', c_destination_id: '', c_golf_club_id: 'golf-1', c_golf_club_code: 'CLUB', c_slug: 'club', c_items: '[course: A; players: 1]', c_quantity: 1, ta: 'golf' } };
  const event = { ...decodeRequest({ url: 'https://unification.useinsider.com/api/event/', contentType: 'application/json', body: JSON.stringify({ events: [actual] }) })[0], evidence_id: 'EV-GOLF' };
  const missing = ['default_parameters.sid', ...['app_version', 'device_manufacturer', 'device_model', 'os_version', 'platform', 'taxonomy'].map(k => `custom_parameters.${k}`)];
  const fields = { event: { op: 'eq', value: 'Golf Checkout' }, ...Object.fromEntries(missing.map(k => [k, { op: 'exists' }])), 'custom_parameters.product_id': { op: 'type', value: 'string' }, 'custom_parameters.total': { op: 'type', value: 'integer' }, 'custom_parameters.quantity': { op: 'type', value: 'integer' } };
  const c = { id: 'TC-GOLF', source: 'INSIDER', payload_format: 'default_custom_parameters', rules: [{ layer: 'TRACKING_REQUEST', event_name: 'golf_checkout', fields }] };
  const row = specCoverage([c], [event]).rows[0];
  assert.deepEqual(row.issues.map(i => i.path).sort(), missing.sort());
  assert.ok(row.issues.every(i => i.code === 'MISSING_FIELD'));
  const step = { id: 'STEP-GOLF', status: 'COMPLETED', started_at: '2026-01-01', completed_at: '2027-01-01' };
  const result = validateCase(c, [{ ...event, step_id: step.id, test_case_id: c.id }], step);
  assert.deepEqual(result.results[0].issues.map(i => i.path).sort(), missing.sort());
  assert.equal(event.payload.event_params.ta, 'golf', 'raw wire name is retained rather than guessed as a custom taxonomy');
});
test('explicit Insider default/custom parameters are preserved without filling specification examples', () => {
  const payload = { event: 'Cart Page View', default_parameters: { product_id: 'real-id', unit_price: 110000, quantity: 1 }, custom_parameters: { platform: 'AppOTA', provider: 'actual-provider' } };
  const actual = activityEvent({ ...base, payload });
  assert.deepEqual(actual.json, payload);
  assert.equal(actual.json.custom_parameters.device_model, undefined);
  assert.equal(actual.parameter_mapping, 'explicit_parameter_groups');
});

test('request and queue parameter groups retain nested products, types and original payloads', () => {
  const payload = { event_name: 'cart_page_view', event_params: { currency: 'VND', items: [{ id: 'sku-1', quantity: 2 }], custom: { provider: 'local' }, c_total: 220000 } };
  const original = structuredClone(payload);
  const actual = activityEvent({ ...base, payload });
  assert.equal(actual.json.event, 'Cart Page View');
  assert.deepEqual(actual.json.default_parameters.items, [{ id: 'sku-1', quantity: 2 }]);
  assert.equal(actual.json.custom_parameters.total, 220000);
  assert.equal(actual.json.custom_parameters.provider, 'local');
  assert.equal(actual.json.custom_parameters.app_version, undefined);
  assert.deepEqual(payload, original);
  const queue = activityEvent({ ...base, layer: 'JS_QUEUE', payload: { type: 'cart', value: { items: [{ id: 'sku-1' }], total: 220000 } } });
  assert.equal(queue.json.default_parameters.items[0].id, 'sku-1');
  assert.equal(queue.json.default_parameters.product_id, undefined, 'do not invent a single-item mobile shape for a web cart');
  assert.equal(queue.json.custom_parameters.device_model, undefined);
});

test('partial captures are reviewable evidence, never a successful or failing field verdict', () => {
  const c = { id: 'TC', source: 'INSIDER', rules: [{ layer: 'JS_QUEUE', event_name: 'cart_page_view', fields: { total: { op: 'type', value: 'number' } } }] };
  const event = { ...base, layer: 'JS_QUEUE', payload: {}, capture: { incomplete: true, reasons: ['accessor_omitted'] } };
  assert.equal(specCoverage([c], [event]).rows[0].status, 'REVIEW');
  const step = { id: 'STEP', status: 'COMPLETED', started_at: '2026-10-29T00:00:00Z', completed_at: '2026-10-31T00:00:00Z' };
  assert.equal(validateCase(c, [{ ...event, step_id: 'STEP', test_case_id: 'TC' }], step).verdict, 'REVIEW');
  assert.equal(firingChecks([event]).byEvent.get(event.evidence_id)[0].status, 'WARN');
});

test('activity API pages every occurrence, excludes response duplicates, and provides full JSON detail', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-activity-'));
  const app = await createApp({ port: 0, runsDir: dir, initialCases: [] });
  const url = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  app.manager.start();
  let last;
  for (let i = 0; i < 205; i++) last = app.manager.emit({ ...base, network: { phase: 'request', request_id: String(i) }, payload: { event_params: { product_id: `sku-${i}`, custom: { total: i } } } });
  app.manager.emit({ ...base, network: { phase: 'response', status: 200, request_id: '204' }, payload: {} });
  const ids = [];
  let next = '';
  do {
    const page = await (await fetch(url + '/api/activity' + (next ? '?before=' + next : ''))).json();
    assert.equal(page.total, 205);
    ids.push(...page.events.map(e => e.evidence_id)); next = page.next;
  } while (next);
  assert.equal(ids.length, 205); assert.equal(new Set(ids).size, 205);
  const detail = await (await fetch(url + '/api/event?id=' + last.evidence_id)).json();
  assert.equal(detail.activity.json.default_parameters.product_id, 'sku-204');
  assert.equal(detail.activity.json.custom_parameters.total, 204);
  assert.equal(detail.event.payload.event_params.custom.total, 204);
  const compact = await (await fetch(url + '/api/activity?compact=1')).json();
  assert.equal(compact.events[0].json, undefined, 'polling lists do not repeatedly transfer full parameter payloads');
  assert.equal(compact.events[0].default_count, 1);
  assert.equal(compact.events[0].custom_count, 1);
  const state = await (await fetch(url + '/api/state?compact=1')).json();
  assert.equal(state.eventsCompact, true);
  assert.ok(state.events.every(e => e.payload === undefined));
  assert.equal(detail.activity.json.custom_parameters.total, 204, 'full detail remains available on demand');
});

test('request-only steps treat unobserved JavaScript queues as REVIEW', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-networkonly-'));
  const c = { id: 'TC', source: 'INSIDER', name: 'Cart', rules: [{ layer: 'JS_QUEUE', event_name: 'cart_page_view', fields: {} }] };
  const app = await createApp({ port: 0, runsDir: dir, initialCases: [c] });
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  app.manager.start({ capture_queues: false });
  const step = app.manager.startStep('TC');
  assert.deepEqual(step.observed_layers, ['TRACKING_REQUEST']);
  assert.equal(app.manager.completeStep().verdict, 'REVIEW');
});
