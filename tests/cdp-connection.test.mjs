import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { CDPConnection, CDPCollector, listTargets } from '../src/collectors/cdp.mjs';

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

test('connection resolves interleaved command responses and asynchronous events', async t => {
  const mock = await mockCDP((command, send) => {
    if (command.method === 'outer') send({ method: 'Runtime.bindingCalled', params: { name: 'trigger' } });
    send({ id: command.id, result: { method: command.method } });
  });
  t.after(() => mock.close());
  const connection = new CDPConnection(mock.url);
  await connection.connect();
  t.after(() => connection.close());
  let inner;
  connection.on('event', () => { inner = connection.send('inner'); });
  assert.equal((await connection.send('outer')).method, 'outer');
  assert.equal((await inner).method, 'inner');
});

test('request-only collector observes traffic without injecting code or pausing the website', async t => {
  const commands = [], events = [];
  const mock = await mockCDP((command, send) => { commands.push(command); send({ id: command.id, result: {} }); });
  t.after(() => mock.close());
  const collector = new CDPCollector({ port: mock.port, captureQueues: false, onEvent: e => events.push(e) });
  t.after(() => collector.stop());
  await collector.start({});
  mock.send({ method: 'Runtime.executionContextCreated', params: { context: { id: 1, auxData: { isDefault: true } } } });
  mock.send({ method: 'Network.requestWillBeSent', params: { requestId: 'order-event', request: { url: 'https://unification.useinsider.com/api/event/', method: 'POST', postData: '{"event_name":"purchase","event_params":{"total":110000}}', headers: { 'content-type': 'application/json' } } } });
  for (let i = 0; i < 50 && !events.length; i++) await delay(10);
  assert.equal(events[0]?.event_name, 'purchase');
  assert.ok(!commands.some(c => c.method.startsWith('Runtime.') || c.method === 'Page.addScriptToEvaluateOnNewDocument' || c.method === 'Fetch.enable'));
  assert.ok(commands.filter(c => c.method === 'Target.setAutoAttach').every(c => c.params.waitForDebuggerOnStart === false));
  await collector.stop();
  assert.ok(!commands.some(c => c.method === 'Runtime.removeBinding'));
});

test('CDP connection rejects remote hosts and times out pending commands', async t => {
  assert.throws(() => new CDPConnection('ws://evil.example:9222/'), /localhost/);
  const mock = await mockCDP(() => {});
  t.after(() => mock.close());
  const connection = new CDPConnection(mock.url, { timeoutMs: 50 });
  await connection.connect(); t.after(() => connection.close());
  await assert.rejects(connection.send('never'), /timed out/);
});

test('collector obtains missing POST data without deadlocking receiver and separates lifecycle evidence', async t => {
  const commands = [];
  const mock = await mockCDP((command, send) => {
    commands.push(command.method);
    send({ id: command.id, result: command.method === 'Network.getRequestPostData' ? { postData: 'en=search_submit&ep.service=hotel' } : command.method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'script1' } : {} });
  });
  t.after(() => mock.close());
  assert.equal((await listTargets(mock.port))[0].id, 'tab1');
  const events = [];
  const collector = new CDPCollector({ port: mock.port, onEvent: event => events.push(event) });
  await collector.start({}); t.after(() => collector.stop());
  mock.send({ method: 'Network.requestWillBeSent', params: { requestId: 'preflight1', request: { url: 'https://www.google-analytics.com/g/collect?v=2&en=search_submit', method: 'OPTIONS', headers: {} } } });
  mock.send({ method: 'Network.requestWillBeSent', params: { requestId: 'request1', wallTime: 1234567890, documentURL: 'https://example.test/', request: { url: 'https://www.google-analytics.com/g/collect?v=2', method: 'POST', hasPostData: true, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } } });
  mock.send({ method: 'Network.responseReceived', params: { requestId: 'request1', response: { status: 204 } } });
  mock.send({ method: 'Network.loadingFinished', params: { requestId: 'request1' } });
  for (let retry = 0; retry < 50 && events.length < 2; retry++) await delay(10);
  assert.ok(commands.includes('Network.getRequestPostData'));
  assert.equal(events.length, 2);
  assert.equal(events[0].event_name, 'search_submit');
  assert.equal(events[0].network.phase, 'request');
  assert.equal(events[1].network.phase, 'response');
  assert.equal(events[1].network.status, 204);
  assert.equal(events[0].captured_at, events[1].captured_at);
});

test('a canceled loader after a delivered response is not a failure, but real failures still are', async t => {
  const mock = await mockCDP((command, send) => send({ id: command.id, result: command.method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'script1' } : {} }));
  t.after(() => mock.close());
  const events = [];
  const collector = new CDPCollector({ port: mock.port, onEvent: event => events.push(event) });
  await collector.start({}); t.after(() => collector.stop());
  const request = id => ({ method: 'Network.requestWillBeSent', params: { requestId: id, request: { url: 'https://www.google-analytics.com/g/collect?v=2&en=search_submit', method: 'POST', headers: {} } } });
  // Observed on Chrome 156: 204 delivered to the page, then loadingFailed canceled/ERR_ABORTED.
  mock.send(request('delivered'));
  mock.send({ method: 'Network.responseReceived', params: { requestId: 'delivered', response: { status: 204 } } });
  mock.send({ method: 'Network.loadingFailed', params: { requestId: 'delivered', errorText: 'net::ERR_ABORTED', canceled: true } });
  // Canceled before any response, and a non-canceled failure after one, remain failures.
  mock.send(request('aborted'));
  mock.send({ method: 'Network.loadingFailed', params: { requestId: 'aborted', errorText: 'net::ERR_ABORTED', canceled: true } });
  mock.send(request('reset'));
  mock.send({ method: 'Network.responseReceived', params: { requestId: 'reset', response: { status: 200 } } });
  mock.send({ method: 'Network.loadingFailed', params: { requestId: 'reset', errorText: 'net::ERR_CONNECTION_RESET' } });
  for (let retry = 0; retry < 50 && events.length < 7; retry++) await delay(10);
  const phases = id => events.filter(event => event.network.request_id === id).map(event => event.network.phase);
  assert.deepEqual(phases('delivered'), ['request', 'response']);
  assert.deepEqual(phases('aborted'), ['request', 'failed']);
  assert.deepEqual(phases('reset'), ['request', 'response', 'failed']);
});

test('collector stop is bounded with many unresponsive frames and a stalled event callback', async t => {
  let hold = false;
  const mock = await mockCDP((command, send) => {
    if (!hold) send({ id: command.id, result: command.method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'script1' } : {} });
  });
  t.after(() => mock.close());
  let callbacks = 0;
  const collector = new CDPCollector({ port: mock.port, onEvent: () => { callbacks++; return new Promise(() => {}); } });
  await collector.start({});
  t.after(() => collector.forceStop());
  const state = [...collector.connections.values()][0];
  for (let index = 0; index < 100; index++) state.contexts.set(String(index), { id: index });
  const message = { method: 'Runtime.bindingCalled', params: { name: '__eventqa_emit', payload: JSON.stringify({ queue: 'dataLayer', item: { event: 'once' }, ts: Date.now() }) } };
  state.connection.emit('event', message);
  await delay(1);
  assert.equal(callbacks, 1);
  hold = true;
  const started = performance.now();
  const stopping = collector.stop({ timeoutMs: 40 });
  assert.equal(collector.running, false);
  assert.strictEqual(collector.stop(), stopping);
  assert.deepEqual(await stopping, { forced: true });
  assert.ok(performance.now() - started < 400, 'shutdown exceeded its total deadline');
  assert.equal(collector.connections.size, 0);
  assert.equal(collector.activeConnections.size, 0);
  assert.equal(state.connection.pending.size, 0);
  assert.equal(collector.timer, null);
  state.connection.emit('event', message);
  await delay(1);
  assert.equal(callbacks, 1, 'no new callback may start after stop');
});

test('forceStop cancels in-progress startup and stale connections cannot emit into a restarted run', async t => {
  let hold = true, firstCommand = false;
  const mock = await mockCDP((command, send) => {
    firstCommand = true;
    if (!hold) send({ id: command.id, result: command.method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'script1' } : {} });
  });
  t.after(() => mock.close());
  const events = [];
  const collector = new CDPCollector({ port: mock.port, onEvent: event => events.push(event) });
  const starting = collector.start({});
  const rejected = assert.rejects(starting, /closed|stopped/);
  for (let retry = 0; retry < 100 && !firstCommand; retry++) await delay(2);
  assert.ok(firstCommand);
  const stale = [...collector.connections.values()][0].connection;
  collector.forceStop();
  await rejected;
  assert.equal(collector.activeConnections.size, 0);
  assert.equal(collector.timer, null);
  hold = false;
  await collector.start({});
  t.after(() => collector.forceStop());
  const message = { method: 'Runtime.bindingCalled', params: { name: '__eventqa_emit', payload: JSON.stringify({ queue: 'dataLayer', item: { event: 'stale' }, ts: Date.now() }) } };
  stale.emit('event', message);
  await delay(1);
  assert.equal(events.length, 0);
  await collector.stop({ timeoutMs: 100 });
});

test('closing a WebSocket during handshake rejects connect immediately and clears its timer', async t => {
  const sockets = new Set();
  const server = createServer();
  server.on('upgrade', (_request, socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const connection = new CDPConnection(`ws://127.0.0.1:${server.address().port}/pending`, { timeoutMs: 8000 });
  const rejected = assert.rejects(connection.connect(), /closed|failed/);
  const started = performance.now();
  connection.close();
  await rejected;
  assert.ok(performance.now() - started < 300);
  assert.equal(connection.closed, true);
  assert.equal(connection.pending.size, 0);
});
