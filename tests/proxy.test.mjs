import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProxyCollector, importProxyJsonl } from '../src/collectors/proxy.mjs';

test('proxy importer decodes request and links response without adding another occurrence', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eventqa-proxy-'));
  try {
    const file = path.join(dir, 'flows.jsonl');
    await writeFile(file, [
      { phase: 'request', request_id: 'R-1', captured_at: '2026-10-29T10:30:00Z', method: 'POST', url: 'https://www.google-analytics.com/g/collect?v=2&en=search_submit', page_url: 'https://hotel.example/search?destination=Phu+Quoc', content_type: 'application/x-www-form-urlencoded', body: 'ep.service=hotel&ep.destination=Phu+Quoc' },
      { phase: 'response', request_id: 'R-1', url: 'https://www.google-analytics.com/g/collect', status: 204 },
      { phase: 'request', request_id: 'R-2', captured_at: '2026-10-29T10:30:01Z', url: 'https://www.google-analytics.com/g/collect?en=purchase' },
      { phase: 'failed', request_id: 'R-2', error: 'PROXY_UPSTREAM_ERROR' },
    ].map(value => JSON.stringify(value)).join('\n') + '\n{truncated');
    const events = [];
    const result = await importProxyJsonl(file, event => events.push(event));
    assert.equal(result.records, 4);
    assert.equal(result.errors, 1);
    assert.equal(events.length, 4);
    assert.equal(events[0].event_name, 'search_submit');
    assert.ok(events[0].page.url.startsWith('https://hotel.example/search'));
    assert.equal(events[0].network.phase, 'request');
    assert.equal(events[1].network.phase, 'response');
    assert.equal(events[1].network.status, 204);
    assert.equal(events[0].captured_at, events[1].captured_at);
    assert.equal(events[3].network.phase, 'failed');
    assert.equal(events.filter(event => event.network.phase === 'request').length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('tail waits for a full JSON line and handles multibyte UTF8', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eventqa-tail-'));
  try {
    const output = path.join(dir, 'events.jsonl');
    const line = JSON.stringify({ phase: 'request', request_id: 'VN', captured_at: '2026-10-29T10:30:00Z', url: 'https://tracking.useinsider.com/event', content_type: 'application/json', body: JSON.stringify({ event: 'search_submit', destination: 'Phú Quốc' }) });
    const encoded = Buffer.from(line + '\n');
    const split = encoded.indexOf(Buffer.from('ú')) + 1;
    await writeFile(output, encoded.subarray(0, split));
    const events = [];
    const collector = new ProxyCollector({ onEvent: event => events.push(event), runDir: dir });
    collector.output = output;
    await collector.poll();
    assert.equal(events.length, 0);
    await appendFile(output, encoded.subarray(split));
    await collector.poll();
    assert.equal(events.length, 1);
    assert.ok(JSON.stringify(events[0]).includes('Phú Quốc'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('proxy startup gives actionable missing mitmdump error without a shell', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eventqa-no-mitm-'));
  try {
    const collector = new ProxyCollector({ onEvent: () => {}, runDir: dir, command: path.join(dir, 'does-not-exist.exe') });
    await assert.rejects(collector.start({ id: 'S-1' }), /MITMDUMP_NOT_AVAILABLE/);
    assert.equal(collector.process, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('proxy JSONL importing sanitizes secrets before passing evidence to storage', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eventqa-redact-'));
  try {
    const file = path.join(dir, 'events.jsonl');
    await writeFile(file, JSON.stringify({ phase: 'request', request_id: 'R-SECRET', url: 'https://www.google-analytics.com/g/collect?en=login&access_token=verysecret&email=private%40example.com', content_type: 'application/json', body: JSON.stringify({ event: 'login', email: 'private@example.com', access_token: 'verysecret' }) }) + '\n');
    const events = [];
    await importProxyJsonl(file, event => events.push(event));
    assert.equal(events.length, 1);
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes('verysecret'));
    assert.ok(!serialized.includes('private@example.com'));
    assert.ok(!serialized.includes('private%40example.com'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
