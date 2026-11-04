import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { createApp } from '../src/server.mjs';
import { decodeRequest } from '../src/core/decoder.mjs';
import { apiCallRecord } from '../src/core/api-log.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-inspection-')); let aiCalls = 0;
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  const app = await createApp({ mode: 'cdp-ai', port: 0, runsDir: dir, initialCases: [], aiClient: { diagnostics: () => ({ enabled: true, configured_key_count: 1 }), close() {}, reportNotes() { aiCalls++; throw Error('Unexpected AI'); } } });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  app.manager.start({ capture_queues: true });
  const now = Date.now(), page = { target_id: 'TAB', url: 'https://example.test/cart' };
  const call = app.manager.emitApiCall(apiCallRecord({ request: { method: 'POST', url: 'https://api.example.test/orders', headers: { 'content-type': 'application/json', authorization: 'PRIVATE_TOKEN' } },
    response: { status: 200, mimeType: 'application/json' }, page, startedAt: new Date(now - 200).toISOString(), finishedAt: new Date(now - 100).toISOString(),
    requestBody: JSON.stringify({ product_id: 'ROOM-1' }), responseBody: JSON.stringify({ data: { id: 'ROOM-1', price: 600000 }, email: 'secret@example.test', detail: 'LONG_BODY_'.repeat(5000), unicode: 'a'.repeat(30999) + '🏨 phòng', formula: '=HYPERLINK("https://example.test")' }) }));
  const wrapper = { schema: 'iglu:com.snowplowanalytics.snowplow/unstruct_event/jsonschema/1-0-0', data: { schema: 'iglu:example/purchase/jsonschema/1-0-0', data: { product_id: 'ROOM-1', price: '500000' } } };
  const [decoded] = decodeRequest({ url: 'https://api.example.test/tp2', body: JSON.stringify({ data: [{ e: 'ue', ue_px: Buffer.from(JSON.stringify(wrapper)).toString('base64'), dtm: now }] }), requestId: 'REQ-TP2', capturedAt: new Date(now).toISOString() });
  const event = app.manager.emit({ ...decoded, page });
  app.manager.emit({ ...decoded, page, network: { ...decoded.network, phase: 'response', status: 204 } });
  const post = async (route, data) => { const response = await fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': app.csrf }, body: JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
  return { app, base, event, call, post, aiCalls: () => aiCalls };
}
const mapping = { name: 'Giá đơn hàng', event_name: 'purchase', api_pattern: '/orders', event_id_path: 'product_id', api_id_path: 'data.id', fields: [{ event_path: 'price', api_path: 'data.price', type: 'number' }] };

test('finish without export closes the session immediately, preserves evidence and creates no report files', async t => {
  const { app, post } = await fixture(t);
  const response = await post('finish', { exportReport: false });
  assert.equal(response.status, 200); assert.equal(response.body.running, false); assert.equal(response.body.exported, null);
  const names = await fs.readdir(app.manager.runDir);
  for (const name of ['report.xlsx', 'report.html', 'comparison.json', 'bugs.md']) assert.ok(!names.includes(name));
  assert.ok(names.includes('events.jsonl') && names.includes('api-calls.jsonl'));
  assert.equal(app.manager.snapshot().events.length, 2);
});

test('API-only HTML export creates exactly one readable offline file with complete captured bodies and no AI calls', async t => {
  const { app, post, aiCalls } = await fixture(t); await post('finish', { exportReport: false });
  const response = await post('export', { aiNotes: true, selection: { contents: ['api'], formats: ['html'], htmlSettings: { fontSize: 16 } } });
  assert.equal(response.status, 200); assert.deepEqual(Object.keys(response.body.exported), ['api_html']); assert.equal(aiCalls(), 0);
  const html = await fs.readFile(path.join(app.manager.runDir, 'api-report.html'), 'utf8');
  assert.ok(html.includes('Request body') && html.includes('Response body') && html.includes('LONG_BODY_'.repeat(5000)));
  assert.ok(!html.includes('PRIVATE_TOKEN') && !html.includes('secret@example.test'));
  assert.ok(html.includes('rowsPerPage') && html.includes('id="search"'));
  assert.ok(!(await fs.readdir(app.manager.runDir)).includes('report.xlsx'));
});

test('TP2 tab exposes one request event, correlates response status and compares persisted field mappings', async t => {
  const { app, base, event, post } = await fixture(t);
  let state = await (await fetch(`${base}/api/tp2`)).json();
  assert.equal(state.total, 1); assert.equal(state.events[0].http_status, 204); assert.equal(state.events[0].status, 'NO_MAPPING');
  const saved = await post('tp2/mapping', { mapping }); assert.equal(saved.status, 200);
  state = await (await fetch(`${base}/api/tp2`)).json();
  assert.equal(state.events[0].status, 'MISMATCH'); assert.equal(state.events[0].comparisons[0].expected, 600000);
  const detail = await (await fetch(`${base}/api/tp2/detail?id=${event.evidence_id}`)).json();
  assert.equal(detail.event.payload.product_id, 'ROOM-1'); assert.ok(detail.api.response.body.json.detail);
  await post('finish', { exportReport: false });
  const output = await post('export', { selection: { contents: ['tp2'], formats: ['json'] } });
  assert.deepEqual(Object.keys(output.body.exported), ['tp2_json']);
  const report = JSON.parse(await fs.readFile(path.join(app.manager.runDir, 'tp2-report.json'), 'utf8'));
  assert.equal(report.events.length, 1); assert.equal(report.comparisons[0].status, 'MISMATCH');
});

test('invalid export choices are rejected before ending a live session', async t => {
  const { app, post } = await fixture(t);
  const response = await post('finish', { selection: { contents: ['../../secret'], formats: ['html'] } });
  assert.equal(response.status, 400); assert.equal(app.manager.session.status, 'RUNNING');
});

test('ending an active manual step preserves an interrupted REVIEW without generating reports or AI notes', async t => {
  const { app, post, aiCalls } = await fixture(t);
  app.manager.cases.push({ id: 'ACTIVE', name: 'Active case', source: 'GA4', flow: 'Demo', rules: [{ event_name: 'purchase', layer: 'TRACKING_REQUEST', fields: {} }] });
  const step = app.manager.startStep('ACTIVE');
  assert.equal((await post('finish', { exportReport: false })).status, 200);
  assert.equal(app.manager.currentStep, null); assert.equal(app.manager.session.status, 'INTERRUPTED');
  assert.equal(app.manager.snapshot().results.find(result => result.step_id === step.id)?.verdict, 'REVIEW');
  assert.equal(aiCalls(), 0); assert.ok(!(await fs.readdir(app.manager.runDir)).includes('report.html'));
});

test('API-only Excel preserves long response values across cells; JSON preserves captured request and response', async t => {
  const { app, post } = await fixture(t); await post('finish', { exportReport: false });
  const response = await post('export', { selection: { contents: ['api'], formats: ['xlsx'] } });
  assert.deepEqual(Object.keys(response.body.exported), ['api_xlsx']);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path.join(app.manager.runDir, 'api-report.xlsx'));
  const parts = [], unicode = [];
  workbook.getWorksheet('Chi tiết đầy đủ').eachRow((row, index) => {
    if (index > 1 && row.getCell(2).value === 'Response body.detail') parts.push(row.getCell(4).value);
    if (index > 1 && row.getCell(2).value === 'Response body.unicode') unicode.push(row.getCell(4).value);
    if (index > 1 && row.getCell(2).value === 'Response body.formula') assert.equal(row.getCell(4).value, '\'=HYPERLINK("https://example.test")');
  });
  assert.equal(parts.join(''), 'LONG_BODY_'.repeat(5000));
  assert.equal(unicode.join(''), 'a'.repeat(30999) + '🏨 phòng');
  assert.equal(workbook.worksheets[0].getRow(2).getCell(1).value, 1);
  assert.ok(!(await fs.readdir(app.manager.runDir)).includes('report.xlsx'));
  const exported = await post('export', { selection: { contents: ['api'], formats: ['json'] } });
  assert.deepEqual(Object.keys(exported.body.exported), ['api_json']);
  const json = JSON.parse(await fs.readFile(path.join(app.manager.runDir, 'api-report.json'), 'utf8'));
  assert.equal(json.api_calls[0].request.body.json.product_id, 'ROOM-1');
  assert.equal(json.api_calls[0].response.body.json.data.price, 600000);
});
