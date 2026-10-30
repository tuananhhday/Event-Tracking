import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { activityEvent } from '../src/core/activity.mjs';
import { decodeRequest } from '../src/core/decoder.mjs';
import { queueEvents } from '../src/collectors/cdp.mjs';
import { specCoverage } from '../src/core/catalog.mjs';
import { createApp } from '../src/server.mjs';
import { importSpec } from '../src/spec/import.mjs';
import { validateCase } from '../src/core/rules.mjs';

const request = (flow, id) => ({ ...decodeRequest({ url: 'https://unification.useinsider.com/api/event/', pageUrl: `https://test.example/vi/${flow}/checkout`, contentType: 'application/json', requestId: id, body: JSON.stringify({ events: [{ event_name: 'cart_page_view', event_params: { c_product_id: id, c_total: 100, ta: flow } }] }) })[0], evidence_id: id });
test('a Flight cart cannot satisfy a Golf step even when names and parameter types match', () => {
  const c = { id: 'GOLF', name: 'Golf cart', flow: 'Golf', source: 'INSIDER', rules: [{ event_name: 'cart_page_view', layer: 'TRACKING_REQUEST', fields: { 'event_params.c_total': { op: 'type', value: 'integer' } } }] };
  const step = { id: 'STEP', status: 'COMPLETED', started_at: '2026-01-01', completed_at: '2027-01-01' };
  const scoped = flow => ({ ...request(flow, flow), captured_at: '2026-10-30T00:00:00Z', step_id: step.id, test_case_id: c.id });
  assert.equal(validateCase(c, [scoped('golf')], step).verdict, 'PASS');
  const wrong = validateCase(c, [scoped('flight')], step);
  assert.equal(wrong.verdict, 'FAIL');
  assert.ok(wrong.results[0].issues.some(i => i.code === 'MISSING_EVENT'));
});
test('shared cart names stay in their own flow and unknown payloads are not assigned to a random flow', () => {
  const cases = ['golf', 'flight'].map(flow => ({ id: flow, name: flow, flow, source: 'INSIDER', payload_format: 'default_custom_parameters', rules: [{ event_name: 'cart_page_view', source: 'INSIDER', layer: 'TRACKING_REQUEST', fields: { 'custom_parameters.product_id': { op: 'type', value: 'string' } } }] }));
  const events = [request('golf', 'G1'), request('flight', 'F1'), request('golf', 'G2')];
  const coverage = specCoverage(cases, events);
  assert.equal(coverage.rows.find(r => r.case_id === 'golf').seen, 2);
  assert.equal(coverage.rows.find(r => r.case_id === 'flight').seen, 1);
  const unknown = { ...events[0], evidence_id: 'UNKNOWN', page: { url: 'https://test.example/' }, payload: { event_params: { c_product_id: 'ambiguous' } } };
  assert.equal(activityEvent(unknown).flow_id, 'unknown');
  assert.equal(specCoverage(cases, [unknown]).totals.seen, 0);
  const conflict = { ...events[0], payload: { event_params: { ta: 'flight' } } };
  assert.equal(activityEvent(conflict).flow_id, 'golf', 'the page remains the observation context');
  assert.equal(activityEvent(conflict).flow_conflict, true, 'wrong payload family is visible rather than reassigned to Flight');
});

test('activity source and flow filters separate queue, network and SDK without hiding true repeats', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-flow-'));
  const app = await createApp({ port: 0, runsDir: dir, initialCases: [] });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  app.manager.start();
  for (const e of [request('golf', 'G1'), request('flight', 'F1'), request('golf', 'G2')]) app.manager.emit(e);
  const [queue] = queueEvents({ queue: 'InsiderQueue', href: 'https://test.example/vi/golf/checkout', item: { type: 'cart', value: { items: [{ id: 'G1' }], custom: { total: 100 } } } });
  app.manager.emit(queue);
  const [sdk] = queueEvents({ queue: 'InsiderDispatch', href: 'https://test.example/vi/golf/checkout', item: { name: 'Ucd:event:beforeSend', data: { events: [{ event_name: 'cart_page_view', event_params: { c_total: 100, ta: 'golf' } }] } } });
  app.manager.emit(sdk);
  app.manager.emit({ ...request('golf', 'GA'), source: 'GA4', event_name: 'page_view' });
  const get = async query => (await (await fetch(`${base}/api/activity?${query}`)).json()).events;
  const golf = await get('channel=network&source=INSIDER&flow=golf');
  assert.equal(golf.length, 2, 'two genuine Golf sends remain two rows');
  assert.ok(golf.every(e => e.flow_id === 'golf' && e.observation === 'network_request'));
  const flight = await get('channel=network&source=INSIDER&flow=flight');
  assert.equal(flight.length, 1);
  assert.equal(flight[0].json.custom_parameters.product_id, 'F1');
  const queues = await get('channel=queue&source=INSIDER&flow=golf');
  assert.equal(queues.length, 1); assert.equal(queues[0].queue_name, 'InsiderQueue');
  const sdkEvents = await get('channel=sdk&source=INSIDER&flow=golf');
  assert.equal(sdkEvents.length, 1); assert.equal(sdkEvents[0].display_name, 'Cart Page View');
  assert.equal(sdkEvents[0].observation, 'sdk_before_send');
});

test('workbook SDK instructions and parameter requirements are retained separately from actual data', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-notes-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Insider.xlsx');
  const w = new ExcelJS.Workbook(), s = w.addWorksheet('R3107');
  s.addRow(['Luồng', 'Event Name', 'Trigger point trên App', 'Sample Payload (App)', 'Diễn giải param', 'Cách fire (Insider Mobile SDK)']);
  s.addRow(['Flight', 'flight_checkout', 'User confirms checkout', 'Insider.tagEvent("flight_checkout")', 'quantity = total passengers; taxonomy is an array', 'SDK custom event; call build()']);
  await w.xlsx.writeFile(file);
  const c = (await importSpec(file, { sheet: 'R3107' })).cases[0];
  assert.equal(c.description, 'User confirms checkout');
  assert.equal(c.sample_text, 'Insider.tagEvent("flight_checkout")');
  assert.match(c.parameter_notes, /quantity/); assert.match(c.sdk_notes, /build/);
  assert.equal(c.sample_available, false, 'SDK source text is not executed or presented as a captured JSON payload');
});
