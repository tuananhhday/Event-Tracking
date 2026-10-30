import http from 'node:http';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createApp } from './server.mjs';

// Own all three local applications so the portable launcher needs one window.
export async function createHub({ port = 4172, modePorts = [4173, 4174, 4175], runsDir } = {}) {
  const modes = ['cdp', 'cdp-ai', 'proxy'];
  const apps = [];
  const csrf = randomBytes(24).toString('hex');
  let closing;
  const close = () => closing ??= (async () => {
    await Promise.all(apps.map(app => app.close()));
    if (server.listening) {
      const done = new Promise(resolve => server.close(resolve));
      server.closeIdleConnections?.();
      await done;
    }
  })();
  const server = http.createServer(async (req, res) => {
    const send = (status, data, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" });
      res.end(typeof data === 'string' ? data : JSON.stringify(data));
    };
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return send(403, { error: 'Localhost required' });
    if (req.method === 'GET' && req.url === '/api/state') return send(200, { application: 'event-tracking-qa', mode: 'hub', process_id: process.pid, modes: apps.map((app, i) => ({ mode: modes[i], url: app.url })) });
    if (req.method === 'POST' && req.url === '/api/shutdown') {
      if (req.headers['x-eventqa-token'] !== csrf || (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin))) return send(403, { error: 'Local request token required' });
      req.resume();
      res.once('finish', () => { setImmediate(() => void close()); });
      return send(200, { stopping: true });
    }
    if (req.method !== 'GET' || req.url !== '/') return send(404, { error: 'Not found' });
    try {
      let html = await fs.readFile(new URL('./web/home.html', import.meta.url), 'utf8');
      for (let i = 0; i < modes.length; i++) html = html.replaceAll(`__MODE_${i + 1}__`, apps[i].url);
      html = html.replaceAll('__CSRF__', csrf);
      send(200, html, 'text/html; charset=utf-8');
    } catch { send(500, { error: 'Không mở được trang chọn chế độ.' }); }
  });
  return { server, csrf, apps, close, async listen() {
    try {
      for (let i = 0; i < modes.length; i++) {
        const app = await createApp({ mode: modes[i], port: modePorts[i], runsDir, initialCases: 'auto' });
        apps.push(app);
        app.url = await app.listen();
      }
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      port = server.address().port;
      return `http://127.0.0.1:${port}`;
    } catch (error) { await close(); throw error; }
  } };
}
