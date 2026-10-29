import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterClient } from '../src/ai/openrouter.mjs';

function mockTransport(replies) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected request');
    if (reply instanceof Error) throw reply;
    return { ok: reply.status == null || reply.status < 400, status: reply.status ?? 200, headers: { get: () => null }, json: async () => reply.data };
  };
  return { calls, fetch };
}
const models = { data: { data: [{ id: 'test/model', supported_parameters: ['response_format'], architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0', request: '0' }, context_length: 32768 }] } };
const completion = data => ({ data: { choices: [{ message: { content: JSON.stringify(data) } }] } });
const config = fetch => ({ enabled: true, apiKey: 'secret-test-key', modelExplain: 'test/model', modelSpec: 'test/model', fetch, maxRetries: 0 });
const draft = () => ({ id: 'TC-1', name: 'Search', source: 'GA4', flow: 'hotel', needs_review: true, rules: [{ event_name: 'search_submit', layer: 'JS_QUEUE', count: { min: 1, max: 1 }, fields: { service: { op: 'eq', value: 'hotel' } }, needs_review: true }] });

test('AI disabled and missing configuration make no network call', async () => {
  let calls = 0;
  const fetch = async () => { calls++; throw new Error('Must not call'); };
  assert.equal((await new OpenRouterClient({ enabled: false, fetch }).explain({ verdict: 'FAIL' })).reason, 'AI_DISABLED');
  assert.equal((await new OpenRouterClient({ enabled: true, apiKey: '', fetch }).listModels()).reason, 'API_KEY_MISSING');
  assert.equal(calls, 0);
});

test('invalid draft input is rejected locally and raw JSON samples are sanitized', async () => {
  const transport = mockTransport([models, completion(draft())]);
  const client = new OpenRouterClient(config(transport.fetch));
  assert.equal((await client.draftCase(null)).reason, 'INVALID_AI_INPUT');
  assert.equal((await client.draftCase('invalid')).reason, 'INVALID_AI_INPUT');
  assert.equal((await client.explain(undefined)).reason, 'INVALID_AI_INPUT');
  const result = await client.draftCase({ sample: '{"event":"login","access_token":"private-secret"}' });
  assert.equal(result.available, true);
  assert.ok(!transport.calls[1].init.body.includes('private-secret'));
});

test('explanation preserves verdict, sanitizes input and caches duplicate requests', async () => {
  const transport = mockTransport([models, completion({ note: 'Thiếu destination_id. Evidence EV-1.' })]);
  const client = new OpenRouterClient(config(transport.fetch));
  const result = { verdict: 'FAIL', issues: [{ code: 'MISSING_FIELD', evidence_id: 'EV-1', actual: { email: 'private@example.com', access_token: 'hidden-token' } }] };
  const snapshot = structuredClone(result);
  const first = await client.explain(result);
  const second = await client.explain(result);
  assert.deepEqual(result, snapshot);
  assert.equal(first.available, true);
  assert.deepEqual(first, second);
  assert.equal(transport.calls.length, 2);
  assert.ok(!transport.calls[1].init.body.includes('private@example.com'));
  assert.ok(!transport.calls[1].init.body.includes('hidden-token'));
  assert.equal(JSON.parse(transport.calls[1].init.body).provider.data_collection, 'deny');
});

test('quota exhaustion is unavailable and provider body is never exposed', async () => {
  const transport = mockTransport([models, { status: 429, data: { error: 'contains-private-secret' } }, { status: 429 }]);
  const delays = [];
  const client = new OpenRouterClient({ ...config(transport.fetch), maxRetries: 1, delay: async ms => delays.push(ms) });
  const result = await client.explain({ verdict: 'FAIL' });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'OPENROUTER_HTTP_429');
  assert.equal(result.routing.completion_requests, 2);
  assert.equal(delays.length, 1);
  assert.ok(!JSON.stringify(result).includes('private-secret'));
});

test('draft rules must be validated and remain under review', async () => {
  const transport = mockTransport([models, completion(draft())]);
  const client = new OpenRouterClient(config(transport.fetch));
  const result = await client.draftCase({ sample: { event: 'search_submit' }, provenance: { file: 'source.xlsx', sheet: 'Spec', row: 7 } });
  assert.equal(result.available, true);
  assert.equal(result.case.needs_review, true);
  assert.equal(result.case.rules[0].needs_review, true);
  assert.equal(result.case.provenance.row, 7);
});

test('AI cannot return an approved case, invalid operator or inverted count', async () => {
  for (const mutation of [value => { value.needs_review = false; }, value => { value.rules[0].fields.service.op = 'eval'; }, value => { value.rules[0].count = { min: 2, max: 1 }; }]) {
    const value = draft(); mutation(value);
    const transport = mockTransport([models, completion(value)]);
    const result = await new OpenRouterClient(config(transport.fetch)).draftCase({});
    assert.equal(result.available, false);
    assert.ok(result.reason.startsWith('INVALID_AI_'));
  }
});

test('PII field rule names survive redaction while sample literals are masked', async () => {
  const value = draft();
  value.rules[0].fields.email = { op: 'eq', value: 'private@example.com' };
  value.rules[0].fields.phone = { op: 'exists' };
  const transport = mockTransport([models, completion(value)]);
  const result = await new OpenRouterClient(config(transport.fetch)).draftCase({});
  assert.equal(result.available, true);
  assert.equal(result.case.rules[0].fields.email.op, 'eq');
  assert.notEqual(result.case.rules[0].fields.email.value, 'private@example.com');
  assert.equal(result.case.rules[0].fields.phone.op, 'exists');
});

test('retired model and unsupported structured-output model are reported without completion', async () => {
  for (const data of [[], [{ id: 'test/model', supported_parameters: [] }]]) {
    const transport = mockTransport([{ data: { data } }]);
    const result = await new OpenRouterClient(config(transport.fetch)).draftCase({});
    assert.equal(result.available, false);
    assert.ok(['MODEL_NOT_FOUND', 'MODEL_STRUCTURED_OUTPUT_UNSUPPORTED'].includes(result.reason));
    assert.equal(transport.calls.length, 1);
  }
});

test('live catalog optional request pricing defaults to zero with a matching provider cap', async () => {
  const item = { ...models.data.data[0], pricing: { prompt: '0.000000029', completion: '0.00000003' } };
  const transport = mockTransport([{ data: { data: [item] } }, completion({ note: 'Valid explanation.' })]);
  const result = await new OpenRouterClient(config(transport.fetch)).explain({ verdict: 'FAIL' });
  assert.equal(result.available, true);
  const provider = JSON.parse(transport.calls[1].init.body).provider;
  assert.equal(provider.max_price.request, 0);
  assert.ok(Math.abs(provider.max_price.prompt - 0.029) < 1e-12);
  assert.ok(Math.abs(provider.max_price.completion - 0.03) < 1e-12);
});

test('reasoning is disabled or minimized using advertised model capabilities', async () => {
  for (const [metadata, expected] of [
    [{ mandatory: false }, { enabled: false, exclude: true }],
    [{ mandatory: true, supported_efforts: ['high', 'medium', 'low'] }, { effort: 'low', exclude: true }],
    [{ mandatory: true, supports_max_tokens: true }, { max_tokens: 128, exclude: true }],
  ]) {
    const item = { ...models.data.data[0], supported_parameters: ['structured_outputs', 'reasoning'], reasoning: metadata };
    const transport = mockTransport([{ data: { data: [item] } }, completion({ note: 'Validated note.' })]);
    const result = await new OpenRouterClient(config(transport.fetch)).explain({ verdict: 'FAIL' });
    assert.equal(result.available, true);
    assert.deepEqual(JSON.parse(transport.calls[1].init.body).reasoning, expected);
  }
});

test('mandatory uncapped reasoning is excluded and empty-content diagnostics contain no hidden text', async () => {
  const base = models.data.data[0];
  const excluded = { ...base, id: 'a/uncapped', reasoning: { mandatory: true }, supported_parameters: ['structured_outputs', 'reasoning'] };
  const first = { ...base, id: 'b/length' };
  const second = { ...base, id: 'c/valid' };
  const transport = mockTransport([{ data: { data: [excluded, first, second] } }, { data: { choices: [{ finish_reason: 'length', message: { content: null, reasoning: 'private internal text' } }], usage: { completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 100 } } } }, completion({ note: 'Validated fallback note.' })]);
  const client = new OpenRouterClient({ ...config(transport.fetch), modelExplain: 'auto', delay: async () => {} });
  const result = await client.explain({ verdict: 'FAIL' });
  assert.equal(result.available, true);
  const diagnostics = client.diagnostics();
  assert.equal(diagnostics.last_trace[0].model, 'b/length');
  assert.equal(diagnostics.last_trace[0].response.finish_reason, 'length');
  assert.equal(diagnostics.last_trace[0].response.content_type, 'null');
  assert.equal(diagnostics.last_trace[0].response.reasoning_tokens, 100);
  assert.ok(!JSON.stringify(diagnostics).includes('private internal text'));
});

test('invalid model JSON never reaches the core rule engine', async () => {
  const transport = mockTransport([models, { data: { choices: [{ message: { content: '```json\n{not json}\n```' } }] } }]);
  const result = await new OpenRouterClient(config(transport.fetch)).draftCase({});
  assert.equal(result.reason, 'INVALID_AI_JSON');
});
