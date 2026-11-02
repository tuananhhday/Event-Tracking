import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestPage } from '../src/browser/launcher.mjs';

test('startup creates and activates its own normal window instead of using a discovered dialog', async t => {
  const commands = [];
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:19561/devtools/browser/fixture' })));
  class Socket extends EventTarget {
    static OPEN = 1;
    constructor() { super(); this.readyState = 1; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(raw) {
      const command = JSON.parse(raw); commands.push(command);
      const result = command.method === 'Target.createTarget' ? { targetId: 'new-main-page' } : command.method === 'Browser.getWindowForTarget' ? { windowId: 42 } : {};
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: command.id, result }) })));
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => { globalThis.WebSocket = original; });
  assert.equal(await createTestPage({ port: 19561 }), 'new-main-page');
  assert.deepEqual(commands.map(c => c.method), ['Target.createTarget', 'Browser.getWindowForTarget', 'Browser.setWindowBounds', 'Target.activateTarget']);
  assert.equal(commands[0].params.newWindow, true);
  assert.equal(commands[0].params.url, 'about:blank');
  assert.deepEqual(commands[2].params.bounds, { windowState: 'maximized' });
  assert.equal(commands[3].params.targetId, 'new-main-page');
});

test('startup rejects a browser identity for another port without connecting', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:19562/devtools/browser/other' })));
  await assert.rejects(createTestPage({ port: 19561 }), /Invalid test browser identity/);
});

test('a browser the app launched loads the website in its startup page, and a new session reuses the previous test page: one window', async t => {
  const run = async (reuse, targets) => {
    const commands = [];
    class Socket extends EventTarget {
      static OPEN = 1;
      constructor() { super(); this.readyState = 1; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      send(raw) {
        const command = JSON.parse(raw); commands.push(command);
        const result = command.method === 'Target.getTargets' ? { targetInfos: targets } : command.method === 'Target.createTarget' ? { targetId: 'new-window-page' } : command.method === 'Browser.getWindowForTarget' ? { windowId: 7 } : {};
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: command.id, result }) })));
      }
      close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    }
    const original = globalThis.WebSocket;
    globalThis.WebSocket = Socket;
    try { return { targetId: await createTestPage({ port: 19561, reuse }), methods: commands.map(c => c.method) }; }
    finally { globalThis.WebSocket = original; }
  };
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:19561/devtools/browser/fixture' })));
  const startup = await run('startup', [{ type: 'page', url: 'edge://welcome/', targetId: 'dialog' }, { type: 'page', url: 'about:blank', targetId: 'startup-page' }]);
  assert.equal(startup.targetId, 'startup-page', 'the blank startup page, not the dialog');
  assert.ok(!startup.methods.includes('Target.createTarget'), 'no second window');
  const previous = await run('test-page-1', [{ type: 'page', url: 'https://vinpearlota.com/vi', targetId: 'test-page-1' }]);
  assert.equal(previous.targetId, 'test-page-1');
  assert.ok(!previous.methods.includes('Target.createTarget'));
  // The previous page was closed by the user: a new one is opened.
  assert.equal((await run('test-page-1', [])).targetId, 'new-window-page');
});
