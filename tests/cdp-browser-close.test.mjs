import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchBrowser, closeOwnedBrowser } from '../src/browser/launcher.mjs';

async function ownedFixture(t, { changed = false, stallFetch = false, stallCommand = false } = {}) {
  const commands = [], sockets = [];
  const endpoint = 'ws://127.0.0.1:19331/devtools/browser/owned-test-id';
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null, killed: false });
  child.kill = () => { child.killed = true; return true; };
  const spawn = t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  t.after(() => { spawn.mock.restore(); syncBuiltinESMExports(); });
  let fetches = 0, aborted = false;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    fetches++;
    if (fetches === 1) throw new Error('No debug endpoint before launch.');
    if (fetches > 2 && stallFetch) return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }));
    return new Response(JSON.stringify({ webSocketDebuggerUrl: fetches > 2 && changed ? endpoint.replace('owned-test-id', 'another-browser') : endpoint }), { status: 200 });
  });
  class FakeWebSocket extends EventTarget {
    static OPEN = 1;
    constructor(url) { super(); this.url = url; this.readyState = 0; sockets.push(this); queueMicrotask(() => { if (this.readyState !== 3) { this.readyState = 1; this.dispatchEvent(new Event('open')); } }); }
    send(raw) { const command = JSON.parse(raw); commands.push(command); if (!stallCommand) queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: command.id, result: {} }) }))); }
    close() { this.readyState = 3; queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
  }
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });
  const profileDir = mkdtempSync(join(tmpdir(), 'eventqa-browser-close-'));
  t.after(() => rmdirSync(profileDir));
  const handle = await launchBrowser({ browser: 'chrome', port: 19331, executablePath: process.execPath, profileDir });
  return { handle, commands, sockets, child, endpoint, get fetches() { return fetches; }, get aborted() { return aborted; } };
}

test('browser close rejects attached, copied and forged handles without connecting', async () => {
  assert.deepEqual(await closeOwnedBrowser(null), { closed: false, reason: 'not_owned' });
  assert.deepEqual(await closeOwnedBrowser({ owned: true, port: 9222, process: { exitCode: null } }), { closed: false, reason: 'not_owned' });
});

test('browser close uses the registered exact browser endpoint and never kills the process', async t => {
  const fixture = await ownedFixture(t);
  assert.deepEqual(await closeOwnedBrowser({ ...fixture.handle }), { closed: false, reason: 'not_owned' });
  assert.deepEqual(await closeOwnedBrowser(fixture.handle), { closed: true, reason: 'close_requested' });
  assert.deepEqual(fixture.commands.map(command => command.method), ['Browser.close']);
  assert.equal(fixture.sockets[0].url, fixture.endpoint);
  assert.equal(fixture.sockets[0].readyState, 3);
  assert.equal(fixture.child.killed, false);
});

test('browser close refuses a reused port belonging to a different browser identity', async t => {
  const fixture = await ownedFixture(t, { changed: true });
  assert.deepEqual(await closeOwnedBrowser(fixture.handle), { closed: false, reason: 'browser_identity_changed' });
  assert.equal(fixture.sockets.length, 0);
  assert.equal(fixture.commands.length, 0);
  assert.equal(fixture.child.killed, false);
});

test('browser close does not follow a port after the owned child has exited', async t => {
  const fixture = await ownedFixture(t);
  fixture.child.exitCode = 0;
  assert.deepEqual(await closeOwnedBrowser(fixture.handle), { closed: true, reason: 'already_exited' });
  assert.equal(fixture.fetches, 2);
  assert.equal(fixture.sockets.length, 0);
});

test('browser close bounds an unresponsive endpoint and aborts its request', async t => {
  const fixture = await ownedFixture(t, { stallFetch: true });
  const started = performance.now();
  assert.deepEqual(await closeOwnedBrowser(fixture.handle, { timeoutMs: 40 }), { closed: false, reason: 'timeout' });
  assert.ok(performance.now() - started < 400);
  assert.equal(fixture.aborted, true);
  assert.equal(fixture.child.killed, false);
});

test('browser close bounds an unresponsive Browser.close command', async t => {
  const fixture = await ownedFixture(t, { stallCommand: true });
  const started = performance.now();
  assert.deepEqual(await closeOwnedBrowser(fixture.handle, { timeoutMs: 40 }), { closed: false, reason: 'timeout' });
  assert.ok(performance.now() - started < 400);
  assert.equal(fixture.sockets[0].readyState, 3);
  assert.equal(fixture.commands.length, 1);
});
