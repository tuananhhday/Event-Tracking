import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway, publicHosts, injectOnline } from '../src/cloud/gateway.mjs';
import { extraBrowserArgs } from '../src/browser/launcher.mjs';

const KEY = 'correct-horse-battery-staple';

async function upstream(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res, body); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, port: server.address().port };
}

async function setup(options = {}) {
  const app = await upstream((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<a href="http://127.0.0.1:4172/">hub</a><nav class="app-rail"><button>Event</button><div class="rail-bottom"></div></nav></body>'); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  const vnc = await upstream((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`vnc:${req.url}`); });
  vnc.server.on('upgrade', (req, socket) => {
    vnc.upgrade = { url: req.url, headers: req.headers };
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', data => socket.write(`echo:${data}`));
    socket.on('end', () => socket.end());
    socket.on('error', () => socket.destroy());
  });
  const gateway = createGateway({ key: KEY, appPort: app.port, vncPort: vnc.port, port: 0, failureDelayMs: 0, ...options });
  const base = await gateway.listen();
  const stop = server => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  return { app, vnc, gateway, base, async close() { await gateway.close(); await Promise.all([stop(app.server), stop(vnc.server)]); } };
}

async function login(base) {
  const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ key: KEY }) });
  assert.equal(response.status, 303);
  return response.headers.get('set-cookie').split(';')[0];
}

test('gateway asks for the access key before anything reaches the app', async () => {
  const ctx = await setup();
  try {
    const page = await fetch(`${ctx.base}/`);
    assert.equal(page.status, 401);
    assert.match(await page.text(), /Mã truy cập/);
    assert.equal((await fetch(`${ctx.base}/api/state`)).status, 401);
    const wrong = await fetch(`${ctx.base}/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ key: 'wrong-key-123456' }) });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('set-cookie'), null);
    assert.equal(ctx.app.seen.length, 0);
    assert.equal((await fetch(`${ctx.base}/healthz`)).status, 200);
  } finally { await ctx.close(); }
});

test('signed-in requests reach the app with a localhost Host/Origin and no gateway cookie', async () => {
  const ctx = await setup();
  try {
    const cookie = await login(ctx.base);
    assert.match(cookie, /^eqa_gate=/);
    const page = await fetch(`${ctx.base}/`, { headers: { cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.startsWith('<a href="/">hub</a>'), 'the local mode-chooser link points back to this app');
    assert.match(html, /<button>Event<\/button><a id="eqa-online-chrome" href="\/vnc" target="eventqa-chrome"[^>]*><svg[^]*<span>Chrome<\/span><\/a><div class="rail-bottom">/,
      'the left rail gets a Chrome item opening the remote screen');
    assert.doesNotMatch(html, /data-browser="edge"/, 'Edge stays selectable unless the machine has none');

    const post = await fetch(`${ctx.base}/api/export`, { method: 'POST', headers: { cookie, origin: ctx.base, 'content-type': 'application/json', 'x-eventqa-token': 't' }, body: '{"a":1}' });
    assert.equal(post.status, 200);
    const seen = ctx.app.seen.at(-1);
    assert.equal(seen.headers.host, `127.0.0.1:${ctx.app.port}`);
    assert.equal(seen.headers.origin, `http://127.0.0.1:${ctx.app.port}`);
    assert.equal(seen.headers['x-eventqa-token'], 't');
    assert.equal(seen.headers.cookie, undefined);
    assert.equal(seen.body, '{"a":1}');

    const quick = await fetch(`${ctx.base}/login?key=${encodeURIComponent(KEY)}`, { redirect: 'manual' });
    assert.equal(quick.status, 303);
    assert.equal(quick.headers.get('location'), '/');
  } finally { await ctx.close(); }
});

test('on a machine without Edge the app page hides the Edge choice; other responses are untouched', async () => {
  const ctx = await setup({ hideEdge: true });
  try {
    const cookie = await login(ctx.base);
    const html = await (await fetch(`${ctx.base}/`, { headers: { cookie } })).text();
    assert.match(html, /\[data-browser="edge"\],option\[value="edge"\]\{display:none!important\}/);
    const api = await (await fetch(`${ctx.base}/api/state`, { headers: { cookie } })).json();
    assert.deepEqual(api, { ok: true, path: '/api/state' });
  } finally { await ctx.close(); }
});

test('requests from another site are refused even with the cookie', async () => {
  const ctx = await setup();
  try {
    const cookie = await login(ctx.base);
    const before = ctx.app.seen.length;
    const response = await fetch(`${ctx.base}/api/shutdown`, { method: 'POST', headers: { cookie, origin: 'https://evil.example' }, body: '{}' });
    assert.equal(response.status, 403);
    assert.equal(ctx.app.seen.length, before);
  } finally { await ctx.close(); }
});

test('pages served from the public URL may call through even when the forwarder rewrites Host', async () => {
  const ctx = await setup({ publicUrl: 'https://demo-codespace-8080.app.github.dev' });
  try {
    const cookie = await login(ctx.base);
    assert.match((await fetch(`${ctx.base}/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ key: KEY }) })).headers.get('set-cookie'), /; Secure/);
    const ok = await fetch(`${ctx.base}/api/export`, { method: 'POST', headers: { cookie, origin: 'https://demo-codespace-8080.app.github.dev' }, body: '{}' });
    assert.equal(ok.status, 200);
    const forwarded = await fetch(`${ctx.base}/api/export`, { method: 'POST', headers: { cookie, origin: 'https://other-8080.app.github.dev', 'x-forwarded-host': 'other-8080.app.github.dev' }, body: '{}' });
    assert.equal(forwarded.status, 200);
    const foreign = await fetch(`${ctx.base}/api/export`, { method: 'POST', headers: { cookie, origin: 'https://evil-8080.app.github.dev' }, body: '{}' });
    assert.equal(foreign.status, 403);
  } finally { await ctx.close(); }
});

test('/vnc serves noVNC and relays its WebSocket with the prefix removed', async () => {
  const ctx = await setup();
  try {
    const cookie = await login(ctx.base);
    const entry = await fetch(`${ctx.base}/vnc`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(entry.status, 302);
    assert.match(entry.headers.get('location'), /^\/vnc\/vnc\.html\?path=vnc\/websockify/);
    const asset = await fetch(`${ctx.base}/vnc/app/ui.js`, { headers: { cookie } });
    assert.equal(await asset.text(), 'vnc:/app/ui.js');

    const relayed = await new Promise((resolve, reject) => {
      const req = http.request(`${ctx.base}/vnc/websockify`, { headers: { cookie, Connection: 'Upgrade', Upgrade: 'websocket', Origin: ctx.base } });
      req.on('upgrade', (res, socket) => { socket.once('data', data => { socket.destroy(); resolve(String(data)); }); socket.write('ping'); });
      req.on('response', res => reject(new Error(`no upgrade: ${res.statusCode}`)));
      req.on('error', reject); req.end();
    });
    assert.equal(relayed, 'echo:ping');
    assert.equal(ctx.vnc.upgrade.url, '/websockify');
    assert.equal(ctx.vnc.upgrade.headers.host, `127.0.0.1:${ctx.vnc.port}`);
    assert.equal(ctx.vnc.upgrade.headers.cookie, undefined);

    const anonymous = await new Promise((resolve, reject) => {
      const req = http.request(`${ctx.base}/vnc/websockify`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket' } });
      req.on('upgrade', () => reject(new Error('upgraded without key')));
      req.on('response', res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(anonymous, 401);
  } finally { await ctx.close(); }
});

test('a page without the rail gets a floating Chrome button; nothing is added without noVNC or hidden Edge', () => {
  const floating = injectOnline('<main>x</main></body>', { vnc: true });
  assert.match(floating, /<main>x<\/main><style>#eqa-online-chrome\{position:fixed[^<]*<\/style><a id="eqa-online-chrome" href="\/vnc"[^>]*>Màn hình Chrome<\/a><\/body>/);
  assert.equal(injectOnline('<main>x</main></body>', { vnc: false, hideEdge: false }), '<main>x</main></body>');
});

test('gateway refuses a short access key and a malformed public URL', () => {
  assert.throws(() => createGateway({ key: 'short', appPort: 1 }), /12 ký tự/);
  assert.throws(() => createGateway({ key: KEY, appPort: 1, publicUrl: 'not a url' }), /EVENTQA_PUBLIC_URL/);
  assert.deepEqual(publicHosts('https://a-8080.app.github.dev, https://b.example:8443/'), ['a-8080.app.github.dev', 'b.example:8443']);
  assert.deepEqual(publicHosts(undefined), []);
});

test('EVENTQA_BROWSER_ARGS adds hosted-run flags but cannot move CDP or the profile', () => {
  assert.deepEqual(extraBrowserArgs('--no-sandbox  --disable-dev-shm-usage --window-size=1920,1080'), ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1920,1080']);
  assert.deepEqual(extraBrowserArgs(''), []);
  assert.deepEqual(extraBrowserArgs(undefined), []);
  for (const bad of ['--remote-debugging-address=0.0.0.0', '--remote-debugging-port=9999', '--user-data-dir=/tmp/x', '--headless=new', '--remote-allow-origins=*', 'rm -rf', '--x;y']) {
    assert.throws(() => extraBrowserArgs(bad), /EVENTQA_BROWSER_ARGS/, bad);
  }
});
