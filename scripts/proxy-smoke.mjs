import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProxyCollector } from '../src/collectors/proxy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const secure = process.argv.includes('--https');
const runDir = path.join(root, 'runs', secure ? 'proxy-https-smoke' : 'proxy-smoke');
const commandIndex = process.argv.indexOf('--command');
const command = commandIndex >= 0 ? process.argv[commandIndex + 1] : path.join(root, '.venv-proxy', 'Scripts', 'mitmdump.exe');
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const close = server => new Promise(resolve => server.close(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

await fs.mkdir(runDir, { recursive: true });
let upstreamTls;
if (secure) {
  const pythonIndex = process.argv.indexOf('--python');
  const python = pythonIndex >= 0 ? process.argv[pythonIndex + 1] : path.join(root, '.venv-proxy', 'Scripts', 'python.exe');
  const certDir = path.join(runDir, 'tls-test');
  await new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(root, 'scripts', 'proxy-test-cert.py'), certDir], { shell: false, windowsHide: true, stdio: 'ignore' });
    child.once('error', () => reject(new Error('TEST_CERT_PYTHON_NOT_AVAILABLE')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('TEST_CERT_GENERATION_FAILED')));
  });
  upstreamTls = { key: await fs.readFile(path.join(certDir, 'upstream-key.pem')), cert: await fs.readFile(path.join(certDir, 'upstream-cert.pem')), caFile: path.join(certDir, 'upstream-cert.pem') };
}
const probe = net.createServer();
const proxyPort = await listen(probe);
await close(probe);
let upstreamRequests = 0;
let originalBodyIntact = false;
let originalQueryIntact = false;
const statuses = [];
const events = [];
const syntheticToken = 'eventqa-synthetic-private-token';
const syntheticEmail = 'eventqa-private@example.test';
const originalBody = JSON.stringify({ event: 'search_submit', service: 'hotel', email: syntheticEmail, access_token: syntheticToken });
const handler = async (req, res) => {
  upstreamRequests++;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  originalBodyIntact = Buffer.concat(chunks).toString('utf8') === originalBody;
  originalQueryIntact = new URL(req.url, 'http://127.0.0.1').searchParams.get('access_token') === syntheticToken;
  res.writeHead(204); res.end();
};
const upstream = secure ? https.createServer(upstreamTls, handler) : http.createServer(handler);
const upstreamPort = await listen(upstream);
const collector = new ProxyCollector({
  command, port: proxyPort, runDir,
  endpointPatterns: ['^127\\.0\\.0\\.1/synthetic/g/collect$'],
  onEvent: event => events.push(event),
  onStatus: status => statuses.push(status),
  ...(secure ? { upstreamCaFile: upstreamTls.caFile } : {}),
});
let outcome;
try {
  await collector.start({ id: 'PROXY-SMOKE' });
  const requestPath = `/synthetic/g/collect?en=search_submit&access_token=${syntheticToken}`;
  const target = `${secure ? 'https' : 'http'}://127.0.0.1:${upstreamPort}${requestPath}`;
  const statusCode = secure ? await new Promise((resolve, reject) => {
    const connect = http.request({ hostname: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: `127.0.0.1:${upstreamPort}` });
    connect.setTimeout(10000, () => connect.destroy(new Error('LOCAL_PROXY_CONNECT_TIMEOUT')));
    connect.once('error', reject);
    connect.once('connect', async (response, socket) => {
      if (response.statusCode !== 200) { socket.destroy(); reject(new Error(`CONNECT_HTTP_${response.statusCode}`)); return; }
      try {
        // This CA is scoped to this TLS socket. OS trust and global TLS settings stay unchanged.
        const ca = await fs.readFile(path.join(runDir, 'mitm-config', 'mitmproxy-ca-cert.pem'));
        const secureSocket = tls.connect({ socket, servername: 'localhost', ca, rejectUnauthorized: true });
        secureSocket.setTimeout(10000, () => secureSocket.destroy(new Error('LOCAL_PROXY_TLS_TIMEOUT')));
        let responseText = '';
        secureSocket.once('error', reject);
        secureSocket.once('secureConnect', () => secureSocket.write(`POST ${requestPath} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(originalBody)}\r\nReferer: https://hotel.example/search?token=${syntheticToken}\r\nConnection: close\r\n\r\n${originalBody}`));
        secureSocket.on('data', chunk => { responseText += chunk.toString('utf8'); });
        secureSocket.once('end', () => {
          const match = /^HTTP\/1\.[01] (\d{3})/.exec(responseText);
          if (!match) reject(new Error('INVALID_HTTPS_SMOKE_RESPONSE')); else resolve(Number(match[1]));
        });
      } catch (error) { socket.destroy(); reject(error); }
    });
    connect.end();
  }) : await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port: proxyPort, method: 'POST', path: target,
      headers: { Host: `127.0.0.1:${upstreamPort}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(originalBody), Referer: `http://hotel.example/search?token=${syntheticToken}` },
    }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    request.setTimeout(10000, () => request.destroy(new Error('LOCAL_PROXY_SMOKE_TIMEOUT')));
    request.once('error', reject);
    request.end(originalBody);
  });
  const deadline = Date.now() + 5000;
  while (!events.some(event => event.network?.phase === 'response') && Date.now() < deadline) await sleep(100);
  await collector.stop();
  assert.equal(statusCode, 204, 'Synthetic upstream response must pass through');
  assert.equal(upstreamRequests, 1, 'Exactly one original request, with no replay');
  assert.equal(originalBodyIntact, true, 'Capture must not mutate request payload');
  assert.equal(originalQueryIntact, true, 'Capture must not mutate request URL');
  const requestEvents = events.filter(event => event.network?.phase === 'request');
  const responseEvents = events.filter(event => event.network?.phase === 'response');
  assert.equal(requestEvents.length, 1, 'Exactly one request evidence record');
  assert.equal(responseEvents.length, 1, 'Exactly one response evidence record');
  assert.equal(requestEvents[0].event_name, 'search_submit');
  assert.equal(responseEvents[0].network.status, 204);
  assert.equal(requestEvents[0].network.request_id, responseEvents[0].network.request_id);
  const serialized = JSON.stringify(events);
  const persisted = await fs.readFile(path.join(runDir, 'proxy_events.jsonl'), 'utf8');
  for (const secret of [syntheticToken, syntheticEmail, encodeURIComponent(syntheticEmail)]) {
    assert.ok(!serialized.includes(secret), 'Emitted evidence must be redacted');
    assert.ok(!persisted.includes(secret), 'JSONL must be redacted before persistence');
  }
  outcome = {
    tested_at: new Date().toISOString(), result: 'PASS',
    transport: `real mitmdump + synthetic local ${secure ? 'HTTPS' : 'HTTP'} upstream`,
    upstream_requests: upstreamRequests, request_evidence: requestEvents.length, response_evidence: responseEvents.length,
    response_status: statusCode, request_body_preserved: originalBodyIntact, request_url_preserved: originalQueryIntact,
    secrets_redacted_in_events_and_jsonl: true,
    os_ca_changed: false, system_proxy_changed: false, external_business_requests: 0,
    ...(secure ? { tls_certificate_verification: true, client_ca_scope: 'single Node TLS socket', upstream_ca_scope: 'single mitmdump instance' } : {}),
    limitations: secure ? ['Browser/OS certificate trust configuration is environment-specific and was not changed or tested.'] : ['HTTPS interception and browser certificate trust were not tested by this HTTP smoke.'],
    events, statuses,
  };
  await fs.writeFile(path.join(runDir, 'observations.json'), JSON.stringify(outcome, null, 2));
  console.log(JSON.stringify({ result: outcome.result, upstream_requests: upstreamRequests, request_evidence: requestEvents.length, response_evidence: responseEvents.length, observations: path.join(runDir, 'observations.json') }, null, 2));
} catch (error) {
  await collector.stop().catch(() => {});
  await fs.writeFile(path.join(runDir, 'observations.json'), JSON.stringify({ tested_at: new Date().toISOString(), result: 'FAIL', reason: error.message, upstream_requests: upstreamRequests, events, statuses }, null, 2));
  throw error;
} finally {
  await close(upstream);
}
