import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiPrivacy, AI_PRIVACY } from '../src/ai/privacy.mjs';
import { OpenRouterClient } from '../src/ai/openrouter.mjs';
import { redact } from '../src/core/privacy.mjs';

const token = /^\[PII:[a-f0-9]{64}\]$/;
test('AI pseudonyms are stable within one client, differ for other data/clients, and never mutate input', () => {
  const privacy = createAiPrivacy(), other = createAiPrivacy();
  const input = { email: 'synthetic@example.test', nested: { email_address: 'synthetic@example.test' }, phone: '0908123456', user_id: 12345 };
  const before = structuredClone(input), result = privacy.sanitize(input);
  assert.match(result.email, token); assert.match(result.phone, token); assert.match(result.user_id, token);
  assert.equal(result.email, result.nested.email_address); assert.deepEqual(privacy.sanitize(input), result);
  assert.notEqual(other.sanitize(input).email, result.email); assert.notEqual(privacy.sanitize({ email: 'other@example.test' }).email, result.email);
  assert.deepEqual(privacy.sanitize(result), result); assert.deepEqual(input, before);
  assert.notEqual(privacy.sanitize({ user_id: '12345' }).user_id, result.user_id, 'original number/string types stay distinguishable');
  privacy.close(); assert.throws(() => privacy.sanitize(input), /closed/); other.close();
});

test('sensitive field rules and issue paths keep their structure while personal literals are hashed and credentials masked', () => {
  const privacy = createAiPrivacy();
  const result = privacy.sanitize({ fullName: 'Synthetic Guest', passportNumber: 'PASSPORT-TEST', customer: { name: 'Synthetic Guest' },
    product: { name: 'Hotel room' }, name: 'Test checkout', event_name: 'purchase', orderCode: 'ORDER-01',
    password: 'SYNTHETIC-PASSWORD', authToken: 'SYNTHETIC-TOKEN', fields: {
      'event_params.email': { op: 'eq', value: 'synthetic@example.test' }, 'guest.phone': { op: 'type', value: 'string' },
      'guest.firstName': { op: 'one_of', value: ['Mai', 'Lan'] }, 'customer.user_id': { op: 'ref', value: 'context.customer.user_id' },
    }, issues: [{ field: 'guest.fullName', actual: 'Synthetic Guest', expected: 'Another Guest' },
      { path: 'headers.authorization', actual: 'SYNTHETIC-AUTH', expected: 'SYNTHETIC-AUTH' }] });
  assert.match(result.fullName, token); assert.equal(result.customer.name, result.fullName); assert.match(result.passportNumber, token);
  assert.equal(result.password, '[REDACTED]'); assert.equal(result.authToken, '[REDACTED]');
  assert.equal(result.fields['event_params.email'].op, 'eq'); assert.match(result.fields['event_params.email'].value, token);
  assert.deepEqual(result.fields['guest.phone'], { op: 'type', value: 'string' });
  assert.ok(result.fields['guest.firstName'].value.every(value => token.test(value)));
  assert.deepEqual(result.fields['customer.user_id'], { op: 'ref', value: 'context.customer.user_id' });
  assert.equal(result.issues[0].actual, result.fullName); assert.match(result.issues[0].expected, token);
  assert.equal(result.issues[1].actual, '[REDACTED]');
  assert.equal(result.product.name, 'Hotel room'); assert.equal(result.name, 'Test checkout'); assert.equal(result.event_name, 'purchase'); assert.equal(result.orderCode, 'ORDER-01');
  privacy.close();
});

test('raw JSON, JavaScript samples, labelled text and encoded URL values cannot bypass the AI privacy boundary', () => {
  const privacy = createAiPrivacy();
  const input = {
    sample: JSON.stringify({ event: 'purchase', customerName: 'Synthetic Guest', email: 'synthetic@example.test', secret: 'SYNTHETIC-SECRET' }),
    js: "dataLayer.push({event: 'purchase', customer_id: 'CUSTOMER-TEST', fullName: 'Synthetic Guest'});",
    requirement: 'Họ và tên: Synthetic Guest; email: synthetic@example.test; điện thoại: 0908123456',
    url: 'https://example.test/users/CUSTOMER-TEST?email=synthetic%40example.test&access_token=SYNTHETIC-SECRET#email=synthetic%40example.test',
    nestedUrl: 'https://example.test/redirect?next=' + encodeURIComponent('https://example.test/profile?phone=0908123456'),
    file: 'C:\\Users\\SYNTHETIC-USERNAME\\Downloads\\spec.xlsx',
    byEmail: { 'synthetic@example.test': { event: 'page_view' } },
    authText: "password='SYNTHETIC PASSWORD WITH SPACES'; Authorization: Basic c3ludGhldGljOnNlY3JldA==",
    email: '[REDACTED]', already: '[PII:' + 'a'.repeat(64) + ']',
  };
  const result = privacy.sanitize(input), serialized = JSON.stringify(result);
  for (const raw of ['Synthetic Guest', 'synthetic@example.test', 'synthetic%40example.test', 'CUSTOMER-TEST', 'SYNTHETIC-SECRET', '0908123456', 'SYNTHETIC-USERNAME', 'SYNTHETIC PASSWORD WITH SPACES', 'c3ludGhldGljOnNlY3JldA==']) assert.ok(!serialized.includes(raw), raw);
  assert.match(JSON.parse(result.sample).customerName, token);
  assert.equal(result.email, '[REDACTED]'); assert.equal(result.already, input.already);
  assert.ok(result.js.includes('purchase') && result.js.includes('customer_id'));
  const sameGuest = privacy.sanitize({ fullName: 'Synthetic Guest', email: 'synthetic@example.test' });
  assert.ok(result.js.includes(sameGuest.fullName)); assert.ok(result.js.endsWith('});'));
  assert.equal(new URL(result.url).searchParams.get('email'), sameGuest.email);
  privacy.close();
});

test('AI-only protection leaves the existing local redaction and business comparison values unchanged', () => {
  const input = { event: 'purchase', customerId: 'CUSTOMER-TEST', guestName: 'Synthetic Guest', email: 'synthetic@example.test' };
  const stored = redact(input), privacy = createAiPrivacy(), sent = privacy.sanitize(stored);
  assert.equal(stored.customerId, 'CUSTOMER-TEST'); assert.equal(stored.guestName, 'Synthetic Guest'); assert.equal(stored.email, '[REDACTED]');
  assert.match(sent.customerId, token); assert.match(sent.guestName, token); assert.equal(sent.email, '[REDACTED]'); assert.equal(sent.event, 'purchase');
  privacy.close();
});

test('AI completion sends pseudonyms on the actual transport, preserves caching, and exposes only fixed privacy metadata', async () => {
  const calls = [], model = { id: 'test/model', supported_parameters: ['response_format'], architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' }, context_length: 32768 };
  const client = new OpenRouterClient({ enabled: true, apiKey: 'SYNTHETIC-API-KEY', modelExplain: 'test/model', maxRetries: 0, fetch: async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => url.endsWith('/models') ? { data: [model] } : { choices: [{ message: { content: JSON.stringify({ summary: 'Đã đọc kết quả công cụ.', correct: [], wrong: [], missing: [], problems: [], next_steps: [] }) } }] } };
  } });
  const input = { requirement: 'Họ và tên: Synthetic Guest; email: synthetic@example.test', rows: [{ email: 'synthetic@example.test', fullName: 'Synthetic Guest', password: 'SYNTHETIC-PASSWORD' }] };
  const first = await client.reviewSession(input), cached = await client.reviewSession(input);
  assert.equal(first.available, true); assert.deepEqual(first, cached); assert.equal(calls.length, 2);
  const body = JSON.parse(calls[1].init.body), sent = JSON.parse(body.messages[1].content);
  assert.match(sent.rows[0].email, token); assert.match(sent.rows[0].fullName, token); assert.equal(sent.rows[0].password, '[REDACTED]');
  assert.ok(sent.requirement.includes(sent.rows[0].email) && sent.requirement.includes(sent.rows[0].fullName));
  for (const raw of ['Synthetic Guest', 'synthetic@example.test', 'SYNTHETIC-PASSWORD', 'SYNTHETIC-API-KEY']) assert.ok(!calls[1].init.body.includes(raw));
  assert.deepEqual(client.diagnostics().privacy, AI_PRIVACY); assert.ok(!JSON.stringify(client.diagnostics()).includes(sent.rows[0].email));
  client.close();
});
