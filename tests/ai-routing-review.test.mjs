import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterClient } from '../src/ai/openrouter.mjs';

// Independent routing tests. Every request uses an injected mock and fake keys.
const model = (id, overrides = {}) => ({
  id, name: id, supported_parameters: ['structured_outputs', 'response_format'],
  pricing: { prompt: '0', completion: '0', request: '0' },
  architecture: { input_modalities: ['text'], output_modalities: ['text'], modality: 'text->text' },
  context_length: 64000, expiration_date: null, ...overrides,
});
const priced = (id, prompt, completion, request = '0') => model(id, { pricing: { prompt, completion, request } });
const reply = (data, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => data });
const completion = value => reply({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] });
function transport(catalog, complete = () => completion({ note: 'QC explanation.' })) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    if (url.endsWith('/models')) return reply({ data: catalog });
    assert.ok(url.endsWith('/chat/completions'), 'No other endpoint may be requested');
    const body = JSON.parse(init.body);
    const call = { model: body.model, authorization: init.headers.Authorization, body };
    calls.push(call);
    return complete(call, calls.length);
  };
  return { fetch, calls };
}
function client(fetch, extra = {}) {
  return new OpenRouterClient({ enabled: true, apiKey: 'review-only-fake-key-a', apiKeys: ['review-only-fake-key-a'],
    modelSpec: 'auto', modelExplain: 'auto', allowPaid: true, maxPromptUsdPerMillion: 0.25,
    maxCompletionUsdPerMillion: 1, requestBudgetUsd: 0.01, maxModelAttempts: 4, maxFreeAttempts: 0,
    maxOutputTokens: 200, timeoutMs: 500, maxRetries: 0, delay: async () => {}, fetch, ...extra });
}
const explainInput = () => ({ verdict: 'FAIL', test_case_id: 'TC', issues: [{ code: 'MISSING_FIELD', path: 'destination_id', evidence_id: 'EV-1' }] });
const validDraft = () => ({ id: 'TC-1', name: 'Search', source: 'GA4', flow: 'hotel', needs_review: true,
  rules: [{ event_name: 'search_submit', layer: 'JS_QUEUE', count: { min: 1, max: 1 }, fields: { event: { op: 'eq', value: 'search_submit' } }, needs_review: true }] });

test('routing converts API per-token prices to per-million caps and includes request charges', async () => {
  const mock = transport([priced('paid/exact-cap', '0.00000025', '0.000001', '0.0003'), priced('paid/over-input-cap', '0.000000251', '0.000001')]);
  const result = await client(mock.fetch).listRoutingCandidates({ task: 'spec', inputTokens: 1000, outputTokens: 200 });
  assert.equal(result.available, true);
  assert.deepEqual(result.candidates.map(item => item.id), ['paid/exact-cap']);
  const selected = result.candidates[0];
  assert.equal(selected.prompt_usd_per_million, 0.25);
  assert.equal(selected.completion_usd_per_million, 1);
  assert.ok(Math.abs(selected.estimated_cost_usd - 0.00075) < 1e-12);
  assert.equal(mock.calls.length, 0);
});

test('unknown, blank, null, negative and nonfinite price metadata never qualifies as free', async () => {
  const invalid = [
    model('bad/no-pricing', { pricing: undefined }),
    model('bad/null-request', { pricing: { prompt: '0', completion: '0', request: null } }),
    model('bad/null', { pricing: { prompt: null, completion: '0', request: '0' } }),
    model('bad/blank', { pricing: { prompt: '', completion: '0', request: '0' } }),
    priced('bad/negative:free', '-1', '0'), priced('bad/nan', 'not-a-number', '0'), priced('bad/infinity', '0', 'Infinity'),
  ];
  const mock = transport([...invalid, model('valid/free')]);
  const result = await client(mock.fetch).listRoutingCandidates({ inputTokens: 10, outputTokens: 10 });
  assert.deepEqual(result.candidates.map(item => item.id), ['valid/free']);
  assert.equal(result.candidates[0].free, true);
});

test('catalog excludes nontext, batch, expired and structurally unsupported models', async () => {
  const mock = transport([
    model('bad/image', { architecture: { input_modalities: ['text'], output_modalities: ['image'] } }),
    model('bad/audio-input', { architecture: { input_modalities: ['audio'], output_modalities: ['text'] } }),
    model('bad/batch:batch'), model('bad/expired', { expiration_date: '2000-01-01' }),
    model('bad/unknown-context', { context_length: undefined }), model('bad/unstructured', { supported_parameters: [] }),
    model('valid/text', { expiration_date: '2099-12-31' }),
  ]);
  const result = await client(mock.fetch).listRoutingCandidates({ inputTokens: 10, outputTokens: 10 });
  assert.deepEqual(result.candidates.map(item => item.id), ['valid/text']);
});

test('a free-looking model with a per-request charge is paid and not selected under free-only policy', async () => {
  const mock = transport([priced('vendor/something:free', '0', '0', '0.001'), model('vendor/actually-free')]);
  const result = await client(mock.fetch, { allowPaid: false }).listRoutingCandidates({ inputTokens: 10, outputTokens: 10 });
  assert.deepEqual(result.candidates.map(item => item.id), ['vendor/actually-free']);
});

test('real-style catalog without optional request pricing remains eligible with a zero provider request-fee cap', async () => {
  const mock = transport([model('vendor/real-style', { pricing: { prompt: '0.0000001', completion: '0.0000002' } })]);
  const instance = client(mock.fetch);
  const candidates = await instance.listRoutingCandidates({ inputTokens: 100, outputTokens: 100 });
  assert.equal(candidates.available, true);
  assert.equal(candidates.candidates[0].request_usd, 0);
  assert.equal(candidates.candidates[0].free, false);
  const output = await instance.explain(explainInput());
  assert.equal(output.available, true);
  assert.equal(mock.calls[0].body.provider.max_price.request, 0);
});

test('unevaluated conditional pricing overrides are excluded while an empty override list remains eligible', async () => {
  const mock = transport([
    model('conditional/free', { pricing: { prompt: '0', completion: '0', overrides: [{ min_prompt_tokens: 1, prompt: '0.0001' }] } }),
    model('unconditional/free', { pricing: { prompt: '0', completion: '0', overrides: [] } }),
  ]);
  const result = await client(mock.fetch).listRoutingCandidates({ inputTokens: 100, outputTokens: 100 });
  assert.deepEqual(result.candidates.map(item => item.id), ['unconditional/free']);
});

test('401 and 402 rotate fake keys on the same model instead of selecting a different model', async () => {
  for (const status of [401, 402]) {
    const mock = transport([model('a/free'), model('b/free')], (_call, number) => number === 1 ? reply({ error: { message: 'private provider body' } }, status) : completion({ note: 'Recovered using another configured key.' }));
    const instance = client(mock.fetch, { apiKeys: ['review-only-fake-key-a', 'review-only-fake-key-b'] });
    const output = await instance.explain(explainInput());
    assert.equal(output.available, true);
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[0].model, mock.calls[1].model);
    assert.notEqual(mock.calls[0].authorization, mock.calls[1].authorization);
    const diagnostics = JSON.stringify(instance.diagnostics());
    assert.ok(!diagnostics.includes('review-only-fake-key'));
    assert.ok(!diagnostics.includes('private provider body'));
  }
});

test('exhausted invalid keys stop instead of retrying the catalog with each unusable key', async () => {
  const mock = transport([model('a/free'), model('b/free'), model('c/free')], () => reply({ error: { message: 'secret body' } }, 401));
  const output = await client(mock.fetch, { apiKeys: ['review-only-fake-key-a', 'review-only-fake-key-b'] }).explain(explainInput());
  assert.equal(output.available, false);
  assert.equal(mock.calls.length, 2);
  assert.equal(new Set(mock.calls.map(call => call.model)).size, 1);
});

test('all eligible free models are exhausted before trying the cheapest paid model', async () => {
  const free = Array.from({ length: 20 }, (_, index) => model(`free/model-${String(index).padStart(2, '0')}`));
  const mock = transport([...free, priced('paid/expensive', '0.0000002', '0.0000009'), priced('paid/cheap', '0.0000001', '0.0000002')], call => call.model.startsWith('free/') ? reply({}, 429) : completion({ note: 'Paid fallback succeeded.' }));
  const output = await client(mock.fetch, { maxModelAttempts: 25 }).explain(explainInput());
  assert.equal(output.available, true);
  assert.equal(mock.calls.filter(call => call.model.startsWith('free/')).length, 20);
  assert.equal(mock.calls.at(-1).model, 'paid/cheap');
  assert.equal(mock.calls.length, 21);
  assert.equal(output.routing.free, false);
  assert.equal(output.routing.free_models_attempted, 20);
});

test('schema-invalid and non-JSON responses trigger model fallback before returning a result', async () => {
  for (const bad of ['this is not JSON', { note: 42 }]) {
    const mock = transport([model('a/free'), model('b/free')], (_call, number) => number === 1 ? completion(bad) : completion({ note: 'Valid fallback note.' }));
    const output = await client(mock.fetch).explain(explainInput());
    assert.equal(output.available, true);
    assert.equal(output.note, 'Valid fallback note.');
    assert.equal(mock.calls.length, 2);
    assert.notEqual(mock.calls[0].model, mock.calls[1].model);
  }
});

test('invalid deterministic field-rule schema triggers model fallback for draft generation', async () => {
  const invalid = validDraft();
  invalid.rules[0].fields.event = { op: 'one_of', value: 'not-an-array' };
  const mock = transport([model('a/free'), model('b/free')], (_call, number) => completion(number === 1 ? invalid : validDraft()));
  const output = await client(mock.fetch).draftCase({ description: 'Submit search' });
  assert.equal(output.available, true);
  assert.equal(output.case.needs_review, true);
  assert.equal(mock.calls.length, 2);
  assert.equal(output.case.rules[0].fields.event.op, 'eq');
});

test('aggregate paid fallback reservations cannot exceed one-operation estimated budget', async () => {
  const mock = transport([priced('paid/a', '0', '0', '0.006'), priced('paid/b', '0', '0', '0.006')], () => completion('invalid JSON after a billable completion'));
  const output = await client(mock.fetch, { requestBudgetUsd: 0.01 }).explain(explainInput());
  assert.equal(output.available, false);
  assert.equal(mock.calls.length, 1, 'Second billed fallback would exceed the aggregate budget');
});

test('eligible candidate fallback terminates within configured model-attempt cap', async () => {
  const mock = transport(Array.from({ length: 20 }, (_, index) => model(`free/model-${index}`)), () => reply({}, 503));
  const output = await client(mock.fetch, { maxModelAttempts: 3, maxFreeAttempts: 3 }).explain(explainInput());
  assert.equal(output.available, false);
  assert.ok(mock.calls.length <= 3);
});

test('invalid range constraints and nonstring regex schemas fall back to a valid draft', async () => {
  for (const field of [
    { op: 'range', value: 'not-an-object' }, { op: 'range', value: {} },
    { op: 'range', value: { min: 5, max: 1 } }, { op: 'range', value: { min: '1', max: 5 } },
    { op: 'regex', value: 12 },
  ]) {
    const invalid = validDraft(); invalid.rules[0].fields.quantity = field;
    const mock = transport([model('a/free'), model('b/free')], (_call, number) => completion(number === 1 ? invalid : validDraft()));
    const output = await client(mock.fetch).draftCase({ description: 'Submit search' });
    assert.equal(output.available, true);
    assert.equal(mock.calls.length, 2, `Invalid ${field.op} must be rejected before accepting the draft`);
    assert.ok(!Object.hasOwn(output.case.rules[0].fields, 'quantity'));
  }
});

test('global completion HTTP cap includes repeated authentication key rotations', async () => {
  const keys = Array.from({ length: 8 }, (_, index) => `review-fake-key-${index}`);
  const mock = transport([model('a/free'), model('b/free')], () => reply({}, 401));
  const instance = client(mock.fetch, { apiKey: keys[0], apiKeys: keys, maxCompletionRequests: 3 });
  const output = await instance.explain(explainInput());
  assert.equal(output.available, false);
  assert.equal(mock.calls.length, 3);
  assert.equal(instance.diagnostics().max_completion_requests, 3);
});

test('global completion HTTP cap also includes explicit-model server retries', async () => {
  const mock = transport([model('vendor/pinned')], () => reply({}, 503));
  const instance = client(mock.fetch, { modelExplain: 'vendor/pinned', maxRetries: 3, maxCompletionRequests: 2 });
  const output = await instance.explain(explainInput());
  assert.equal(output.available, false);
  assert.equal(mock.calls.length, 2);
});

test('provider errors carried inside HTTP 200 trigger safe model fallback', async () => {
  const mock = transport([model('a/free'), model('b/free')], (_call, number) => number === 1 ? reply({ error: { code: 503, message: 'private provider body' } }) : completion({ note: 'Valid after provider error.' }));
  const instance = client(mock.fetch);
  const output = await instance.explain(explainInput());
  assert.equal(output.available, true);
  assert.equal(mock.calls.length, 2);
  assert.ok(!JSON.stringify(instance.diagnostics()).includes('private provider body'));
});

test('forbidden policy/permission responses stop without cycling models or keys', async () => {
  const mock = transport([model('a/free'), model('b/free')], () => reply({ error: { message: 'private forbidden details' } }, 403));
  const instance = client(mock.fetch, { apiKeys: ['review-only-fake-key-a', 'review-only-fake-key-b'] });
  const result = await instance.explain(explainInput());
  assert.equal(result.available, false);
  assert.equal(result.reason, 'OPENROUTER_HTTP_403');
  assert.equal(mock.calls.length, 1);
  assert.ok(!JSON.stringify(instance.diagnostics()).includes('private forbidden details'));
});

test('insufficient paid credits do not disable the same key for a subsequent free request', async () => {
  let freeCalls = 0;
  const mock = transport([model('free/a'), priced('paid/b', '0.0000001', '0.0000002')], call => {
    if (call.model === 'paid/b') return reply({}, 402);
    freeCalls++;
    return freeCalls === 1 ? reply({}, 503) : completion({ note: 'Free model remains usable.' });
  });
  const instance = client(mock.fetch, { cooldownMs: 0 });
  assert.equal((await instance.explain(explainInput())).available, false);
  const second = await instance.explain({ ...explainInput(), test_case_id: 'TC-SECOND' });
  assert.equal(second.available, true);
  assert.deepEqual(mock.calls.map(call => call.model), ['free/a', 'paid/b', 'free/a']);
  assert.equal(instance.diagnostics().keys[0].available, true);
  assert.equal(instance.diagnostics().keys[0].paid_available, false);
});

test('the model-attempt cap stops without skipping an untried free model to use paid', async () => {
  const mock = transport([model('free/a'), model('free/b'), model('free/c'), priced('paid/d', '0.0000001', '0.0000002')], call => call.model.startsWith('free/') ? reply({}, 429) : completion({ note: 'Paid fallback reached.' }));
  const output = await client(mock.fetch, { maxModelAttempts: 3, maxFreeAttempts: 10 }).explain(explainInput());
  assert.equal(output.available, false);
  assert.equal(output.reason, 'AI_MAX_MODEL_ATTEMPTS');
  assert.deepEqual(mock.calls.map(call => call.model), ['free/a', 'free/b', 'free/c']);
});

test('a later free success avoids all paid calls after rate-limit, timeout and invalid JSON', async () => {
  const mock = transport([
    model('free/a'), model('free/b'), model('free/c'), model('free/d'), priced('paid/cheap', '0.0000001', '0.0000002'),
  ], call => {
    if (call.model === 'free/a') return reply({}, 429);
    if (call.model === 'free/b') throw Object.assign(new Error('synthetic timeout'), { name: 'TimeoutError' });
    if (call.model === 'free/c') return completion('invalid JSON');
    return completion({ note: 'Valid from a later free model.' });
  });
  const output = await client(mock.fetch, { maxModelAttempts: 8 }).explain(explainInput());
  assert.equal(output.available, true);
  assert.equal(output.routing.free, true);
  assert.equal(output.routing.reserved_cost_usd, 0);
  assert.deepEqual(mock.calls.map(call => call.model), ['free/a', 'free/b', 'free/c', 'free/d']);
});

test('an explicit free-attempt cap stops instead of spending with free models untried', async () => {
  const mock = transport([model('free/a'), model('free/b'), model('free/c'), priced('paid/cheap', '0.0000001', '0.0000002')], () => reply({}, 503));
  const output = await client(mock.fetch, { maxFreeAttempts: 2 }).explain(explainInput());
  assert.equal(output.available, false);
  assert.equal(output.reason, 'AI_MAX_FREE_ATTEMPTS');
  assert.deepEqual(mock.calls.map(call => call.model), ['free/a', 'free/b']);
});

test('rate-limited free models honor Retry-After and another free model serves the next task', async () => {
  const mock = transport([model('free/a'), model('free/b'), priced('paid/cheap', '0.0000001', '0.0000002')], call => {
    if (call.model !== 'free/a') return completion({ note: 'Another free model is available.' });
    return { ...reply({}, 429), headers: { get: name => name === 'retry-after' ? '120' : null } };
  });
  const instance = client(mock.fetch);
  const started = Date.now();
  assert.equal((await instance.explain(explainInput())).available, true);
  assert.equal((await instance.explain({ ...explainInput(), test_case_id: 'NEXT-TASK' })).available, true);
  assert.deepEqual(mock.calls.map(call => call.model), ['free/a', 'free/b', 'free/b']);
  const cooling = instance.diagnostics().cooling_models;
  assert.equal(cooling.length, 1);
  assert.equal(cooling[0].model, 'free/a');
  assert.ok(Date.parse(cooling[0].retry_at) >= started + 120000);
  instance.modelCooldowns.set('free/a', 0);
  await instance.explain({ ...explainInput(), test_case_id: 'AFTER-COOLDOWN' });
  assert.equal(mock.calls.at(-2).model, 'free/a');
});
