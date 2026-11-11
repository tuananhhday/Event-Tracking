import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OpenRouterClient } from '../src/ai/openrouter.mjs';
import { createApp } from '../src/server.mjs';

const models = { data: { data: [{ id: 'test/model', supported_parameters: ['response_format'], architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0', request: '0' }, context_length: 32768 }] } };
const completion = data => ({ data: { choices: [{ message: { content: JSON.stringify(data) } }] } });
function mockTransport(replies) {
  const calls = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, init }); const reply = replies.shift(); if (!reply) throw new Error('Unexpected request'); return { ok: true, status: 200, headers: { get: () => null }, json: async () => reply.data }; } };
}
const config = fetch => ({ enabled: true, apiKey: 'secret-test-key', modelExplain: 'test/model', modelSpec: 'test/model', fetch, maxRetries: 0 });
const post = (url, token, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': token }, body: JSON.stringify(body) });

test('askSession answers in the agreed shape and only points at events it was given', async () => {
  const answer = { answer: 'add_to_cart gửi `value` = 0 trong khi API trả 1.500.000.\n- GA4 và Insider lệch giá.', verdict: 'ISSUES', findings: [
    { note: 'GA4 gửi `value` 0, Insider gửi 1500000: Dev website sửa giá cho GA4.', severity: 'error', event: 'add_to_cart', evidence_id: 'EV-1' },
    { note: 'Không rõ event.', severity: 'info', event: '', evidence_id: 'EV-MADE-UP' }] };
  const transport = mockTransport([models, completion(answer)]);
  const client = new OpenRouterClient(config(transport.fetch));
  const input = { question: 'add_to_cart có hợp lý không?', history: [], focused_on: ['add_to_cart'],
    event_details: [{ id: 'EV-1', vendor: 'GA4', event: 'add_to_cart', params: { value: 0, email: 'private@example.com' } }] };
  const result = await client.askSession(input);
  assert.equal(result.available, true);
  assert.equal(result.verdict, 'ISSUES');
  assert.equal(result.answer, answer.answer);
  assert.deepEqual(result.findings.map(finding => finding.evidence_id), ['EV-1', ''], 'an id the AI invented is dropped');
  const sent = JSON.parse(JSON.parse(transport.calls[1].init.body).messages[1].content);
  assert.equal(sent.question, 'add_to_cart có hợp lý không?');
  assert.ok(!transport.calls[1].init.body.includes('private@example.com'), 'personal data is masked before it leaves');

  const malformed = new OpenRouterClient(config(mockTransport([models, completion({ answer: 'x', verdict: 'MAYBE', findings: [] })]).fetch));
  assert.equal((await malformed.askSession(input)).reason, 'INVALID_AI_ANSWER');
  assert.equal((await client.askSession(null)).reason, 'INVALID_AI_INPUT');
  assert.equal((await client.askSession({ question: '  ' })).reason, 'INVALID_AI_INPUT');
});

test('a question reads the parameters of the events it names, runs beside other actions and keeps a short history', { timeout: 10000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-ask-'));
  const received = [];
  let hold = null;
  const stubAI = { diagnostics: () => ({ enabled: true, configured_key_count: 1 }), close() {},
    async askSession(input) { received.push(input); if (hold) await hold; return { available: true, answer: 'ok', verdict: 'OK', findings: [], routing: { model: 'test/model' } }; },
    async reviewSession() { return { available: true, review: { summary: 'ok', correct: [], wrong: [], missing: [], problems: [], next_steps: [] } }; } };
  const app = await createApp({ mode: 'cdp-ai', runsDir: dir, port: 0, aiClient: stubAI, initialCases: [] });
  const plain = await createApp({ mode: 'cdp', runsDir: dir, port: 0, aiClient: stubAI, initialCases: [] });
  const base = await app.listen(), plainBase = await plain.listen();
  t.after(async () => { await app.close(); await plain.close(); await fs.rm(dir, { recursive: true, force: true }); });

  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /id="ask-ai-q"/, 'the AI edition shows the question bar');
  assert.doesNotMatch(await (await fetch(`${plainBase}/`)).text(), /id="ask-ai-q"/, 'the plain edition has no AI');
  assert.equal((await post(`${plainBase}/api/ai-ask`, plain.csrf, { question: 'x?' })).status, 404);

  assert.equal((await post(`${base}/api/ai-ask`, app.csrf, { question: 'Có hợp lý không?' })).status, 400, 'nothing to ask about before any event');
  app.manager.start({ environment: 'MOCK_ONLY' });
  const tab = { url: 'https://vinpearlota.com/vi/hotel/detail?id=1', target_id: 'tab' };
  const at = ms => new Date(Date.now() - 60000 + ms).toISOString();
  const ga4 = (name, params, ms) => app.manager.emit({ source: 'GA4', layer: 'TRACKING_REQUEST', event_name: name, captured_at: at(ms), page: tab, network: { phase: 'request' }, payload: { v: '2', tid: 'G-TEST1', event: name, ...params } });
  ga4('page_view', {}, 0);
  ga4('listing_page_view', { service: 'hotel' }, 100);
  ga4('add_to_cart', { currency: 'VND', value: 0, item_id: 'ROOM-1' }, 2000);
  ga4('add_to_cart', { currency: 'VND', value: 0, item_id: 'ROOM-1' }, 2600);
  app.manager.emit({ source: 'INSIDER', layer: 'TRACKING_REQUEST', event_name: 'cart_page_view', captured_at: at(2700), page: tab, network: { phase: 'request' }, payload: { event: 'cart_page_view', event_params: { c_currency: 'USD' } } });
  ga4('purchase', { currency: 'VND', value: 1 }, 40000);

  const asked = await post(`${base}/api/ai-ask`, app.csrf, { question: '  Event add_to_cart có hợp lý không?  ' });
  assert.equal(asked.status, 200);
  assert.deepEqual(await asked.json(), { available: true, answer: 'ok', verdict: 'OK', findings: [], routing: { model: 'test/model' } });
  let input = received.at(-1);
  assert.equal(input.question, 'Event add_to_cart có hợp lý không?');
  assert.deepEqual(input.focused_on, ['add_to_cart']);
  const named = input.event_details.filter(event => !event.nearby);
  assert.deepEqual(named.map(event => event.event), ['add_to_cart', 'add_to_cart'], 'the events the question names');
  assert.deepEqual(named[0].params, { currency: 'VND', value: 0, item_id: 'ROOM-1' }, 'the parameters actually sent');
  assert.equal(named[1].repeat_of, named[0].id, 'the second hit is marked as a repeat');
  // Events of the same moment (both vendors) come along to judge conflicts; one 40 s later does not.
  assert.deepEqual(input.event_details.filter(event => event.nearby).map(event => event.vendor).sort(), ['GA4', 'GA4', 'INSIDER']);
  assert.ok(!input.event_details.some(event => event.event === 'purchase'));
  assert.deepEqual(input.event_details.map(event => event.at), [...input.event_details.map(event => event.at)].sort(), 'in time order');
  assert.deepEqual(input.event_counts.find(count => count.event === 'add_to_cart'), { vendor: 'GA4', event: 'add_to_cart', sent: 2, not_sent: 0 });
  assert.ok(Array.isArray(input.sent_events) && Array.isArray(input.price_mismatches), 'the tool verdicts come along');

  await post(`${base}/api/ai-ask`, app.csrf, { question: 'page_view bắn mấy lần?' });
  assert.deepEqual(received.at(-1).event_details.filter(event => !event.nearby).map(event => event.event), ['page_view'], 'page_view does not pick listing_page_view');
  await post(`${base}/api/ai-ask`, app.csrf, { question: 'Có lỗi gì không?', history: Array.from({ length: 6 }, (_, i) => ({ question: `q${i}`, answer: 'a'.repeat(3000) })) });
  input = received.at(-1);
  assert.equal(input.focused_on, 'latest_events');
  assert.equal(input.event_details.length, 6);
  assert.ok(!input.event_details.some(event => event.nearby));
  assert.deepEqual(input.history.map(turn => turn.question), ['q3', 'q4', 'q5'], 'the last three turns');
  assert.equal(input.history[0].answer.length, 1500);

  // While the AI reads, a second question waits its turn but other actions are not blocked.
  let release; hold = new Promise(resolve => { release = resolve; });
  const pending = post(`${base}/api/ai-ask`, app.csrf, { question: 'Có hợp lý không?' });
  while (received.length < 4) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await post(`${base}/api/ai-ask`, app.csrf, { question: 'Câu hỏi khác?' })).status, 409);
  assert.equal((await post(`${base}/api/ai-review`, app.csrf, {})).status, 200, 'the review is not held up by a pending question');
  release(); hold = null;
  assert.equal((await pending).status, 200);

  assert.equal((await post(`${base}/api/ai-ask`, app.csrf, { question: '   ' })).status, 400);
  assert.equal((await post(`${base}/api/ai-ask`, app.csrf, { question: 'x'.repeat(1001) })).status, 400);
  assert.equal((await fetch(`${base}/api/ai-ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"question":"x?"}' })).status, 403, 'the page token is required');
});
