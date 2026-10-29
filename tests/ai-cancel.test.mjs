import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterClient } from '../src/ai/openrouter.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const model = id => ({ id, supported_parameters: ['structured_outputs'], architecture: { input_modalities: ['text'], output_modalities: ['text'] }, context_length: 64000, pricing: { prompt: '0', completion: '0' } });
const response = (data, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => data });
const catalog = response({ data: [model('a/free'), model('b/free')] });
const config = fetch => ({ enabled: true, apiKey: 'fake-cancellation-test-key', apiKeys: [], modelSpec: 'auto', modelExplain: 'auto', maxRetries: 2, fetch });
const input = () => ({ verdict: 'FAIL', issues: [{ code: 'MISSING_FIELD', path: 'destination_id', evidence_id: 'EV-1' }] });

async function promptly(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cancellation did not settle promptly')), 750); })]); }
  finally { clearTimeout(timer); }
}

test('close aborts a pending catalog request and permanently stops all new AI dispatch', async () => {
  const started = deferred(); let calls = 0, signalAborted = false;
  const client = new OpenRouterClient(config(async (_url, init) => {
    calls++; started.resolve();
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => { signalAborted = true; reject(init.signal.reason); }, { once: true }));
  }));
  const pending = client.explain(input());
  await started.promise;
  client.close(); client.close();
  const output = await promptly(pending);
  assert.equal(output.reason, 'AI_CANCELLED');
  assert.equal(signalAborted, true);
  assert.equal((await client.listModels()).reason, 'AI_CANCELLED');
  assert.equal((await client.listRoutingCandidates()).reason, 'AI_CANCELLED');
  assert.equal((await client.draftCase({ description: 'Search' })).reason, 'AI_CANCELLED');
  assert.equal(calls, 1);
  assert.equal(client.diagnostics().closed, true);
  assert.ok(!JSON.stringify(client.diagnostics()).includes('fake-cancellation-test-key'));
});

test('cancel alias aborts a pending completion without trying another model or backup key', async () => {
  const started = deferred(); let completions = 0, signalAborted = false;
  const client = new OpenRouterClient({ ...config(async (url, init) => {
    if (url.endsWith('/models')) return catalog;
    completions++; started.resolve();
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => { signalAborted = true; reject(init.signal.reason); }, { once: true }));
  }), apiKeys: ['fake-backup-key'] });
  const pending = client.explain(input());
  await started.promise; client.cancel();
  const output = await promptly(pending);
  assert.equal(output.available, false);
  assert.equal(output.reason, 'AI_CANCELLED');
  assert.equal(signalAborted, true);
  assert.equal(completions, 1);
  assert.equal(output.routing.completion_requests, 1);
});

test('close interrupts explicit retry backoff and automatic fallback cooldown', async () => {
  for (const explicit of [false, true]) {
    const backoff = deferred(); let completions = 0;
    const never = deferred();
    const client = new OpenRouterClient({ ...config(async url => {
      if (url.endsWith('/models')) return catalog;
      completions++; return response({}, 503);
    }), modelExplain: explicit ? 'a/free' : 'auto', delay: () => { backoff.resolve(); return never.promise; } });
    const pending = client.explain(input());
    await backoff.promise; client.close();
    assert.equal((await promptly(pending)).reason, 'AI_CANCELLED');
    assert.equal(completions, 1, 'No retry or fallback may be dispatched after shutdown');
  }
});

test('close cancels pending response JSON parsing even if a custom transport ignores abort', async () => {
  const parsing = deferred(); const never = deferred(); let completions = 0;
  const client = new OpenRouterClient(config(async url => {
    if (url.endsWith('/models')) return catalog;
    completions++;
    return { ok: true, status: 200, json: () => { parsing.resolve(); return never.promise; } };
  }));
  const pending = client.explain(input());
  await parsing.promise; client.close();
  assert.equal((await promptly(pending)).reason, 'AI_CANCELLED');
  assert.equal(completions, 1);
});

test('a closed client never serves an earlier cached AI result', async () => {
  let completions = 0;
  const client = new OpenRouterClient(config(async url => {
    if (url.endsWith('/models')) return catalog;
    completions++; return response({ choices: [{ message: { content: '{"note":"Previous valid note"}' } }] });
  }));
  assert.equal((await client.explain(input())).available, true);
  client.close();
  assert.equal((await client.explain(input())).reason, 'AI_CANCELLED');
  assert.equal(completions, 1);
});
