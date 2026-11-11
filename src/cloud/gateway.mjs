// Public entry for hosted runs (GitHub Codespaces, a cloud VM): the app and noVNC keep listening on
// 127.0.0.1 and this gateway — the only port shared publicly — asks for the access key first. Requests
// reach the app with a localhost Host/Origin, so the app's own Host check and CSRF token keep working.
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { findBrowser } from '../browser/launcher.mjs';

const COOKIE = 'eqa_gate';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
// The app's rail links to the local mode chooser; online there is only this app.
const HUB_LINK = 'http://127.0.0.1:4172/';
// resize=remote makes the remote desktop match the viewer's tab (pixel for pixel, no blurry scaling);
// quality=9 is noVNC's sharpest JPEG level.
const VNC_PAGE = '/vnc/vnc.html?path=vnc/websockify&autoconnect=true&resize=remote&quality=9&compression=2&reconnect=true';
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const PAGE_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };

function sameText(a, b) {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

function hostName(host) { try { return new URL(`http://${host}`).hostname; } catch { return ''; } }

/** "https://a.example, https://b.example:8443" → hosts the public site is served from. */
export function publicHosts(value) {
  return String(value ?? '').split(/[\s,]+/).filter(Boolean).map(entry => {
    try { return new URL(entry).host; } catch { throw new Error(`EVENTQA_PUBLIC_URL không hợp lệ: ${entry}`); }
  });
}

const RAIL_BOTTOM = '<div class="rail-bottom">';
const SCREEN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';

/** Online, the test Chrome runs on the remote desktop: the app page gets a "Chrome" item in its left
 * rail (a floating button where there is no rail) opening /vnc, and hides Edge where the machine has none. */
export function injectOnline(html, { vnc = true, hideEdge = false } = {}) {
  if (!vnc && !hideEdge) return html;
  const title = 'Xem và thao tác trang web đang test (Chrome trên máy chủ) ở tab riêng';
  const rail = vnc && html.includes(RAIL_BOTTOM);
  const css = (hideEdge ? '[data-browser="edge"],option[value="edge"]{display:none!important}' : '')
    + (rail ? '.app-rail a#eqa-online-chrome{color:#fff;background:#4b3fa8}.app-rail a#eqa-online-chrome:hover{background:#5d50c4}#eqa-online-chrome span{font-size:9px;font-weight:600}' : '')
    + (vnc && !rail ? '#eqa-online-chrome{position:fixed;right:16px;bottom:16px;z-index:2147483000;padding:10px 16px;border-radius:999px;background:#4b3fa8;color:#fff;font:600 14px/1.2 system-ui,sans-serif;text-decoration:none}' : '');
  let out = html;
  if (rail) out = out.replace(RAIL_BOTTOM, `<a id="eqa-online-chrome" href="/vnc" target="eventqa-chrome" title="${title}" aria-label="${title}">${SCREEN_ICON}<span>Chrome</span></a>${RAIL_BOTTOM}`);
  const tail = `<style>${css}</style>${vnc && !rail ? `<a id="eqa-online-chrome" href="/vnc" target="eventqa-chrome" title="${title}">Màn hình Chrome</a>` : ''}`;
  return out.includes('</body>') ? out.replace('</body>', `${tail}</body>`) : out + tail;
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function loginPage(message = '') {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EventQA · Đăng nhập</title><style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#1d2330;--muted:#5d6678;--line:#d5d9e2;--accent:#2457d6;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1b2029;--text:#e8ebf1;--muted:#9aa3b5;--line:#2e3542;--accent:#6d93ff;--bad:#ff8a80}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
form{width:min(360px,calc(100vw - 32px));background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;box-sizing:border-box}
h1{font-size:18px;margin:0 0 4px}p{margin:0 0 16px;color:var(--muted)}.bad{color:var(--bad)}
input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
</style></head><body><form method="post" action="/login"><h1>EventQA online</h1>
<p>Nhập mã truy cập được người chia sẻ link gửi cho bạn.</p>${message ? `<p class="bad">${escapeHtml(message)}</p>` : ''}
<input type="password" name="key" autocomplete="current-password" placeholder="Mã truy cập" required autofocus>
<button type="submit">Vào EventQA</button></form></body></html>`;
}

async function readForm(req, limit = 4096) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Form quá lớn.'); chunks.push(chunk); }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * @param {{ key: string, appPort: number, vncPort?: number|null, port?: number, publicUrl?: string, failureDelayMs?: number }} options
 */
export function createGateway({ key, appPort, vncPort = null, port = 8080, publicUrl = '', hideEdge = false, failureDelayMs = 800 }) {
  if (typeof key !== 'string' || key.length < 12) throw new Error('Mã truy cập (EVENTQA_ACCESS_KEY) cần ít nhất 12 ký tự.');
  if (!Number.isInteger(appPort)) throw new Error('Thiếu cổng app.');
  const knownHosts = publicHosts(publicUrl);
  const online = { vnc: Boolean(vncPort), hideEdge };
  // Same key → same session value, so a gateway restart keeps people signed in; a new key signs everyone out.
  const session = createHmac('sha256', key).update('eventqa-gateway-session-v1').digest('base64url');
  const failures = [];

  const signedIn = req => sameText(readCookie(req.headers.cookie, COOKIE), session);
  // Browsers send Origin on POST and WebSocket requests; only this site's own pages may call through.
  // A port forwarder may rewrite Host, so the forwarded host and the configured public URL count too.
  const sameOrigin = req => {
    if (!req.headers.origin) return true;
    let origin;
    try { origin = new URL(req.headers.origin).host; } catch { return false; }
    const forwarded = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
    return [req.headers.host, forwarded, ...knownHosts].filter(Boolean).includes(origin);
  };
  const cookie = (req, value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
    + (LOCAL_HOSTS.has(hostName(req.headers.host)) && !knownHosts.length ? '' : '; Secure');

  async function tryLogin(req, res, candidate) {
    const now = Date.now();
    while (failures.length && now - failures[0] > 60_000) failures.shift();
    if (failures.length >= 20) { res.writeHead(429, PAGE_HEADERS); return res.end(loginPage('Sai quá nhiều lần. Đợi 1 phút rồi thử lại.')); }
    if (candidate && sameText(candidate, key)) {
      res.writeHead(303, { Location: '/', 'Set-Cookie': cookie(req, session, 12 * 3600), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }
    failures.push(now);
    await new Promise(resolve => setTimeout(resolve, failureDelayMs));
    res.writeHead(401, PAGE_HEADERS); res.end(loginPage(candidate ? 'Mã truy cập không đúng.' : ''));
  }

  function forward(req, res, upstreamPort, upstreamPath) {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.includes(name)) headers[name] = value;
    headers.host = `127.0.0.1:${upstreamPort}`;
    if (headers.origin) headers.origin = `http://127.0.0.1:${upstreamPort}`;
    delete headers.cookie; delete headers.referer;
    const rewriteHtml = upstreamPort === appPort;
    const upstream = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: upstreamPath, headers }, up => {
      const outHeaders = {};
      for (const [name, value] of Object.entries(up.headers)) if (!HOP_BY_HOP.includes(name)) outHeaders[name] = value;
      if (rewriteHtml && String(up.headers['content-type'] ?? '').startsWith('text/html')) {
        const chunks = [];
        up.on('data', chunk => chunks.push(chunk));
        up.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf8').replaceAll(HUB_LINK, '/');
          if (upstreamPath.split('?')[0] === '/') html = injectOnline(html, online);
          const body = Buffer.from(html);
          res.writeHead(up.statusCode, { ...outHeaders, 'content-length': body.length }); res.end(body);
        });
        up.on('error', () => res.destroy());
        return;
      }
      res.writeHead(up.statusCode, outHeaders);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, PAGE_HEADERS);
      res.end('<!doctype html><meta charset="utf-8"><title>EventQA</title><p style="font:15px system-ui;margin:2em">EventQA đang khởi động hoặc vừa khởi động lại. Thử lại sau vài giây.</p>');
    });
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://gateway.local');
      if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('ok'); }
      if (url.pathname === '/login' && req.method === 'POST') return await tryLogin(req, res, (await readForm(req)).get('key'));
      if (url.pathname === '/login' && req.method === 'GET') {
        if (url.searchParams.has('key')) return await tryLogin(req, res, url.searchParams.get('key'));
        res.writeHead(200, PAGE_HEADERS); return res.end(loginPage());
      }
      if (url.pathname === '/logout') {
        res.writeHead(303, { Location: '/login', 'Set-Cookie': cookie(req, '', 0), 'Cache-Control': 'no-store' }); return res.end();
      }
      if (!signedIn(req)) {
        req.resume();
        if (['GET', 'HEAD'].includes(req.method) && !url.pathname.startsWith('/api/')) { res.writeHead(401, PAGE_HEADERS); return res.end(loginPage()); }
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ error: 'Cần đăng nhập EventQA online (mã truy cập).' }));
      }
      if (!sameOrigin(req)) {
        req.resume(); res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'Yêu cầu từ trang khác bị chặn.' }));
      }
      if (url.pathname === '/vnc' || url.pathname === '/vnc/') {
        req.resume();
        if (!vncPort) { res.writeHead(404, PAGE_HEADERS); return res.end('<!doctype html><meta charset="utf-8"><p>Máy này không bật màn hình từ xa (noVNC).</p>'); }
        res.writeHead(302, { Location: VNC_PAGE, 'Cache-Control': 'no-store' }); return res.end();
      }
      if (url.pathname.startsWith('/vnc/') && vncPort) return forward(req, res, vncPort, url.pathname.slice('/vnc'.length) + url.search);
      return forward(req, res, appPort, url.pathname + url.search);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: error.message }));
    }
  });

  // noVNC talks to websockify over a WebSocket at /vnc/websockify.
  const relays = new Set();
  server.on('upgrade', (req, socket, head) => {
    const refuse = code => socket.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.on('error', () => socket.destroy());
    if (!signedIn(req)) return refuse(401);
    if (!sameOrigin(req)) return refuse(403);
    const url = new URL(req.url, 'http://gateway.local');
    if (!vncPort || !url.pathname.startsWith('/vnc/')) return refuse(404);
    const target = net.connect(vncPort, '127.0.0.1', () => {
      let raw = `${req.method} ${url.pathname.slice('/vnc'.length)}${url.search} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i], lower = name.toLowerCase();
        if (lower === 'cookie' || lower === 'referer') continue;
        const value = lower === 'host' ? `127.0.0.1:${vncPort}` : lower === 'origin' ? `http://127.0.0.1:${vncPort}` : req.rawHeaders[i + 1];
        raw += `${name}: ${value}\r\n`;
      }
      target.write(`${raw}\r\n`);
      if (head?.length) target.write(head);
      target.pipe(socket); socket.pipe(target);
    });
    // One side closing ends the relay; a half-closed side gets a few seconds to flush, then both go.
    relays.add(socket); relays.add(target);
    const finish = () => { socket.destroy(); target.destroy(); relays.delete(socket); relays.delete(target); };
    for (const side of [socket, target]) {
      side.on('error', finish);
      side.on('close', finish);
      side.on('end', () => setTimeout(finish, 5000).unref());
    }
  });

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      for (const side of relays) side.destroy();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve()));
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '8080' }, app: { type: 'string', default: '4174' }, vnc: { type: 'string' } } });
  let edgeInstalled = true;
  try { findBrowser('edge'); } catch { edgeInstalled = false; }
  const gateway = createGateway({ key: process.env.EVENTQA_ACCESS_KEY, appPort: Number(values.app), publicUrl: process.env.EVENTQA_PUBLIC_URL,
    vncPort: values.vnc ? Number(values.vnc) : null, port: Number(values.port), hideEdge: !edgeInstalled });
  console.log(`EventQA gateway ${await gateway.listen()} → app 127.0.0.1:${values.app}${values.vnc ? `, noVNC 127.0.0.1:${values.vnc}` : ''}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { gateway.close().finally(() => process.exit(0)); });
}
