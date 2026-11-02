import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { decodeRequest } from '../src/core/decoder.mjs';
import { importSpec, manualCase } from '../src/spec/import.mjs';
import { exportReports } from '../src/report/export.mjs';
import { OpenRouterClient } from '../src/ai/openrouter.mjs';
import { createApp } from '../src/server.mjs';

// An R1511-like sheet and the Insider hits of a web golf flow: listing (taxonomy Golf, no breadcrumb), product page.
async function golfSpec(dir) {
  const file = path.join(dir, 'Martech_AppOTA_Insider.xlsx');
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('R1511');
  sheet.addRow(['Luồng', 'Event Name', 'Mô tả', 'Chi tiết event']);
  sheet.addRow(['Golf', 'search_golf', 'Tìm sân', JSON.stringify({ event: 'Search Golf', default_parameters: {}, custom_parameters: { destination: 'Hải Phòng' } })]);
  sheet.addRow(['Golf', 'listing_page_view', 'Kết quả tìm kiếm', JSON.stringify({ event: 'Listing Page View', default_parameters: { taxonomy: ['golf'] }, custom_parameters: { breadcrumb: ['Golf'] } })]);
  sheet.addRow(['Golf', 'product_detail_page_view', 'Chi tiết sân', JSON.stringify({ event: 'Product Page View', default_parameters: { product_id: 'x', unit_price: 1 }, custom_parameters: { holes: 18 } })]);
  await workbook.xlsx.writeFile(file);
  return (await importSpec(file, { sheet: 'R1511' })).cases;
}
const pageHit = (id, ms, fields) => ({ ...decodeRequest({ url: 'https://hit.api.useinsider.com/hit', body: Buffer.from(JSON.stringify({ event: 'pageView', partner_name: 'votaprod', ...fields })).toString('base64') })[0],
  evidence_id: id, captured_at: new Date(Date.UTC(2026, 10, 2, 9, 0, 0) + ms).toISOString() });
const golfEvents = () => [
  pageHit('EV-LIST', 0, { page_type: 'category', category: ['Golf'], products: [] }),
  pageHit('EV-PDP', 1000, { page_type: 'productDetail', product: { id: 'GOLF-1', name: 'Vinpearl Golf', price: { value: 4500000, currency: 'VND', originalValue: 4500000 }, customAttributes: { holes: 18 } } }),
];
const reportSheet = async file => { const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(file); return workbook.getWorksheet('Báo cáo event'); };
const rowValues = (sheet, index) => Array.from({ length: 8 }, (_, column) => sheet.getRow(index).getCell(column + 1).value ?? '');

test('the report sheet has STT, platform, flow, event, the expected event, the actual event of its platform and a comment on what is complete or missing', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-report-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cases = await golfSpec(dir);
  const paths = await exportReports({ session: { id: 'S', mode: 'cdp' }, cases, events: golfEvents() }, dir);
  const sheet = await reportSheet(paths.xlsx);
  assert.equal(sheet.worksheet ?? sheet.name, 'Báo cáo event');
  assert.deepEqual(rowValues(sheet, 1), ['STT', 'Nền tảng', 'Luồng', 'Tên event', 'Event mong muốn', 'Event thực tế (GA4)', 'Event thực tế (Insider)', 'Nhận xét']);
  const [search, listing, product] = [2, 3, 4].map(index => rowValues(sheet, index));
  assert.deepEqual(search.slice(0, 4), [1, 'Insider', 'Golf', 'search_golf']);
  // An Insider payload: the actual event is in the Insider column, GA4 stays empty.
  assert.deepEqual([search[5], search[6]], ['', 'Chưa thấy event']);
  assert.match(search[7], /^\[Chưa thấy\]/);
  // Listing: the sample next to what Insider received, and what is wrong / missing.
  assert.deepEqual(listing.slice(0, 4), [2, 'Insider', 'Golf', 'listing_page_view']);
  assert.match(listing[4], /"breadcrumb"/);
  assert.equal(listing[5], '');
  assert.match(listing[6], /"event": "Listing Page View"/);
  assert.match(listing[6], /"Golf"/);
  assert.match(listing[7], /^\[Lệch\] Thiếu: custom_parameters\.breadcrumb\. Sai: default_parameters\.taxonomy \(mong đợi \["golf"\], thực tế \["Golf"\]\)/);
  assert.match(product[7], /^\[Đủ\] Đủ các trường đặc tả yêu cầu/);
  assert.equal(sheet.getRow(3).getCell(8).fill.fgColor.argb, 'FEE2E2', 'a mismatch is red');
});

test('in the AI version the comment column is the AI note; a row the AI did not answer keeps the tool comment', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-report-ai-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cases = await golfSpec(dir), listing = cases.find(c => c.rules[0].event_name === 'listing_page_view');
  const paths = await exportReports({ session: { id: 'S', mode: 'cdp-ai' }, cases, events: golfEvents(),
    report_notes: { by: 'AI', model: 'test/free', notes: { [listing.id]: 'Thiếu breadcrumb; taxonomy gửi "Golf" thay vì "golf". Dev website sửa giá trị.' } } }, dir);
  const sheet = await reportSheet(paths.xlsx);
  assert.equal(rowValues(sheet, 1)[7], 'Nhận xét của AI');
  assert.equal(rowValues(sheet, 3)[7], '[Lệch] Thiếu breadcrumb; taxonomy gửi "Golf" thay vì "golf". Dev website sửa giá trị.');
  assert.match(rowValues(sheet, 4)[7], /^\[Đủ\] Đủ các trường/);
});

test('a GA4 payload shows what Google received, ordered like the payload; without a specification each event shows both GA4 and Insider', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-report-columns-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const at = ms => new Date(Date.UTC(2026, 10, 2, 9, 0, 0) + ms).toISOString();
  const ga4 = { ...decodeRequest({ url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST', body: 'en=search_golf&ep.page_type=golf&epn.holes=18&ep.destination=H%E1%BA%A3i%20Ph%C3%B2ng', contentType: 'text/plain' })[0], evidence_id: 'EV-GA4', captured_at: at(0) };
  const insider = { ...decodeRequest({ url: 'https://unification.useinsider.com/api/event/v1/insert', contentType: 'application/json', body: JSON.stringify({ event_name: 'search_golf', event_params: { c_destination: 'Hải Phòng', c_holes: 18 } }) })[0], evidence_id: 'EV-INS', captured_at: at(500) };
  const { testCase } = manualCase({ source: 'GA4', flow: 'Golf', sample: "dataLayer.push({ event: 'search_golf', destination: 'Hải Phòng', holes: 18 })" });
  const withSpec = await reportSheet((await exportReports({ session: { id: 'S' }, cases: [testCase], events: [ga4, insider] }, dir)).xlsx);
  const row = rowValues(withSpec, 2);
  assert.deepEqual(row.slice(0, 4), [1, 'GA4', 'Golf', 'search_golf']);
  assert.deepEqual(Object.keys(JSON.parse(row[5])).slice(0, 3), ['event', 'destination', 'holes'], 'fields in the order of the expected payload');
  assert.equal(row[6], '', 'a GA4 payload: only GA4');
  const noSpec = await reportSheet((await exportReports({ session: { id: 'S' }, events: [ga4, insider] }, path.join(dir, 'nospec'))).xlsx);
  const both = rowValues(noSpec, 2);
  assert.deepEqual(both.slice(0, 5), [1, 'GA4, Insider', '', 'search_golf', '(Chưa nhập file đặc tả)']);
  assert.match(both[5], /"event": "search_golf"/);
  assert.match(both[6], /"event": "Search Golf"/);
  assert.match(both[7], /Google 1 lần, Insider 1 lần/);
});

test('a push-shaped Insider sample in a requests-only session shows what Insider received (not "outside"); GA4 uid is the user_id', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-report-unchecked-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const product = manualCase({ source: 'INSIDER', flow: 'Golf', event_name: 'product_detail_page_view', sample: "InsiderQueue.push({ type: 'product', value: { id: 'GOLF-1', name: 'Vinpearl Golf', price: 4500000 } })" }).testCase;
  const login = manualCase({ source: 'GA4', sample: "dataLayer.push({ event: 'login', method: 'v-id', user_id: '0002296xxxx' })" }, [product]).testCase;
  const [loginHit] = decodeRequest({ url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST', body: 'en=login&ep.method=v-id&uid=0002296123', contentType: 'text/plain' });
  const events = [{ ...golfEvents()[1], evidence_id: 'EV-PDP' }, { ...loginHit, evidence_id: 'EV-LOGIN', captured_at: new Date(Date.UTC(2026, 10, 2, 9, 0, 5)).toISOString() }];
  const sheet = await reportSheet((await exportReports({ session: { id: 'S' }, cases: [product, login], events }, dir)).xlsx);
  const rows = [2, 3, 4].map(index => rowValues(sheet, index)).filter(row => row[3]);
  assert.deepEqual(rows.map(row => row[3]), ['product_detail_page_view', 'login'], 'no "outside" row for the product page Insider received');
  assert.match(rows[0][6], /"event": "Product Page View"/);
  assert.match(rows[0][7], /^\[Đã gửi, chưa so được\] Insider đã nhận event này/);
  assert.match(rows[1][5], /"user_id": "\[REDACTED\]"|"user_id": "0002296123"/);
  assert.match(rows[1][7], /^\[Đủ\]/);
});

const models = { data: { data: [{ id: 'test/model', supported_parameters: ['response_format'], architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0', request: '0' }, context_length: 32768 }] } };
const completion = data => ({ data: { choices: [{ message: { content: JSON.stringify(data) } }] } });
const transport = replies => async () => { const reply = replies.shift(); if (!reply) throw new Error('Unexpected request'); return { ok: true, status: 200, headers: { get: () => null }, json: async () => reply.data }; };
const client = replies => new OpenRouterClient({ enabled: true, apiKey: 'secret-test-key', modelExplain: 'test/model', modelSpec: 'test/model', fetch: transport(replies), maxRetries: 0 });

test('AI report notes answer the rows they were given and reject an unknown row id', async () => {
  const rows = [{ id: 'R1', event: 'listing_page_view', status: 'MISMATCH' }, { id: 'R2', event: 'search_golf', status: 'NOT_SEEN' }];
  // A note repeating the verdict the report already shows ("MISMATCH: …") loses that part.
  const result = await client([models, completion({ notes: [{ id: 'R1', note: 'MISMATCH: Thiếu breadcrumb.' }, { id: 'R2', note: 'Chưa thao tác tới.' }] })]).reportNotes(rows);
  assert.deepEqual([...result.notes], [['R1', 'Thiếu breadcrumb.'], ['R2', 'Chưa thao tác tới.']]);
  assert.equal((await client([models, completion({ notes: [{ id: 'R9', note: 'x' }] })]).reportNotes(rows)).available, false);
  assert.equal((await client([]).reportNotes([])).reason, 'INVALID_AI_INPUT');
});

test('exporting in the AI version asks AI for the comment column of the report sheet', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-report-app-'));
  let asked;
  const stubAI = { diagnostics: () => ({ enabled: true, configured_key_count: 1 }), close() {},
    async reportNotes(rows) { asked = rows; return { available: true, routing: { model: 'stub/free' }, notes: new Map(rows.map(row => [row.id, `AI: ${row.event} ${row.status}`])) }; } };
  const app = await createApp({ mode: 'cdp-ai', runsDir: dir, port: 0, aiClient: stubAI, initialCases: await golfSpec(dir) });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  app.manager.start({ environment: 'MOCK_ONLY' });
  for (const { evidence_id, ...event } of golfEvents()) app.manager.emit(event);
  const response = await fetch(`${base}/api/export`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': app.csrf }, body: '{}' });
  assert.equal(response.status, 200);
  assert.deepEqual(asked.map(row => [row.id, row.event, row.status]), [['R1', 'search_golf', 'NOT_SEEN'], ['R2', 'listing_page_view', 'MISMATCH'], ['R3', 'product_detail_page_view', 'MATCH']]);
  assert.ok(asked[1].issues.some(issue => issue.code === 'MISSING_FIELD' && issue.field === 'custom_parameters.breadcrumb'));
  const sheet = await reportSheet(path.join(app.manager.runDir, 'report.xlsx'));
  assert.equal(rowValues(sheet, 1)[7], 'Nhận xét của AI');
  assert.equal(rowValues(sheet, 3)[7], '[Lệch] AI: listing_page_view MISMATCH');
});
