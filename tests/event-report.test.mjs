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
// A cell compared line by line holds rich text: read as its text.
const cellValue = cell => cell.value && typeof cell.value === 'object' && Array.isArray(cell.value.richText) ? cell.value.richText.map(part => part.text).join('') : cell.value ?? '';
const rowValues = (sheet, index) => Array.from({ length: 9 }, (_, column) => cellValue(sheet.getRow(index).getCell(column + 1)));

test('the report sheet lists every event fired in time order, with the expected event, the actual event of its platform and a comment, then the expected events not seen', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-report-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cases = await golfSpec(dir);
  const paths = await exportReports({ session: { id: 'S', mode: 'cdp' }, cases, events: golfEvents() }, dir);
  const sheet = await reportSheet(paths.xlsx);
  assert.equal(sheet.worksheet ?? sheet.name, 'Báo cáo event');
  assert.deepEqual(rowValues(sheet, 1), ['STT', 'Thời điểm', 'Nền tảng', 'Luồng', 'Tên event', 'Event mong muốn', 'Event thực tế (GA4)', 'Event thực tế (Insider)', 'Nhận xét']);
  const [listing, product, search] = [2, 3, 4].map(index => rowValues(sheet, index));
  // Listing: when it fired (Vietnam time), the sample next to what Insider received, and what is wrong / missing.
  assert.deepEqual(listing.slice(0, 5), [1, '02/11/2026 16:00:00', 'Insider', 'Golf', 'listing_page_view']);
  assert.match(listing[5], /"breadcrumb"/);
  assert.equal(listing[6], '');
  assert.match(listing[7], /"event": "Listing Page View"/);
  assert.match(listing[7], /"Golf"/);
  // Which side lacks what, in words: the actual event lacks the breadcrumb; the taxonomy is wrong.
  assert.match(listing[8], /^\[Lệch\] Event thực tế thiếu \(đặc tả có\): custom_parameters\.breadcrumb = \["Golf"\]\. Sai so với đặc tả: default_parameters\.taxonomy \(đặc tả \["golf"\], thực tế \["Golf"\]\)/);
  // Line against line: the differing and missing lines marked, the cells yellow.
  const listingRow = sheet.getRow(2), runs = cell => cell.value.richText;
  const expectedRuns = runs(listingRow.getCell(6)), actualRuns = runs(listingRow.getCell(8));
  assert.ok(expectedRuns.some(run => /"breadcrumb"/.test(run.text) && run.font.color.argb === 'B91C1C'), 'the field the actual event lacks is red on the expected side');
  assert.ok(actualRuns.some(run => /"breadcrumb": \(thiếu\)/.test(run.text) && run.font.bold), 'and said missing on the actual side');
  assert.ok(actualRuns.some(run => /"taxonomy"/.test(run.text) && run.font.color.argb === 'B91C1C'), 'a wrong value is red');
  assert.ok(actualRuns.some(run => /"event": "Listing Page View"/.test(run.text) && !run.font.bold), 'a line the same on both sides stays plain');
  assert.equal(listingRow.getCell(6).fill.fgColor.argb, 'FFF3B0');
  assert.equal(listingRow.getCell(8).fill.fgColor.argb, 'FFF3B0');
  assert.deepEqual(product.slice(0, 5), [2, '02/11/2026 16:00:01', 'Insider', 'Golf', 'product_detail_page_view']);
  assert.match(product[8], /^\[Đủ\] Đủ các trường đặc tả yêu cầu/);
  // Expected but never fired: after the events, in the column of its platform.
  assert.deepEqual(search.slice(0, 5), [3, '', 'Insider', 'Golf', 'search_golf']);
  assert.deepEqual([search[6], search[7]], ['', 'Chưa thấy event']);
  assert.match(search[8], /^\[Chưa thấy\]/);
  assert.equal(sheet.getRow(2).getCell(9).fill.fgColor.argb, 'FEE2E2', 'a mismatch is red');
});

test('every occurrence of an event is its own row, not only the latest one', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-report-all-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cases = await golfSpec(dir);
  const again = pageHit('EV-LIST-2', 60000, { page_type: 'category', category: ['golf'], products: [], breadcrumb: ['Golf'] });
  const sheet = await reportSheet((await exportReports({ session: { id: 'S' }, cases, events: [...golfEvents(), again] }, dir)).xlsx);
  const rows = [2, 3, 4, 5].map(index => rowValues(sheet, index));
  assert.deepEqual(rows.map(row => [row[0], row[1], row[4], row[8].match(/^\[([^\]]+)\]/)[1]]), [
    [1, '02/11/2026 16:00:00', 'listing_page_view', 'Lệch'], [2, '02/11/2026 16:00:01', 'product_detail_page_view', 'Đủ'],
    [3, '02/11/2026 16:01:00', 'listing_page_view', 'Đủ'], [4, '', 'search_golf', 'Chưa thấy']]);
});

test('an app event read from Insider Test Lab is reported as the app event, with the parameters Insider failed', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-report-app-event-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cases = await golfSpec(dir);
  // As the reader records it: the table's text, with each parameter's key and Insider's type beside it.
  const app = { evidence_id: 'EV-APP', source: 'INSIDER', layer: 'TEST_LAB', event_name: 'listing_page_view', event_kind: 'business', captured_at: new Date(Date.UTC(2026, 10, 2, 9, 5, 0)).toISOString(),
    page: { url: 'https://mobile.useinsider.com/test_lab' }, payload: { event: 'Listing Page View', default_parameters: { Taxonomy: 'golf' }, custom_parameters: { Breadcrumb: 'Golf', Holes: 'x' } },
    testlab: { receipt: '3', status: 'failed', complete: true, params: [
      { name: 'Taxonomy', key: 'ta', field: 'default_parameters.taxonomy', value: 'golf', status: 'successful', data_type: 'array' },
      { name: 'Breadcrumb', key: 'c_breadcrumb', field: 'custom_parameters.breadcrumb', value: 'Golf', status: 'successful', data_type: 'array' },
      { name: 'Holes', key: 'c_holes', field: 'custom_parameters.holes', value: 'x', status: 'failed', data_type: 'number', failed_detail: { ios: { expected_type: 'number', observed_type: 'string' } } }] } };
  const paths = await exportReports({ session: { id: 'S' }, cases, events: [app] }, dir);
  const row = rowValues(await reportSheet(paths.xlsx), 2);
  assert.deepEqual(row.slice(0, 5), [1, '02/11/2026 16:05:00', 'Insider (app)', 'Golf', 'listing_page_view']);
  assert.match(row[7], /"event": "Listing Page View"/);
  assert.match(row[7], /"Taxonomy": "golf"/, 'the actual event as Test Lab shows it');
  assert.match(row[8], /^\[Đủ\].*Insider Test Lab báo thất bại: custom_parameters\.holes \(Insider mong đợi number, app gửi string\)/);
});

test('in the AI version the comment column is the AI note; a row the AI did not answer keeps the tool comment', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-report-ai-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cases = await golfSpec(dir), listing = cases.find(c => c.rules[0].event_name === 'listing_page_view');
  const paths = await exportReports({ session: { id: 'S', mode: 'cdp-ai' }, cases, events: golfEvents(),
    report_notes: { by: 'AI', model: 'test/free', notes: { 'ev|EV-LIST': 'Thiếu breadcrumb; taxonomy gửi "Golf" thay vì "golf". Dev website sửa giá trị.' } } }, dir);
  assert.ok(listing);
  const sheet = await reportSheet(paths.xlsx);
  assert.equal(rowValues(sheet, 1)[8], 'Nhận xét của AI');
  assert.equal(rowValues(sheet, 2)[8], '[Lệch] Thiếu breadcrumb; taxonomy gửi "Golf" thay vì "golf". Dev website sửa giá trị.');
  assert.match(rowValues(sheet, 3)[8], /^\[Đủ\] Đủ các trường/);
});

test('a GA4 payload shows what Google received, ordered like the payload; each vendor\'s event is its own row', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-report-columns-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const at = ms => new Date(Date.UTC(2026, 10, 2, 9, 0, 0) + ms).toISOString();
  const ga4 = { ...decodeRequest({ url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST', body: 'en=search_golf&ep.page_type=golf&epn.holes=18&ep.destination=H%E1%BA%A3i%20Ph%C3%B2ng', contentType: 'text/plain' })[0], evidence_id: 'EV-GA4', captured_at: at(0) };
  const insider = { ...decodeRequest({ url: 'https://unification.useinsider.com/api/event/v1/insert', contentType: 'application/json', body: JSON.stringify({ event_name: 'search_golf', event_params: { c_destination: 'Hải Phòng', c_holes: 18 } }) })[0], evidence_id: 'EV-INS', captured_at: at(500) };
  const { testCase } = manualCase({ source: 'GA4', flow: 'Golf', sample: "dataLayer.push({ event: 'search_golf', destination: 'Hải Phòng', holes: 18 })" });
  const withSpec = await reportSheet((await exportReports({ session: { id: 'S' }, cases: [testCase], events: [ga4, insider] }, dir)).xlsx);
  const row = rowValues(withSpec, 2);
  assert.deepEqual(row.slice(0, 5), [1, '02/11/2026 16:00:00', 'GA4', 'Golf', 'search_golf']);
  assert.deepEqual(Object.keys(JSON.parse(row[6])).slice(0, 3), ['event', 'destination', 'holes'], 'fields in the order of the expected payload');
  assert.equal(row[7], '', 'a GA4 event: only GA4');
  const other = rowValues(withSpec, 3);
  assert.deepEqual(other.slice(2, 6), ['Insider', '', 'search_golf', '(File đặc tả không gồm event Insider)']);
  assert.match(other[8], /Đã gửi lên Insider; file đặc tả không gồm event Insider/);
  const noSpec = await reportSheet((await exportReports({ session: { id: 'S' }, events: [ga4, insider] }, path.join(dir, 'nospec'))).xlsx);
  const [google, insiderRow] = [2, 3].map(index => rowValues(noSpec, index));
  assert.deepEqual(google.slice(0, 6), [1, '02/11/2026 16:00:00', 'GA4', '', 'search_golf', '(Chưa nhập file đặc tả)']);
  assert.match(google[6], /"event": "search_golf"/);
  assert.match(google[8], /Đã gửi lên Google; chưa có file đặc tả để so/);
  assert.deepEqual(insiderRow.slice(0, 5), [2, '02/11/2026 16:00:00', 'Insider', '', 'search_golf']);
  assert.match(insiderRow[7], /"event": "Search Golf"/);
});

test('a push-shaped Insider sample in a requests-only session shows what Insider received (not "outside"); GA4 uid is the user_id', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-report-unchecked-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const product = manualCase({ source: 'INSIDER', flow: 'Golf', event_name: 'product_detail_page_view', sample: "InsiderQueue.push({ type: 'product', value: { id: 'GOLF-1', name: 'Vinpearl Golf', price: 4500000 } })" }).testCase;
  const login = manualCase({ source: 'GA4', sample: "dataLayer.push({ event: 'login', method: 'v-id', user_id: '0002296xxxx' })" }, [product]).testCase;
  const [loginHit] = decodeRequest({ url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST', body: 'en=login&ep.method=v-id&uid=0002296123', contentType: 'text/plain' });
  const events = [{ ...golfEvents()[1], evidence_id: 'EV-PDP' }, { ...loginHit, evidence_id: 'EV-LOGIN', captured_at: new Date(Date.UTC(2026, 10, 2, 9, 0, 5)).toISOString() }];
  const sheet = await reportSheet((await exportReports({ session: { id: 'S' }, cases: [product, login], events }, dir)).xlsx);
  const rows = [2, 3, 4].map(index => rowValues(sheet, index)).filter(row => row[4]);
  assert.deepEqual(rows.map(row => row[4]), ['product_detail_page_view', 'login'], 'no "outside" row for the product page Insider received');
  assert.match(rows[0][7], /"event": "Product Page View"/);
  assert.match(rows[0][8], /^\[Đã gửi, chưa so được\] Insider đã nhận event này/);
  assert.match(rows[1][6], /"user_id": "\[REDACTED\]"|"user_id": "0002296123"/);
  assert.match(rows[1][8], /^\[Đủ\]/);
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
  let asked, calls = 0;
  const stubAI = { diagnostics: () => ({ enabled: true, configured_key_count: 1 }), close() {},
    async reportNotes(rows) { calls++; asked = rows; return { available: true, routing: { model: 'stub/free' }, notes: new Map(rows.map(row => [row.id, `AI: ${row.event} ${row.status}`])) }; } };
  const app = await createApp({ mode: 'cdp-ai', runsDir: dir, port: 0, aiClient: stubAI, initialCases: await golfSpec(dir) });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  app.manager.start({ environment: 'MOCK_ONLY' });
  for (const { evidence_id, ...event } of golfEvents()) app.manager.emit(event);
  const response = await fetch(`${base}/api/export`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': app.csrf }, body: '{}' });
  assert.equal(response.status, 200);
  // Rows with a problem go to the AI first.
  assert.deepEqual(asked.map(row => [row.id, row.event, row.status]), [['R1', 'listing_page_view', 'MISMATCH'], ['R3', 'search_golf', 'NOT_SEEN'], ['R2', 'product_detail_page_view', 'MATCH']]);
  assert.ok(asked[0].issues.some(issue => issue.code === 'MISSING_FIELD' && issue.field === 'custom_parameters.breadcrumb'));
  const sheet = await reportSheet(path.join(app.manager.runDir, 'report.xlsx'));
  assert.equal(rowValues(sheet, 1)[8], 'Nhận xét của AI');
  assert.equal(rowValues(sheet, 2)[8], '[Lệch] AI: listing_page_view MISMATCH');
  const post = () => fetch(`${base}/api/export`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': app.csrf }, body: '{}' });
  const repeated = await post();
  assert.equal(repeated.status, 200); await repeated.arrayBuffer();
  assert.equal(calls, 1, 'An unchanged report reuses accepted AI notes instead of another paid request');
  app.manager.cases = structuredClone(app.manager.cases);
  const listing = app.manager.cases.find(testCase => testCase.rules[0].event_name === 'listing_page_view');
  const taxonomy = listing.rules[0].fields['default_parameters.taxonomy'];
  taxonomy.value = ['Golf'];
  const changed = await post();
  assert.equal(changed.status, 200); await changed.arrayBuffer();
  assert.equal(calls, 2, 'Changing a rule invalidates notes even when the event count is unchanged');
  assert.ok(!asked.find(row => row.event === 'listing_page_view').issues.some(issue => issue.field === 'default_parameters.taxonomy'));
});

test('report AI uses at most two concurrent batches and retries unavailable notes on a later export', { timeout: 10000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-report-batches-'));
  let calls = 0, active = 0, peak = 0, unavailable = true;
  const stubAI = { diagnostics: () => ({ enabled: true, configured_key_count: 1 }), close() {},
    async reportNotes(rows) {
      calls++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 10)); active--;
      if (unavailable) return { available: false, reason: 'TEST_UNAVAILABLE' };
      return { available: true, notes: new Map(rows.map(row => [row.id, `AI: ${row.event}`])) };
    } };
  const app = await createApp({ mode: 'cdp-ai', runsDir: dir, port: 0, aiClient: stubAI, initialCases: [] });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  app.manager.start({ environment: 'MOCK_ONLY' });
  for (let index = 0; index < 45; index++) app.manager.emit({ source: 'GA4', layer: 'TRACKING_REQUEST', event_name: `report_event_${index}`, payload: { event: `report_event_${index}` }, network: { phase: 'request' } });
  const post = async () => {
    const response = await fetch(`${base}/api/export`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': app.csrf }, body: '{}' });
    assert.equal(response.status, 200, await response.text());
  };
  await post();
  assert.equal(calls, 2, 'Stop scheduling later batches after unavailability');
  assert.equal(rowValues(await reportSheet(path.join(app.manager.runDir, 'report.xlsx')), 1)[8], 'Nhận xét');
  unavailable = false;
  await post();
  assert.equal(calls, 5, 'A temporary failure must not cache unavailable notes');
  assert.equal(peak, 2);
  await post();
  assert.equal(calls, 5, 'All successful batches are reused for the same report');
  assert.equal((await reportSheet(path.join(app.manager.runDir, 'report.xlsx'))).rowCount, 46);
});

test('finish keeps automatic AI notes, and aiNotes false skips AI on either export route', { timeout: 10000 }, async t => {
  for (const [route, aiNotes] of [['finish', true], ['export', false], ['finish', false]]) await t.test(`${route} aiNotes=${aiNotes}`, async subtest => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-report-choice-'));
    let calls = 0;
    const stubAI = { diagnostics: () => ({ enabled: true, configured_key_count: 1 }), close() {},
      async reportNotes(rows) { calls++; return { available: true, notes: new Map(rows.map(row => [row.id, 'AI note'])) }; } };
    const app = await createApp({ mode: 'cdp-ai', runsDir: dir, port: 0, aiClient: stubAI, initialCases: [] });
    const base = await app.listen();
    subtest.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
    app.manager.start({ environment: 'MOCK_ONLY' });
    app.manager.emit({ source: 'GA4', layer: 'TRACKING_REQUEST', event_name: 'choice_event', payload: { event: 'choice_event' }, network: { phase: 'request' } });
    const response = await fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': app.csrf }, body: JSON.stringify(aiNotes ? {} : { aiNotes: false }) });
    assert.equal(response.status, 200, await response.text());
    assert.equal(calls, aiNotes ? 1 : 0);
    const sheet = await reportSheet(path.join(app.manager.runDir, 'report.xlsx'));
    assert.equal(rowValues(sheet, 1)[8], aiNotes ? 'Nhận xét của AI' : 'Nhận xét');
    assert.equal(rowValues(sheet, 2)[4], 'choice_event');
    if (!aiNotes) assert.doesNotMatch(rowValues(sheet, 2)[8], /AI note/);
    if (route === 'finish') assert.equal(app.manager.session.status, 'COMPLETED');
  });
});

test('the Insider export is a file of its own with every Insider event, from the website and from the app', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-report-insider-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cases = await golfSpec(dir);
  const ga4 = { ...decodeRequest({ url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST', body: 'en=search_golf', contentType: 'text/plain' })[0], evidence_id: 'EV-GA4', captured_at: new Date(Date.UTC(2026, 10, 2, 9, 0, 3)).toISOString() };
  const app = { evidence_id: 'EV-APP', source: 'INSIDER', layer: 'TEST_LAB', event_name: 'product_detail_page_view', event_kind: 'business', captured_at: new Date(Date.UTC(2026, 10, 2, 9, 5, 0)).toISOString(),
    payload: { event: 'Product Page View', default_parameters: { 'Product ID': 'x', 'Unit Price': '1' }, custom_parameters: { Holes: '18' } }, testlab: { receipt: '4', status: 'successful', complete: true, params: [
      { name: 'Product ID', key: 'pid', field: 'default_parameters.product_id', value: 'x', status: 'successful', data_type: 'string' },
      { name: 'Unit Price', key: 'up', field: 'default_parameters.unit_price', value: '1', status: 'successful', data_type: 'number' },
      { name: 'Holes', key: 'c_holes', field: 'custom_parameters.holes', value: '18', status: 'successful', data_type: 'number' }] } };
  const { exportSelection } = await import('../src/report/selection.mjs');
  const files = await exportSelection({ session: { id: 'S' }, cases, events: [...golfEvents(), ga4, app], steps: [], results: [] }, dir, { contents: ['insider'], formats: ['xlsx', 'json', 'html'] });
  assert.deepEqual(Object.keys(files).sort(), ['insider_html', 'insider_json', 'insider_xlsx']);
  const data = JSON.parse(await fs.readFile(files.insider_json, 'utf8'));
  assert.deepEqual(data.report.map(row => [row.origin, row.event_name, row.status]), [['Website', 'listing_page_view', 'MISMATCH'], ['Website', 'product_detail_page_view', 'MATCH'],
    ['App · Insider Test Lab', 'product_detail_page_view', 'MATCH'], ['', 'search_golf', 'NOT_SEEN']]);
  assert.ok(data.events.every(event => event.source === 'INSIDER'), 'no GA4 event in the Insider report');
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(files.insider_xlsx);
  assert.equal(workbook.worksheets[0].name, 'Báo cáo Insider');
  assert.equal(workbook.worksheets[0].rowCount, 5);
  assert.match(await fs.readFile(files.insider_html, 'utf8'), /App · Insider Test Lab/);
});

test('the sample and the actual event are compared field by field: same kept, different yellow, missing said on the side that lacks it', async () => {
  const { payloadDiff, diffSentences } = await import('../src/core/payload-diff.mjs');
  const expected = { event: 'add_to_cart', currency: 'VND', value: 100, items: [{ item_id: 'A', price: 100 }], coupon: 'X' };
  const actual = { event: 'add_to_cart', currency: 'USD', value: 250, items: [{ item_id: 'B', price: 250, quantity: 1 }], affiliation: 'web' };
  const fields = { event: { op: 'eq', value: 'add_to_cart' }, currency: { op: 'eq', value: 'VND' }, value: { op: 'type', value: 'integer' }, 'items.0.item_id': { op: 'type', value: 'string' },
    'items.0.price': { op: 'type', value: 'integer' }, coupon: { op: 'type', value: 'string', optional: true } };
  const diff = payloadDiff(expected, actual, { fields, issues: [{ path: 'currency', code: 'VALUE_MISMATCH', expected: 'VND', actual: 'USD', verdict: 'FAIL' }] });
  const marks = side => Object.fromEntries(diff.rows.filter(row => row[side].mark).map(row => [row[side].text.trim(), row[side].mark]));
  assert.deepEqual(marks('expected'), { '"currency": "VND",': 'wrong', '"value": 100,': 'different', '"item_id": "A",': 'different', '"price": 100,': 'different', '"coupon": "X"': 'optional', '"quantity": (đặc tả không có)': 'extra', '"affiliation": (đặc tả không có)': 'extra' });
  assert.deepEqual(marks('actual'), { '"currency": "USD",': 'wrong', '"value": 250,': 'different', '"item_id": "B",': 'different', '"price": 250,': 'different', '"coupon": (thiếu)': 'optional', '"quantity": 1': 'extra', '"affiliation": "web"': 'extra' });
  assert.equal(diff.rows[1].expected.mark, null, 'the event name, the same on both sides, is not marked');
  assert.equal(diff.rows.length, new Set(diff.rows.map((_, index) => index)).size);
  assert.deepEqual(diffSentences(diff), [
    'Sai so với đặc tả: currency (đặc tả "VND", thực tế "USD").',
    'Đặc tả không có (event thực tế có gửi): items.0.quantity = 1; affiliation = "web".',
    'Thực tế không có, đặc tả không bắt buộc: coupon.',
    'Khác giá trị mẫu nhưng đúng đặc tả (giá trị thay đổi theo thao tác): value; items.0.item_id; items.0.price.']);
  // A required field the actual event lacks.
  const missing = payloadDiff({ event: 'x', page_type: 'golf' }, { event: 'x' }, { fields: { page_type: { op: 'type', value: 'string' } } });
  assert.deepEqual(diffSentences(missing), ['Event thực tế thiếu (đặc tả có): page_type = "golf".']);
  assert.deepEqual(missing.rows.find(row => /page_type/.test(row.actual.text)).actual, { text: '  "page_type": (thiếu)', mark: 'missing' });
});

test('the HTML report draws the compared cells line by line with the differing lines marked', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-report-html-diff-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const paths = await exportReports({ session: { id: 'S' }, cases: await golfSpec(dir), events: golfEvents() }, dir, { formats: ['html'] });
  const html = await fs.readFile(paths.html, 'utf8');
  const data = JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  const listing = data.sections.find(section => section.id === 'events').rows.find(row => row.event_name === 'listing_page_view');
  assert.ok(listing.diff.expected.some(line => line.mark === 'missing' && /breadcrumb/.test(line.text)));
  assert.ok(listing.diff.actual_insider.some(line => line.mark === 'missing' && /"breadcrumb": \(thiếu\)/.test(line.text)));
  assert.match(html, /mark-wrong\{background:#fff3b0/);
  assert.match(html, /id="legend"/);
});
