// Controlled corporate-network fixture. All sockets stay on loopback; no real
// OpenRouter request or API key is used, and TLS verification remains enabled.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { aiProcessConfig } from '../src/ai/runtime.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-network-smoke-'));
const sockets = new Set(); let server, proxy, local, connects = 0, normalProxyRequests = 0, proxyStatus = 200;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const track = server => server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
async function childCheck(program) {
  const base = { ...process.env };
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS']) delete base[name];
  const config = aiProcessConfig(directory, [], base);
  const child = spawn(config.command, [...config.args.slice(0, 2), '--input-type=module', '-e', program], { ...config.options, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, `Network fixture child failed (${code}); output length ${output.length}, stderr length ${stderr.length}`);
    return JSON.parse(output.trim());
  } finally { clearTimeout(timer); }
}
try {
  const key = path.join(directory, 'fixture-key.pem'), cert = path.join(directory, 'fixture-ca.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=openrouter.example.test', '-addext', 'subjectAltName=DNS:openrouter.example.test', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  assert.equal(generated.status, 0, 'OpenSSL is required for the local TLS fixture');
  server = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ local_fixture: true })); });
  server.on('tlsClientError', () => {}); track(server); await listen(server);
  local = http.createServer((_req, res) => res.end('LOCAL_CDP')); track(local); await listen(local);
  proxy = http.createServer((_req, res) => { normalProxyRequests++; res.writeHead(418); res.end('Local app should bypass proxy'); }); track(proxy);
  proxy.on('connect', (request, client, head) => {
    connects++;
    if (request.url !== 'openrouter.example.test:443') { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    if (proxyStatus !== 200) { client.end(`HTTP/1.1 ${proxyStatus} Proxy rejection\r\nConnection: close\r\n\r\n`); return; }
    const upstream = net.connect(server.address().port, '127.0.0.1'); sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
    upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.once('close', () => upstream.destroy());
  }); await listen(proxy);
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const moduleUrl = pathToFileURL(fileURLToPath(new URL('../src/ai/network.mjs', import.meta.url))).href;
  const program = `import {networkFailure,networkRuntime} from ${JSON.stringify(moduleUrl)}; try {const r=await fetch("https://openrouter.example.test/api/v1/models",{signal:AbortSignal.timeout(4000)}); const data=await r.json(); const health=await(await fetch("http://127.0.0.1:${local.address().port}/health")).text(); console.log(JSON.stringify({success:data.local_fixture===true,health,network:networkRuntime()}));} catch(error){console.log(JSON.stringify(networkFailure(error)));}`;
  await fs.writeFile(path.join(directory, '.env'), `HTTPS_PROXY=${proxyUrl}\nHTTP_PROXY=${proxyUrl}\n`);
  assert.equal((await childCheck(program)).reason, 'OPENROUTER_TLS_ERROR', 'The untrusted fixture CA must fail TLS validation');
  await fs.writeFile(path.join(directory, '.env'), `HTTPS_PROXY=${proxyUrl}\nHTTP_PROXY=${proxyUrl}\nNODE_EXTRA_CA_CERTS=${cert}\n`);
  const success = await childCheck(program); assert.equal(success.success, true); assert.equal(success.health, 'LOCAL_CDP');
  assert.equal(success.network.system_ca_enabled, true); assert.equal(success.network.env_proxy_enabled, true);
  proxyStatus = 407; assert.equal((await childCheck(program)).reason, 'OPENROUTER_PROXY_AUTH_REQUIRED');
  proxyStatus = 403; assert.equal((await childCheck(program)).reason, 'OPENROUTER_PROXY_BLOCKED');
  assert.equal(normalProxyRequests, 0); assert.ok(connects >= 4);
  console.log(JSON.stringify({ result: 'PASS', network: 'LOCAL_SIMULATION', httpsThroughProxy: true, untrustedCaRejected: true, trustedCaAccepted: true, localCdpBypassesProxy: true, proxy407Detected: true, proxy403Detected: true }, null, 2));
} finally {
  for (const socket of sockets) socket.destroy();
  await Promise.all([server, proxy, local].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(directory).startsWith('eventqa-network-smoke-'));
  await fs.rm(directory, { recursive: true, force: true });
}
