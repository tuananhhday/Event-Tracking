import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenRouterClient } from '../src/ai/openrouter.mjs';
import { networkFailure } from '../src/ai/network.mjs';
import { aiProcessConfig } from '../src/ai/runtime.mjs';

const failure = code => new TypeError('fetch failed: http://person:PRIVATE_PROXY_PASSWORD@internal.example', { cause: Object.assign(new Error('PRIVATE_TRANSPORT_DETAIL'), { code }) });
const model = id => ({ id, supported_parameters: ['response_format'], architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0', request: '0' }, context_length: 64000 });
const reply = data => ({ ok: true, status: 200, json: async () => data });

test('classifies nested transport errors using fixed codes without exposing raw messages or internal addresses', () => {
  for (const [code, reason] of [['SELF_SIGNED_CERT_IN_CHAIN', 'TLS_ERROR'], ['ENOTFOUND', 'DNS_ERROR'], ['ECONNREFUSED', 'NETWORK_UNREACHABLE'], ['ECONNRESET', 'CONNECTION_RESET'], ['UND_ERR_CONNECT_TIMEOUT', 'TIMEOUT']]) {
    const result = networkFailure(new AggregateError([failure(code)]));
    assert.equal(result.reason, `OPENROUTER_${reason}`); assert.equal(result.code, code);
    assert.ok(!JSON.stringify(result).includes('PRIVATE_') && !JSON.stringify(result).includes('internal.example'));
  }
  assert.equal(networkFailure(new Error('Proxy response (407) !== 200')).reason, 'OPENROUTER_PROXY_AUTH_REQUIRED');
  assert.equal(networkFailure(new Error('Proxy response (403) !== 200')).reason, 'OPENROUTER_PROXY_BLOCKED');
});

test('certificate failures do not rotate keys or retry a permanent network error; successful retry clears diagnostics', async () => {
  let calls = 0, blocked = true;
  const client = new OpenRouterClient({ enabled: true, apiKey: 'PRIVATE_API_KEY', maxRetries: 2, fetch: async () => { calls++; if (blocked) throw failure('SELF_SIGNED_CERT_IN_CHAIN'); return reply({ data: [model('test/free')] }); } });
  assert.equal((await client.listModels()).reason, 'OPENROUTER_TLS_ERROR'); assert.equal(calls, 1);
  const diagnostics = client.diagnostics(); assert.equal(diagnostics.network.last_error.code, 'SELF_SIGNED_CERT_IN_CHAIN');
  assert.ok(diagnostics.keys.every(key => key.available)); assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE_'));
  blocked = false; assert.equal((await client.listModels()).available, true); assert.equal(client.diagnostics().network.last_error, null);
});

test('completion preserves the connection cause and stops trying other models for the same network failure', async () => {
  let completions = 0;
  const client = new OpenRouterClient({ enabled: true, apiKey: 'test-key', modelExplain: 'auto', maxRetries: 0, fetch: async url => {
    if (url.endsWith('/models')) return reply({ data: [model('first/free'), model('second/free')] });
    completions++; throw failure('ENOTFOUND');
  } });
  const result = await client.explain({ verdict: 'FAIL' });
  assert.equal(result.reason, 'OPENROUTER_DNS_ERROR'); assert.equal(completions, 1); assert.equal(client.diagnostics().last_trace.length, 1);
});

test('a non-JSON response is reported as an API response problem without exposing its contents', async () => {
  const client = new OpenRouterClient({ enabled: true, apiKey: 'test-key', maxRetries: 0, fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('PRIVATE_BLOCK_PAGE'); } }) });
  assert.equal((await client.listModels()).reason, 'OPENROUTER_RESPONSE_ERROR'); assert.ok(!JSON.stringify(client.diagnostics()).includes('PRIVATE_BLOCK_PAGE'));
});

test('AI launcher loads proxy/CA before startup, preserves existing environment and keeps local CDP off the proxy', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-network-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, '.env'), 'HTTPS_PROXY=http://user:PRIVATE_PROXY_PASSWORD@proxy.example:8080\nNODE_EXTRA_CA_CERTS=C:/CompanyCA/root.pem\nNO_PROXY=.internal.example\nAI_ENABLED=true\n');
  const config = aiProcessConfig(directory, ['--port', '4419'], { RUNTIME_AUTH_GUARD: 'preserved', AI_ENABLED: 'false' });
  assert.ok(config.args.includes('--use-env-proxy') && config.args.includes('--use-system-ca'));
  assert.equal(config.options.env.AI_ENABLED, 'false'); assert.equal(config.options.env.RUNTIME_AUTH_GUARD, 'preserved');
  assert.equal(config.options.env.NODE_EXTRA_CA_CERTS, 'C:/CompanyCA/root.pem');
  for (const variable of ['NO_PROXY', 'no_proxy']) for (const host of ['localhost', '127.0.0.1', '::1', '.internal.example']) assert.ok(config.options.env[variable].split(',').includes(host));
  await fs.writeFile(path.join(directory, '.env'), 'HTTPS_PROXY=socks://user:PRIVATE_PROXY_PASSWORD@proxy.example\n');
  assert.throws(() => aiProcessConfig(directory, [], {}), error => error.message.includes('HTTPS_PROXY') && !error.message.includes('PRIVATE_PROXY_PASSWORD'));
  await fs.writeFile(path.join(directory, '.env'), 'HTTPS_PROXY=http://proxy.example/settings.pac\n');
  assert.throws(() => aiProcessConfig(directory, [], {}), /PAC/);
});
