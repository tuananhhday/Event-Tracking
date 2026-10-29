import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, open, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import net from 'node:net';
import { X509Certificate, createHash } from 'node:crypto';
import { decodeRequest, DEFAULT_ENDPOINT_PATTERNS } from '../core/decoder.mjs';
import { redact, redactUrl } from '../core/privacy.mjs';

// Same regex subject as CDP: hostname + pathname, excluding query and fragment.
export const DEFAULT_PROXY_PATTERNS = [...DEFAULT_ENDPOINT_PATTERNS];

function transform(record, requests) {
  const phase = record.phase ?? record.record_type ?? 'request';
  const id = String(record.request_id ?? record.id ?? 'unknown');
  if (phase === 'request') {
    let events = decodeRequest({
      url: record.url ?? '', body: record.body ?? '',
      contentType: record.content_type ?? '', method: record.method ?? 'POST', requestId: id,
      pageUrl: record.page_url,
    });
    if (!Array.isArray(events)) events = [];
    if (!events.length) events = [{ source: 'CUSTOM', layer: 'TRACKING_REQUEST', event_name: 'UNPARSED', payload: { decode_status: 'UNPARSED', raw_hash: record.raw_hash, reason: record.reason ?? 'unsupported_format' } }];
    events = events.map(event => redact({
      ...event,
      ...(record.decode_status === 'UNPARSED' ? { payload: { ...event.payload, decode_status: 'UNPARSED', raw_hash: record.raw_hash, content_type: record.content_type, reason: record.reason ?? 'unsupported_format' } } : {}),
      captured_at: record.captured_at ?? new Date().toISOString(),
      page: event.page ?? { url: redactUrl(record.url ?? '') },
      network: { ...event.network, request_id: id, url: redactUrl(record.url ?? ''), method: record.method ?? 'POST', phase: 'request', ...(record.decode_status === 'UNPARSED' ? { decode_status: 'UNPARSED' } : {}) },
      privacy: { redacted: true },
    }));
    requests.set(id, events);
    if (requests.size > 10000) requests.delete(requests.keys().next().value);
    return events;
  }
  if (!['response', 'failed', 'error'].includes(phase)) return [];
  const originals = requests.get(id) ?? [{ source: 'CUSTOM', layer: 'TRACKING_REQUEST', event_name: '__network_response', captured_at: record.captured_at, page: { url: record.url ?? '' }, payload: {} }];
  requests.delete(id);
  return originals.map(event => redact({
    ...event,
    network: { ...event.network, request_id: id, url: redactUrl(record.url ?? event.network?.url ?? ''), phase: phase === 'response' ? 'response' : 'failed', ...(record.status != null ? { status: record.status } : {}), ...(phase !== 'response' ? { error: record.error ?? 'REQUEST_FAILED' } : {}) },
    privacy: { redacted: true },
  }));
}

/** Read only; never replay captured traffic. Malformed/truncated records are counted. */
export async function importProxyJsonl(filePath, onEvent) {
  const requests = new Map();
  const summary = { records: 0, events: 0, errors: 0 };
  const content = await readFile(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid record');
      const events = transform(record, requests);
      summary.records++;
      for (const event of events) { await onEvent(event); summary.events++; }
    } catch { summary.errors++; }
  }
  return summary;
}

/** Launches only its own mitmdump instance. No system proxy, trust store, raw flow dump or replay. */
export class ProxyCollector {
  constructor({ onEvent, onStatus = () => {}, endpointPatterns = DEFAULT_PROXY_PATTERNS, port = 8080, runDir, command, upstreamCaFile, confDir } = {}) {
    if (typeof onEvent !== 'function') throw new Error('ProxyCollector requires onEvent');
    if (!Number.isInteger(Number(port)) || Number(port) < 1024 || Number(port) > 65535) throw new Error('Proxy port must be 1024..65535');
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.endpointPatterns = endpointPatterns;
    this.port = Number(port);
    this.runDir = runDir;
    const projectCommand = fileURLToPath(new URL(process.platform === 'win32' ? '../../.venv-proxy/Scripts/mitmdump.exe' : '../../.venv-proxy/bin/mitmdump', import.meta.url));
    this.command = command || (existsSync(projectCommand) ? projectCommand : 'mitmdump');
    this.upstreamCaFile = upstreamCaFile;
    // A stable confdir keeps one CA across sessions; default stays per run.
    this.confDir = confDir;
    this.process = null;
    this.requests = new Map();
    this.offset = 0;
    this.pending = '';
    this.decoder = new StringDecoder('utf8');
    this.polling = null;
    this.reading = false;
    this.tailPromise = Promise.resolve();
  }

  async start(session = {}) {
    if (this.process) throw new Error('Proxy collector already started');
    this.runDir = path.resolve(this.runDir ?? session.runDir ?? session.run_dir ?? path.join('runs', session.id ?? session.session_id ?? `proxy-${Date.now()}`));
    await mkdir(this.runDir, { recursive: true });
    this.output = path.join(this.runDir, 'proxy_events.jsonl');
    this.offset = 0; this.pending = ''; this.requests.clear(); this.decoder = new StringDecoder('utf8');
    try { await access(this.output); this.offset = (await stat(this.output)).size; } catch { /* created by addon */ }
    for (const pattern of this.endpointPatterns) new RegExp(pattern, 'i');
    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', () => reject(new Error('PROXY_PORT_UNAVAILABLE: Choose a free local port.')));
      probe.listen({ host: '127.0.0.1', port: this.port, exclusive: true }, () => probe.close(resolve));
    });
    const addon = fileURLToPath(new URL('../../proxy/mitm_addon.py', import.meta.url));
    const args = ['--quiet', '--listen-host', '127.0.0.1', '--listen-port', String(this.port), '--set', `confdir=${this.confDir ? path.resolve(this.confDir) : path.join(this.runDir, 'mitm-config')}`, '-s', addon];
    if (this.upstreamCaFile) args.push('--set', `ssl_verify_upstream_trusted_ca=${path.resolve(this.upstreamCaFile)}`);
    const child = spawn(this.command, args, {
      shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, EVENTQA_PROXY_OUTPUT: this.output, EVENTQA_ENDPOINT_PATTERNS: JSON.stringify(this.endpointPatterns) },
    });
    this.process = child;
    // Keep stderr private: mitmdump diagnostics can contain request URLs.
    child.stderr?.resume();
    child.on('exit', (code, signal) => {
      this.onStatus({ level: code === 0 || signal ? 'info' : 'error', message: `mitmdump stopped (${signal ?? code ?? 'unknown'})` });
      if (this.polling) clearInterval(this.polling);
      this.polling = null;
    });
    await new Promise((resolve, reject) => {
      child.once('error', () => { this.process = null; reject(new Error('MITMDUMP_NOT_AVAILABLE: Install mitmproxy and set mitmdump executable path.')); });
      child.once('spawn', resolve);
    });
    // Wait for the child to listen, including first-run CA generation. A fixed
    // short sleep would otherwise report success while the proxy is not ready.
    const deadline = Date.now() + 10000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode == null && child.signalCode == null) {
      ready = await new Promise(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port: this.port });
        socket.setTimeout(200);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => { socket.destroy(); resolve(false); });
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
      });
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready || child.exitCode != null || child.signalCode != null) {
      child.kill('SIGTERM');
      this.process = null;
      throw new Error('MITMDUMP_START_FAILED: Check port availability, endpoint patterns and mitmproxy installation.');
    }
    this.polling = setInterval(() => { this.tailPromise = this.poll().catch(() => this.onStatus({ level: 'error', message: 'Proxy evidence read failed' })); }, 150);
    this.onStatus({ level: 'info', message: `Proxy listening on 127.0.0.1:${this.port}; browser proxy and test CA must be configured explicitly.` });
    return { port: this.port, output: this.output };
  }

  async poll() {
    if (this.reading) return;
    this.reading = true;
    try {
      let size;
      try { size = (await stat(this.output)).size; } catch { return; }
      if (size < this.offset) throw new Error('Proxy evidence file was truncated');
      if (size === this.offset) return;
      const handle = await open(this.output, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(size - this.offset, 4 * 1024 * 1024));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
        this.offset += bytesRead;
        this.pending += this.decoder.write(buffer.subarray(0, bytesRead));
      } finally { await handle.close(); }
      const lines = this.pending.split('\n'); this.pending = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { this.onStatus({ level: 'error', message: 'Invalid proxy evidence line skipped' }); continue; }
        for (const event of transform(record, this.requests)) await this.onEvent(event);
      }
    } finally { this.reading = false; }
  }

  async stop() {
    if (this.polling) clearInterval(this.polling);
    this.polling = null;
    const child = this.process;
    if (child && child.exitCode == null && child.signalCode == null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      let timeout;
      await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000); })]);
      clearTimeout(timeout);
    }
    await this.tailPromise;
    if (this.output) await this.poll();
    this.process = null;
    this.requests.clear();
  }
}

/** SHA-256 of the mitmproxy CA public key; mitmproxy signs every site certificate with this same key. */
export async function proxyCaSpki(confDir, { timeoutMs = 5000 } = {}) {
  const file = path.join(path.resolve(confDir), 'mitmproxy-ca-cert.pem');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const der = new X509Certificate(await readFile(file)).publicKey.export({ type: 'spki', format: 'der' });
      return { file, spki: createHash('sha256').update(der).digest('base64') };
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`PROXY_CA_UNAVAILABLE: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
