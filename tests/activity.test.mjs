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

const base = { evidence_id: 'EV-1', event_name: 'cart_page_view', source: 'INSIDER', layer: 'TRACKING_REQUEST', captured_at: '2026-10-30T00:00:00Z' };
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
  const event = { ...base, layer: 'JS_QUEUE', queue_name: 'InsiderQueue', queue_type: 'cart', payload: {}, capture: { incomplete: true, reasons: ['accessor_omitted'] } };
  const init = { ...base, evidence_id: 'EV-INIT', event_name: 'insider_init', layer: 'JS_QUEUE', queue_name: 'InsiderQueue', queue_type: 'init', payload: { type: 'init' } };
  const hit = { ...base, evidence_id: 'EV-HIT', event_name: 'pageView', captured_at: '2026-10-30T00:00:01Z', network: { phase: 'request' }, payload: { event: 'pageView', page_type: 'cart' } };
  assert.equal(specCoverage([c], [event, init, hit]).rows[0].status, 'REVIEW');
  // Whether it was sent does not depend on how much of the payload could be read.
  assert.equal(specCoverage([c], [event, init]).rows[0].status, 'NOT_SENT');
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
