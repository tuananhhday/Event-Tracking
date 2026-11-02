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

test('session review sorts the tool verdicts into correct / wrong / missing / problems and rejects malformed answers', async () => {
  const answer = { summary: 'Kiểm luồng Golf: 2 đúng, 1 sai, 1 thiếu.', correct: ['Product Page View · Golf'], wrong: ['Listing Page View · Golf: taxonomy cần golf, thực tế Golf.'],
    missing: ['Search Golf · Golf: chưa thấy (có thể chưa thao tác tới).'], problems: ['Product Page View gửi lặp sau 4,1 s.'], next_steps: ['Dev sửa taxonomy của listing thành golf.'] };
  const transport = mockTransport([models, completion(answer)]);
  const client = new OpenRouterClient(config(transport.fetch));
  const input = { requirement: 'Kiểm tra luồng Golf theo R1511', specification: [{ event: 'listing_page_view', flow: 'Golf' }], coverage: [{ event: 'listing_page_view', status: 'MISMATCH' }],
    sent_events: [{ vendor: 'INSIDER', event: 'Listing Page View', page: '/vi/golf/search', email: 'private@example.com' }], not_sent: [], outside_spec: [], firing_problems: [] };
  const result = await client.reviewSession(input);
  assert.equal(result.available, true);
  assert.deepEqual(result.review, answer);
  const sent = JSON.parse(JSON.parse(transport.calls[1].init.body).messages[1].content);
  assert.equal(sent.requirement, 'Kiểm tra luồng Golf theo R1511');
  assert.ok(!transport.calls[1].init.body.includes('private@example.com'));
  const malformed = new OpenRouterClient(config(mockTransport([models, completion({ summary: 'x' })]).fetch));
  assert.equal((await malformed.reviewSession(input)).available, false);
  assert.equal((await client.reviewSession(null)).reason, 'INVALID_AI_INPUT');
});

test('the session review reads the requirement, the specification rows of the tested flow, the verdicts and what reached the vendors', { timeout: 5000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-review-'));
  let received;
  const stubAI = { diagnostics: () => ({ enabled: true, mock: true }), close() {},
    async reviewSession(input) { received = input; return { available: true, review: { summary: 'ok', correct: ['begin_checkout · Golf: đúng'], wrong: [],
      missing: ['begin_checkout_v2 · Golf: chưa thấy', 'search_submit và begin_checkout: chưa thấy'], problems: [], next_steps: [] } }; } };
  const app = await createApp({ mode: 'cdp-ai', runsDir: dir, port: 0, aiClient: stubAI });
  const plain = await createApp({ mode: 'cdp', runsDir: dir, port: 0, aiClient: stubAI });
  const base = await app.listen(), plainBase = await plain.listen();
  t.after(async () => { await app.close(); await plain.close(); await fs.rm(dir, { recursive: true, force: true }); });
  app.manager.cases = [
    { id: 'TC-SEARCH', name: 'Golf / search_submit', source: 'GA4', flow: 'Golf', description: 'Bấm tìm kiếm sân golf', rules: [{ event_name: 'search_submit', layer: 'JS_QUEUE', count: { min: 1, max: 1 }, fields: { service: { op: 'eq', value: 'golf' } } }] },
    { id: 'TC-CHECKOUT', name: 'Golf / begin_checkout', source: 'GA4', flow: 'Golf', description: 'Bấm thanh toán', rules: [{ event_name: 'begin_checkout', layer: 'JS_QUEUE', count: { min: 1, max: 1 }, fields: {} }] },
    { id: 'TC-HOTEL', name: 'Khách sạn / view_item', source: 'GA4', flow: 'Khách sạn', description: 'Xem khách sạn', rules: [{ event_name: 'view_item', layer: 'JS_QUEUE', count: { min: 1, max: 1 }, fields: {} }] },
  ];
  assert.equal((await post(`${base}/api/ai-review`, app.csrf, {})).status, 400, 'nothing to review before any event');
  app.manager.start({ environment: 'MOCK_ONLY' });
  const page = { url: 'https://vinpearlota.com/vi/golf/search', target_id: 'tab' };
  const at = new Date(Date.now() - 60000).toISOString();
  app.manager.emit({ source: 'GA4', layer: 'JS_QUEUE', queue_name: 'dataLayer', event_name: 'search_submit', captured_at: at, page, payload: { event: 'search_submit', service: 'golf' } });
  app.manager.emit({ source: 'GA4', layer: 'TRACKING_REQUEST', event_name: 'search_submit', captured_at: at, page, network: { phase: 'request' }, payload: { v: '2', tid: 'G-LK3M5B2Y8Y', event: 'search_submit', service: 'golf' } });
  const response = await post(`${base}/api/ai-review`, app.csrf, { requirement: '  Kiểm tra luồng Golf  ' });
  assert.equal(response.status, 200);
  // Correct / wrong / missing follow the tool's verdicts even when the AI sorts a row wrongly; an AI sentence
  // is kept only when it names that one event (not begin_checkout_v2, not two events at once).
  const { review } = await response.json();
  assert.deepEqual([review.correct, review.wrong, review.missing], [['search_submit · Golf'], [], ['begin_checkout · Golf: chưa thấy']]);
  assert.equal(received.requirement, 'Kiểm tra luồng Golf');
  // Rows of the flow the session touched, seen or not; rows of other flows are left out.
  assert.deepEqual(received.coverage.map(row => [row.event, row.status]), [['search_submit', 'MATCH'], ['begin_checkout', 'NOT_SEEN']]);
  assert.deepEqual(received.specification[0].expected_fields, ['service']);
  assert.deepEqual(received.sent_events.map(event => [event.vendor, event.event, event.ga4_property]), [['GA4', 'search_submit', 'G-LK3M5B2Y8Y']]);
  assert.equal((await post(`${plainBase}/api/ai-review`, plain.csrf, {})).status, 400);
});

test('the F12 view lists every dataLayer / InsiderQueue element once, in order, with whether it reached the vendor', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-pushes-'));
  const app = await createApp({ port: 0, runsDir: dir, initialCases: [] });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  app.manager.start({ environment: 'MOCK_ONLY' });
  const iso = ms => new Date(Date.now() - 60000 + ms).toISOString(), tab = { url: 'https://vinpearlota.com/vi', target_id: 'tab' };
  app.manager.emit({ layer: 'JS_QUEUE', source: 'GA4', queue_name: 'dataLayer', queue_index: 0, event_name: 'gtm.js', captured_at: iso(0), page: tab, payload: { event: 'gtm.js', 'gtm.uniqueEventId': 1 } });
  app.manager.emit({ layer: 'JS_QUEUE', source: 'GA4', queue_name: 'dataLayer', queue_index: 1, event_name: 'page_view', captured_at: iso(10), page: tab, payload: { event: 'page_view', 'gtm.uniqueEventId': 4 } });
  const batch = { type: 'custom_event', value: [{ event_name: 'a_b' }, { event_name: 'c_d' }] };
  const custom = { layer: 'JS_QUEUE', source: 'INSIDER', queue_name: 'InsiderQueue', queue_index: 3, queue_type: 'custom_event', queue_payload: batch, captured_at: iso(20), page: tab };
  app.manager.emit({ ...custom, queue_batch_index: 0, event_name: 'a_b', payload: { type: 'custom_event', value: [batch.value[0]] } });
  app.manager.emit({ ...custom, queue_batch_index: 1, event_name: 'c_d', payload: { type: 'custom_event', value: [batch.value[1]] } });
  app.manager.emit({ layer: 'TRACKING_REQUEST', source: 'GA4', event_name: 'page_view', captured_at: iso(900), page: tab, network: { phase: 'request' }, payload: { v: '2', event: 'page_view' } });
  const { pushes, total } = await (await fetch(base + '/api/pushes')).json();
  assert.equal(total, 3);
  assert.deepEqual(pushes.map(p => [`${p.queue_name}[${p.queue_index}]`, p.event_name, p.delivery]), [
    ['InsiderQueue[3]', 'a_b', 'not_sent'], ['dataLayer[1]', 'page_view', 'sent'], ['dataLayer[0]', 'gtm.js', null]]);
  assert.deepEqual(pushes[0].payload, batch, 'one element as F12 shows it, with both events');
  assert.equal(pushes[1].payload['gtm.uniqueEventId'], 4);
});
