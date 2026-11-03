import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import { CDPCollector } from '../src/collectors/cdp.mjs';
import { matchesApiLog, apiLogPatterns, allowedHeaders, storedBody, apiCallRecord, bodyText, DEFAULT_API_LOG_PATTERNS } from '../src/core/api-log.mjs';
import { SessionManager, loadRun } from '../src/core/session.mjs';
import { EvidenceStore } from '../src/core/store.mjs';
import { exportReports } from '../src/report/export.mjs';
import { createApp } from '../src/server.mjs';

async function mockCDP(onCommand) {
  const sockets = new Set();
  let peer, port;
  const server = createServer((request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify([{ id: 'tab1', type: 'page', url: 'https://example.test/', title: 'Test', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/tab1` }])); });
  function send(message) {
    const payload = Buffer.from(JSON.stringify(message));
    const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
    peer.write(Buffer.concat([header, payload]));
  }
  server.on('upgrade', (request, socket) => {
    peer = socket; sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15;
        let length = buffer[1] & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        const masked = buffer[1] & 128;
        if (buffer.length < offset + (masked ? 4 : 0) + length) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        offset += masked ? 4 : 0;
        const body = Buffer.from(buffer.subarray(offset, offset + length));
        buffer = buffer.subarray(offset + length);
        if (mask) for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4];
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const command = JSON.parse(body.toString());
        if (onCommand) onCommand(command, send);
        else send({ id: command.id, result: {} });
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening'); port = server.address().port;
  return { port, send, url: `ws://127.0.0.1:${port}/devtools/page/tab1`, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eventqa-apilog-'));

test('API log hosts: UAT and PROD API of vinpearlota.com by host + path, never by query', () => {
  assert.equal(matchesApiLog('https://api.uat.vinpearlota.com/api/v1/hotel/bookable?x=1'), true);
  assert.equal(matchesApiLog('https://api.vinpearlota.com/api/v2/shopping-cart'), true);
  assert.equal(matchesApiLog('https://dplatform-web.uat.vinpearlota.com/vi/hotel'), false, 'the website pages are not API calls');
  assert.equal(matchesApiLog('https://www.google-analytics.com/g/collect?dl=https://api.vinpearlota.com/'), false);
  assert.equal(matchesApiLog('https://evil-api.vinpearlota.com.example/x'), false);
  assert.deepEqual(apiLogPatterns([]), DEFAULT_API_LOG_PATTERNS);
  assert.deepEqual(apiLogPatterns(['^api\\.staging\\.test/']), ['^api\\.staging\\.test/']);
  assert.throws(() => apiLogPatterns(['(']), /không hợp lệ/);
});

test('API log records keep bodies but mask credentials and personal data', () => {
  assert.deepEqual(allowedHeaders({ Authorization: 'Bearer abc', Cookie: 'a=b', 'Content-Type': 'application/json', 'X-Access-Token': 't', 'Accept-Language': 'vi' }), { 'content-type': 'application/json', 'accept-language': 'vi' });
  const body = storedBody(JSON.stringify({ data: { contact: { email: 'a@b.vn', phone: '0912345678', firstName: 'Hùng', surname: 'Trần', passportNumber: 'B123' }, accessToken: 'secret', ancillaries: [{ id: 'A1', name: 'Bữa tối buffet', price: 678993 }] } }), { mimeType: 'application/json' });
  const text = JSON.stringify(body.json);
  for (const secret of ['a@b.vn', '0912345678', 'Hùng', 'Trần', 'B123', 'secret']) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(body.json.data.ancillaries, [{ id: 'A1', name: 'Bữa tối buffet', price: 678993 }], 'business data is kept whole');
  const cut = storedBody('x'.repeat(50), { limit: 10 });
  assert.equal(cut.truncated, true); assert.equal(cut.size, 50);
  assert.deepEqual(storedBody('promotionCode=KT002&amount=1000', { mimeType: 'application/x-www-form-urlencoded' }).form, { promotionCode: 'KT002', amount: '1000' });
  assert.equal(storedBody('PNG', { mimeType: 'image/png' }).omitted, 'binary');
  const login = apiCallRecord({ request: { url: 'https://api.uat.vinpearlota.com/api/v1/auth/login', method: 'POST', headers: { 'content-type': 'application/json' } }, response: { status: 200, mimeType: 'application/json' },
    startedAt: '2026-11-03T08:00:00.000Z', finishedAt: '2026-11-03T08:00:00.250Z', requestBody: '{"username":"u","password":"p"}', responseBody: '{"token":"t"}' });
  assert.equal(login.request.body.omitted, 'credential_endpoint');
  assert.equal(login.response.body.omitted, 'credential_endpoint');
  assert.equal(login.duration_ms, 250);
  assert.match(bodyText(login.request.body), /đăng nhập/);
});

test('the collector logs request and response of the website API, including errors and failures', async t => {
  const responses = { ok: JSON.stringify({ data: { discountAmount: 50000, promotionCode: 'KT002' } }), bad: JSON.stringify({ code: 'PROMOTION_INVALID', message: 'Mã không hợp lệ' }) };
  const mock = await mockCDP((command, send) => {
    const result = command.method === 'Network.getResponseBody' ? { body: responses[command.params.requestId], base64Encoded: false }
      : command.method === 'Network.getRequestPostData' ? { postData: '{"code":"KT003"}' }
      : command.method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'script1' } : {};
    send({ id: command.id, result });
  });
  t.after(() => mock.close());
  const calls = [];
  const collector = new CDPCollector({ port: mock.port, onEvent: () => {}, onApiCall: record => calls.push(record) });
  await collector.start({}); t.after(() => collector.stop());
  const page = 'https://dplatform-web.uat.vinpearlota.com/vi/hotel/checkout';
  const sendRequest = (requestId, url, extra = {}, type = 'XHR') => mock.send({ method: 'Network.requestWillBeSent', params: { requestId, type, wallTime: 1793000000, timestamp: 100, documentURL: page, request: { url, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' }, ...extra } } });
  sendRequest('ok', 'https://api.uat.vinpearlota.com/api/v1/promotion/apply', { postData: '{"code":"KT002","email":"a@b.vn"}' });
  mock.send({ method: 'Network.responseReceived', params: { requestId: 'ok', type: 'XHR', timestamp: 100.2, response: { status: 200, mimeType: 'application/json', headers: { 'set-cookie': 's=1', 'content-type': 'application/json' } } } });
  mock.send({ method: 'Network.loadingFinished', params: { requestId: 'ok', timestamp: 100.3, encodedDataLength: 80 } });
  sendRequest('bad', 'https://api.uat.vinpearlota.com/api/v1/promotion/apply', { hasPostData: true });
  mock.send({ method: 'Network.responseReceived', params: { requestId: 'bad', type: 'XHR', timestamp: 100.4, response: { status: 400, mimeType: 'application/json', headers: {} } } });
  mock.send({ method: 'Network.loadingFinished', params: { requestId: 'bad', timestamp: 100.5 } });
  sendRequest('down', 'https://api.vinpearlota.com/api/v2/shopping-cart', {}, 'Fetch');
  mock.send({ method: 'Network.loadingFailed', params: { requestId: 'down', timestamp: 101, errorText: 'net::ERR_CONNECTION_RESET' } });
  sendRequest('other', 'https://cdn.example.test/api/v1/x');
  mock.send({ method: 'Network.loadingFinished', params: { requestId: 'other' } });
  sendRequest('image', 'https://api.uat.vinpearlota.com/img/a.png', {}, 'Image');
  mock.send({ method: 'Network.loadingFinished', params: { requestId: 'image' } });
  for (let retry = 0; retry < 100 && calls.length < 3; retry++) await delay(10);
  await delay(30);
  assert.equal(calls.length, 3, 'only XHR/Fetch calls to the API hosts are logged');
  const [ok, bad, down] = ['/api/v1/promotion/apply', '/api/v1/promotion/apply', '/api/v2/shopping-cart'].map((p, index) => calls.filter(call => call.path === p)[index === 1 ? 1 : 0]);
  assert.equal(ok.method, 'POST'); assert.equal(ok.host, 'api.uat.vinpearlota.com'); assert.equal(ok.ok, true); assert.equal(ok.response.status, 200);
  assert.deepEqual(ok.request.body.json, { code: 'KT002', email: '[REDACTED]' });
  assert.deepEqual(ok.response.body.json, { data: { discountAmount: 50000, promotionCode: 'KT002' } });
  assert.deepEqual(ok.request.headers, { 'content-type': 'application/json' }, 'Authorization is never stored');
  assert.deepEqual(ok.response.headers, { 'content-type': 'application/json' }, 'Set-Cookie is never stored');
  assert.equal(ok.duration_ms, 300); assert.equal(ok.page.url, page);
  assert.equal(bad.ok, false); assert.equal(bad.response.status, 400);
  assert.deepEqual(bad.request.body.json, { code: 'KT003' }, 'a body Chrome did not inline is read with getRequestPostData');
  assert.equal(bad.response.body.json.code, 'PROMOTION_INVALID', 'the error response is kept');
  assert.equal(down.ok, false); assert.equal(down.error, 'net::ERR_CONNECTION_RESET'); assert.equal(down.response, null);
});

test('a call whose body the page never reads, and a call still open at stop, are logged anyway', async t => {
  const mock = await mockCDP((command, send) => send({ id: command.id, result: command.method === 'Network.getResponseBody' ? { body: '{"items":[]}', base64Encoded: false } : command.method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'script1' } : {} }));
  t.after(() => mock.close());
  const calls = [];
  const collector = new CDPCollector({ port: mock.port, onEvent: () => {}, onApiCall: record => calls.push(record), apiLogSettleMs: 50 });
  await collector.start({});
  const request = (requestId, url) => mock.send({ method: 'Network.requestWillBeSent', params: { requestId, type: 'Fetch', wallTime: 1793000000, timestamp: 1, documentURL: 'https://dplatform-web.uat.vinpearlota.com/vi', request: { url, method: 'GET', headers: {} } } });
  request('unread', 'https://api.uat.vinpearlota.com/api/v2/shopping-cart');
  mock.send({ method: 'Network.responseReceived', params: { requestId: 'unread', type: 'Fetch', timestamp: 1.1, response: { status: 200, mimeType: 'application/json' } } });
  for (let retry = 0; retry < 100 && !calls.length; retry++) await delay(10);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].incomplete, 'response_not_finished');
  assert.deepEqual(calls[0].response.body.json, { items: [] }, 'what Chrome has of the body is kept');
  request('open', 'https://api.uat.vinpearlota.com/api/v1/hotel/bookable');
  await delay(30);
  collector.flushApiLog();
  await collector.stop();
  assert.equal(calls.length, 2, 'flushed once, not again by stop()');
  assert.equal(calls[1].incomplete, 'no_response_before_stop');
  assert.equal(calls[1].ok, false);
});

test('API calls are stored in api-calls.jsonl, read back by id, recovered, and exported to Excel', async () => {
  const runsDir = tmp();
  const manager = new SessionManager({ runsDir, cases: [{ id: 'TC-1', name: 'Promotion', source: 'GA4', rules: [] }] });
  manager.start({ api_log: true });
  const record = apiCallRecord({ request: { url: 'https://api.uat.vinpearlota.com/api/v1/promotion/apply?lang=vi', method: 'POST', headers: {} }, response: { status: 200, mimeType: 'application/json' },
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), requestBody: '{"code":"KT002"}', responseBody: '{"discount":50000}' });
  const before = manager.emitApiCall(record);
  manager.startStep('TC-1');
  const during = manager.emitApiCall({ ...record, captured_at: new Date(Date.now() + 5).toISOString() });
  manager.completeStep();
  assert.match(before.evidence_id, /^APICALL-/); assert.equal(before.step_id, null);
  assert.equal(during.test_case_id, 'TC-1', 'a call made during a step carries the step');
  const summaries = manager.snapshot().apiCalls;
  assert.equal(summaries.length, 2); assert.equal(summaries[0].path, '/api/v1/promotion/apply'); assert.equal(summaries[0].status, 200);
  assert.equal(summaries[0].offset, undefined, 'byte offsets stay inside the store');
  assert.deepEqual(manager.apiCall(during.evidence_id).response.body.json, { discount: 50000 });
  const reopened = new EvidenceStore(manager.runDir);
  assert.equal(reopened.apiCallSummaries().length, 2, 'the index is rebuilt from the file');
  assert.equal(reopened.apiCall(during.evidence_id).evidence_id, during.evidence_id);
  reopened.close();
  manager.finish();
  const run = loadRun(manager.runDir);
  assert.equal(run.api_calls.length, 2);
  const files = await exportReports(run, manager.runDir);
  assert.equal(path.basename(files.api_calls), 'api-calls.jsonl');
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(files.xlsx);
  const sheet = workbook.getWorksheet('API calls');
  assert.ok(sheet, 'report.xlsx has the API calls sheet');
  assert.equal(sheet.rowCount, 3);
  assert.equal(sheet.getRow(2).getCell(4).value, '/api/v1/promotion/apply');
  assert.equal(sheet.getRow(2).getCell(9).value, '{"discount":50000}');
  const other = tmp();
  const copied = await exportReports(run, other);
  assert.equal(fs.readFileSync(copied.api_calls, 'utf8').trim().split('\n').length, 2, 'a report written elsewhere carries its own copy');
});

test('the API tab endpoints answer without a session and the state reports the API log', async t => {
  const app = await createApp({ mode: 'cdp', runsDir: tmp(), port: 0, initialCases: [] });
  const base = await app.listen(); t.after(() => app.close());
  const list = await (await fetch(`${base}/api/api-calls`)).json();
  assert.deepEqual([list.total, list.calls], [0, []]);
  assert.deepEqual(list.patterns, DEFAULT_API_LOG_PATTERNS);
  assert.equal((await fetch(`${base}/api/api-call?id=nope`)).status, 404);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.deepEqual([state.apiCalls.total, state.apiCalls.failed], [0, 0]);
  const page = await (await fetch(base)).text();
  assert.match(page, /id="log-api"/); assert.match(page, /data-tab="apicalls"/);
});
