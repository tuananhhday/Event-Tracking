import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRequest } from '../src/core/decoder.mjs';
import { activityEvent, activityEntries } from '../src/core/activity.mjs';

test('GA4 compact ecommerce becomes business JSON while wire payload is retained', () => {
  const body = 'en=begin_checkout&cu=VND&epn.value=2500000&ep.service=golf&ep.entry_source=&v=2&tid=G-TEST&_s=8&pr1=idgolf_18_A~nmSample+Golf~cagolf~pr2500000~qt1~k0tee_time~v015%3A04';
  const [e] = decodeRequest({ url: 'https://www.google-analytics.com/g/collect', body, contentType: 'application/x-www-form-urlencoded' });
  const a = activityEvent(e);
  assert.equal(a.json.default_parameters.items[0].item_id, 'golf_18_A');
  assert.equal(a.json.default_parameters.items[0].price, 2500000);
  assert.equal(a.json.default_parameters.items[0].tee_time, '15:04');
  assert.equal(a.json.default_parameters.currency, 'VND');
  assert.equal(a.json.default_parameters.value, 2500000);
  assert.equal(a.json.custom_parameters.entry_source, '');
  assert.equal(a.json.default_parameters.tid, undefined);
  assert.equal(a.json.default_parameters.pr1, undefined);
  assert.ok(e.request_payload.pr1.includes('~qt1'));
});

test('queue/request evidence pairs one-to-one, never hides repeated outgoing requests', () => {
  const base = { source: 'GA4', event_name: 'begin_checkout', captured_at: '2026-10-30T00:00:00Z', page: { target_id: 'tab1', url: 'https://example.test/checkout' }, payload: { event: 'begin_checkout', value: 2500000 } };
  const queue = { ...base, evidence_id: 'queue', layer: 'JS_QUEUE' };
  const request = { ...base, evidence_id: 'request1', layer: 'TRACKING_REQUEST', network: { phase: 'request' } };
  const repeated = { ...request, evidence_id: 'request2' };
  let rows = activityEntries([queue, request, repeated]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].evidence_ids, ['queue', 'request1']);
  assert.deepEqual(rows[1].evidence_ids, ['request2']);
  assert.equal(activityEntries([queue, { ...request, payload: { event: 'begin_checkout', value: 100 } }]).length, 2);
  assert.equal(activityEntries([queue, { ...request, page: { ...base.page, target_id: 'other' } }]).length, 2);
  assert.equal(activityEntries([queue, { ...request, captured_at: '2026-10-30T00:01:00Z' }]).length, 2);
});
