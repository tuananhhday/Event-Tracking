import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { EvidenceStore } from '../src/core/store.mjs';
import { SessionManager, loadRun } from '../src/core/session.mjs';
import { decodeRequest, matchesEndpoint } from '../src/core/decoder.mjs';
import { redact } from '../src/core/privacy.mjs';
import { createApp } from '../src/server.mjs';
import { importSpec, validateTestCase } from '../src/spec/import.mjs';

const makeTemp = () => fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-core-integration-'));
const makeEvent = (id = 'EV-001', extra = {}) => ({ schema_version: '1.0', evidence_id: id, session_id: 'S-QA-001', test_case_id: 'TC-A', step_id: 'STEP-A', captured_at: '2026-10-29T10:00:00.000Z', source: 'GA4', layer: 'JS_QUEUE', event_name: 'search_submit', page: { url: 'https://example.test/search' }, payload: { event: 'search_submit', destination: 'Phú Quốc' }, ...extra });
const makeCase = (id = 'TC-A', layer = 'JS_QUEUE') => ({ id, name: id, source: 'GA4', rules: [{ event_name: 'search_submit', layer, count: { min: 1, max: 1 }, fields: { event: { op: 'eq', value: 'search_submit' } } }] });

test('JSONL append survives abrupt process exit without store.close', async t => {
  const dir = await makeTemp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const storeModule = pathToFileURL(path.resolve('src/core/store.mjs')).href;
  const code = `import { EvidenceStore } from ${JSON.stringify(storeModule)}; const store = new EvidenceStore(${JSON.stringify(dir)}); store.append(${JSON.stringify(makeEvent())}); process.exit(23);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(child.status, 23, child.stderr);
  const raw = await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8');
  assert.equal(JSON.parse(raw.trim()).payload.destination, 'Phú Quốc');
  const reopened = new EvidenceStore(dir);
  try { assert.equal(reopened.events()[0].evidence_id, 'EV-001'); }
  finally { reopened.close(); }
});

test('recovery keeps multibyte evidence and blank bytes, saves only the torn tail, rebuilds index', async t => {
  const dir = await makeTemp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = new EvidenceStore(dir);
  first.append(makeEvent());
  first.index(makeEvent('EV-GHOST'));
  first.close();
  const original = await fs.readFile(path.join(dir, 'events.jsonl'));
  const tail = Buffer.concat([Buffer.from('{"evidence_id":"EV-TORN","payload":{"destination":"Ph'), Buffer.from('ú').subarray(0, 1)]);
  await fs.appendFile(path.join(dir, 'events.jsonl'), Buffer.concat([Buffer.from('\n'), tail]));
  const reopened = new EvidenceStore(dir);
  try {
    assert.deepEqual(reopened.events().map(event => event.evidence_id), ['EV-001']);
    assert.deepEqual(await fs.readFile(path.join(dir, 'events.torn-tail')), tail);
    assert.deepEqual(await fs.readFile(path.join(dir, 'events.jsonl')), Buffer.concat([original, Buffer.from('\n')]));
    reopened.append(makeEvent('EV-002'));
    assert.equal(reopened.events().length, 2);
  } finally { reopened.close(); }
});

test('valid final JSON without newline is delimited before another append', async t => {
  const dir = await makeTemp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'events.jsonl'), JSON.stringify(makeEvent()));
  const store = new EvidenceStore(dir);
  try { store.append(makeEvent('EV-002')); }
  finally { store.close(); }
  const lines = (await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8')).trim().split('\n');
  assert.deepEqual(lines.map(line => JSON.parse(line).evidence_id), ['EV-001', 'EV-002']);
});

test('step log recovers a durable step missing from session snapshot and repairs torn step tail', async t => {
  const dir = await makeTemp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manager = new SessionManager({ runsDir: dir, cases: [makeCase()] });
  manager.start();
  const durable = { id: 'STEP-DURABLE', test_case_id: 'TC-A', started_at: new Date().toISOString(), context: {}, status: 'RUNNING' };
  manager.store.appendStep(durable);
  manager.store.close();
  await fs.appendFile(path.join(manager.runDir, 'steps.jsonl'), '{partial');
  const loaded = loadRun(manager.runDir);
  assert.equal(loaded.steps[0].id, durable.id);
  assert.equal(await fs.readFile(path.join(manager.runDir, 'steps.torn-tail'), 'utf8'), '{partial');
});

test('association excludes backlog and events older than Start Step, and retains current action timing', async t => {
  const dir = await makeTemp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manager = new SessionManager({ runsDir: dir, cases: [makeCase()] });
  manager.start();
  try {
    const step = manager.startStep('TC-A');
    const base = makeEvent();
    const backlog = manager.emit({ ...base, historical: true, captured_at: step.started_at });
    const older = manager.emit({ ...base, captured_at: new Date(Date.parse(step.started_at) - 1).toISOString() });
    const current = manager.emit({ ...base, captured_at: step.started_at });
    assert.equal(backlog.step_id, null);
    assert.equal(older.step_id, null);
    assert.equal(current.step_id, step.id);
    assert.equal(current.correlation.delta_ms, 0);
    assert.equal(manager.completeStep().verdict, 'PASS');
    assert.equal(manager.snapshot().results.length, 1);
  } finally { manager.abort(); }
});

test('response stays with originating step across next action and target IDs isolate request scopes', async t => {
  const dir = await makeTemp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manager = new SessionManager({ runsDir: dir, cases: [makeCase('TC-A', 'TRACKING_REQUEST'), makeCase('TC-B', 'TRACKING_REQUEST')] });
  manager.start();
  try {
    const first = manager.startStep('TC-A');
    const request = manager.emit({ ...makeEvent(), layer: 'TRACKING_REQUEST', captured_at: first.started_at, page: { target_id: 'TAB-A' }, network: { request_id: 'R-1', phase: 'request' } });
    assert.equal(manager.completeStep().verdict, 'PASS');
    manager.startStep('TC-B');
    const response = manager.emit({ ...request, captured_at: first.started_at, network: { request_id: 'R-1', phase: 'response', status: 204 } });
    const unrelated = manager.emit({ ...request, page: { target_id: 'TAB-B' }, network: { request_id: 'R-1', phase: 'response', status: 204 } });
    assert.equal(response.step_id, first.id);
    assert.equal(unrelated.step_id, null);
    assert.equal(manager.snapshot().results.find(result => result.test_case_id === 'TC-B').verdict, 'REVIEW');
  } finally { manager.abort(); }
});

test('active and interrupted steps remain REVIEW while never-started cases stay NOT_EXECUTED', async t => {
  const dir = await makeTemp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manager = new SessionManager({ runsDir: dir, cases: [makeCase('TC-A'), makeCase('TC-B')] });
  manager.start(); manager.startStep('TC-A');
  assert.deepEqual(manager.snapshot().results.map(result => result.verdict), ['REVIEW', 'NOT_EXECUTED']);
  manager.abort();
  assert.equal(manager.steps[0].status, 'INTERRUPTED');
  assert.deepEqual(manager.snapshot().results.map(result => result.verdict), ['REVIEW', 'NOT_EXECUTED']);
});
test('a late correlated transport failure revalidates a completed PASS and preserves advisory notes', async t => {
  const dir = await makeTemp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manager = new SessionManager({ runsDir: dir, cases: [makeCase('TC-A', 'TRACKING_REQUEST')] });
  manager.start();
  try {
    const step = manager.startStep('TC-A');
    const request = manager.emit({ ...makeEvent(), captured_at: step.started_at, layer: 'TRACKING_REQUEST', network: { request_id: 'R-LATE', phase: 'request' }, page: { target_id: 'TAB' } });
    const initial = manager.completeStep();
    initial.ai_note = 'Existing advisory note';
    assert.equal(initial.verdict, 'PASS');
    manager.emit({ ...request, network: { request_id: 'R-LATE', phase: 'failed', error: 'net::ERR_FAILED' } });
    assert.equal(manager.results[0].verdict, 'FAIL');
    assert.equal(manager.snapshot().results[0].verdict, 'FAIL');
    assert.equal(manager.snapshot().results[0].ai_note, 'Existing advisory note');
  } finally { manager.abort(); }
});

test('each run persists a sanitized expected spec while retaining field/op schema', async t => {
  const dir = await makeTemp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const testCase = makeCase();
  testCase.rules[0].fields['user.email'] = { op: 'eq', value: 'opaquePrivateData' };
  testCase.rules[0].fields.phone = { op: 'type', value: 'string' };
  testCase.rules[0].fields['profile.email'] = { op: 'ref', value: 'context.user.email' };
  testCase.rules[0].fields['profile.phone'] = { op: 'one_of', value: ['opaquePhone1', 'opaquePhone2'] };
  const manager = new SessionManager({ runsDir: dir, cases: [testCase] });
  manager.start();
  try {
    const saved = JSON.parse(await fs.readFile(path.join(manager.runDir, 'expected.json'), 'utf8'));
    assert.deepEqual(saved.cases[0].rules[0].fields['user.email'], { op: 'eq', value: '[REDACTED]' });
    assert.equal(saved.cases[0].rules[0].fields.event.value, 'search_submit');
    assert.deepEqual(saved.cases[0].rules[0].fields.phone, { op: 'type', value: 'string' });
    assert.deepEqual(saved.cases[0].rules[0].fields['profile.email'], { op: 'ref', value: 'context.user.email' });
    assert.deepEqual(saved.cases[0].rules[0].fields['profile.phone'], { op: 'one_of', value: ['[REDACTED]', '[REDACTED]'] });
    assert.equal(testCase.rules[0].fields['user.email'].value, 'opaquePrivateData');
  } finally { manager.abort(); }
  assert.equal(loadRun(manager.runDir).cases[0].id, testCase.id);
});

test('storage masks vendor tokens, preserves QA session IDs, and never persists raw PII', async t => {
  const dir = await makeTemp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new EvidenceStore(dir);
  try {
    const event = store.append(makeEvent('EV-PRIVATE', { payload: { email: 'private@example.test', access_token: 'veryOpaqueSecret', session_id: 'vendorSecret', headers: { Authorization: 'Bearer hiddenBearer', Cookie: 'SID=hiddenCookie' } } }));
    assert.equal(event.session_id, 'S-QA-001');
    assert.equal(event.payload.session_id, '[REDACTED]');
    const raw = await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8');
    for (const secret of ['private@example.test', 'veryOpaqueSecret', 'vendorSecret', 'hiddenBearer', 'hiddenCookie']) assert.ok(!raw.includes(secret));
  } finally { store.close(); }
});

test('GA4 query and form body merge, decode numeric parameters, and sanitize nested page URLs', () => {
  const [event] = decodeRequest({ url: 'https://region1.google-analytics.com/g/collect?v=2&en=old&ep.service=hotel&access_token=topSecret', body: 'en=search_submit&ep.destination=Ph%C3%BA+Qu%E1%BB%91c&epn.quantity_adult=2&dl=https%3A%2F%2Fexample.test%2F%3Faccess_token%3DnestedSecret', contentType: 'application/x-www-form-urlencoded', requestId: 'R' });
  assert.equal(event.source, 'GA4');
  assert.equal(event.event_name, 'search_submit');
  assert.equal(event.payload.destination, 'Phú Quốc');
  assert.equal(event.payload.quantity_adult, 2);
  assert.equal(event.network.phase, 'request');
  assert.ok(!JSON.stringify(event).includes('topSecret'));
  assert.ok(!JSON.stringify(event).includes('nestedSecret'));
});

test('GA4 newline form batches and Insider nested JSON arrays preserve each event', () => {
  const ga = decodeRequest({ url: 'https://www.google-analytics.com/g/collect?v=2', body: 'en=view_item&ep.item_id=P1\nen=purchase&epn.value=120000', contentType: 'application/x-www-form-urlencoded' });
  assert.deepEqual(ga.map(event => event.event_name), ['view_item', 'purchase']);
  assert.equal(ga[1].payload.value, 120000);
  const insider = decodeRequest({ url: 'https://tracking.useinsider.com/event', body: JSON.stringify({ partner: 'test', events: [{ event_name: 'product_detail_page_view', product: { id: 'SKU-1' } }, { event: 'add_to_cart' }] }), contentType: 'application/json' });
  assert.deepEqual(insider.map(event => event.event_name), ['product_detail_page_view', 'add_to_cart']);
  assert.equal(insider[0].source, 'INSIDER');
  assert.equal(insider[0].payload.product.id, 'SKU-1');
});

test('NDJSON decodes as records and unsupported binary emits a hash without raw bytes', () => {
  const ndjson = decodeRequest({ url: 'https://tracking.useinsider.com/event', body: '{"event":"a"}\n{"event":"b"}', contentType: 'application/x-ndjson' });
  assert.deepEqual(ndjson.map(event => event.event_name), ['a', 'b']);
  const [unknown] = decodeRequest({ url: 'https://tracking.useinsider.com/event', body: Buffer.from([0, 2, 3, 127]), contentType: 'application/x-protobuf' });
  assert.equal(unknown.event_name, 'UNPARSED');
  assert.equal(unknown.payload.decode_status, 'UNPARSED');
  assert.match(unknown.payload.raw_hash, /^[a-f0-9]{64}$/);
  assert.ok(!Object.hasOwn(unknown.payload, '_raw'));
});

test('tracking endpoint matching rejects vendor strings in unrelated hosts, paths and query values', () => {
  assert.equal(matchesEndpoint('https://region1.google-analytics.com/g/collect?v=2'), true);
  assert.equal(matchesEndpoint('https://analytics.google.com/g/collect'), true);
  assert.equal(matchesEndpoint('https://hit.api.useinsider.com/hit'), true);
  assert.equal(matchesEndpoint('https://unification.useinsider.com/api/event/v1/insert'), true);
  // Insider hosts that serve segments, user data and SDK logs are not events.
  for (const url of ['https://segment.api.useinsider.com/v4/segments/1.d8', 'https://ucd-web.api.useinsider.com/v1/get', 'https://falcon.useinsider.com/api/v2/log-tracking/hit/votaprod', 'https://votaprod.api.useinsider.com/api/info/571.24']) assert.equal(matchesEndpoint(url), false, url);
  for (const url of ['https://evilgoogle-analytics.com/g/collect', 'https://example.test/path/google-analytics.com/g/collect', 'https://example.test/?url=google-analytics.com/g/collect', 'https://google-analytics.com.evil.test/g/collect', 'https://google-analytics.com/g/collective']) assert.equal(matchesEndpoint(url), false, url);
});

test('query parsing treats prototype keys as plain data and does not inherit constructor', () => {
  const [event] = decodeRequest({ url: 'https://www.google-analytics.com/g/collect?en=search_submit&constructor=literal&__proto__=one&__proto__=two' });
  assert.equal(event.payload.constructor, 'literal');
  assert.deepEqual(event.payload.__proto__, ['one', 'two']);
  assert.equal(Object.hasOwn(event.payload, '__proto__'), true);
  assert.equal(Object.prototype.polluted, undefined);
});

test('privacy preserves rule syntax while masking sensitive examples and flattened diffs', () => {
  const output = redact({ fields: { email: { op: 'eq', value: 'opaqueSensitiveData' } }, issue: { path: 'user.access_token', expected: 'opaqueSensitiveData', actual: 'anotherSecret' } });
  assert.deepEqual(output.fields.email, { op: 'eq', value: '[REDACTED]' });
  assert.equal(output.issue.path, 'user.access_token');
  assert.equal(output.issue.actual, '[REDACTED]');
  assert.ok(!JSON.stringify(output).includes('opaqueSensitiveData'));
});

test('generic privacy masking keeps sensitive one_of candidates as a schema-valid array', () => {
  const spec = makeCase();
  spec.rules[0].fields.email = { op: 'one_of', value: ['opaquePrivateOne', 'opaquePrivateTwo'] };
  spec.rules[0].fields.phone = { op: 'type', value: 'string' };
  const cleaned = redact(spec);
  assert.deepEqual(cleaned.rules[0].fields.email, { op: 'one_of', value: ['[REDACTED]', '[REDACTED]'] });
  assert.deepEqual(cleaned.rules[0].fields.phone, { op: 'type', value: 'string' });
  assert.doesNotThrow(() => validateTestCase(cleaned));
  assert.ok(!JSON.stringify(cleaned).includes('opaquePrivate'));
});

test('saved expected.json re-imports every supported operator with rule syntax preserved', async t => {
  const dir = await makeTemp();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const spec = makeCase();
  spec.rules[0].fields = {
    event: { op: 'eq', value: 'search_submit' }, destination: { op: 'exists' }, omitted: { op: 'not_exists' },
    quantity: { op: 'type', value: 'integer' }, destination_id: { op: 'regex', value: '^[A-Z]+$' },
    service: { op: 'one_of', value: ['hotel', 'merchandise'] }, price: { op: 'range', value: { min: 1, max: 100 } },
    search_term: { op: 'ref', value: 'context.search.term' }, product: { op: 'subset', value: { id: 'P1' } },
    'gtm.uniqueEventId': { op: 'ignore' }, email: { op: 'one_of', value: ['privateOpaqueOne', 'privateOpaqueTwo'] },
    'profile.email': { op: 'ref', value: 'context.profile.email' }, 'user.phone': { op: 'type', value: 'string' },
  };
  const manager = new SessionManager({ runsDir: dir, cases: [spec] });
  manager.start();
  const specPath = path.join(manager.runDir, 'expected.json');
  manager.abort();
  const imported = await importSpec(specPath);
  assert.equal(imported.cases.length, 1);
  const fields = imported.cases[0].rules[0].fields;
  assert.deepEqual(Object.keys(fields), Object.keys(spec.rules[0].fields));
  assert.deepEqual(Object.values(fields).map(field => field.op), Object.values(spec.rules[0].fields).map(field => field.op));
  assert.deepEqual(fields.email.value, ['[REDACTED]', '[REDACTED]']);
  assert.equal(fields['profile.email'].value, 'context.profile.email');
  assert.equal(fields['user.phone'].value, 'string');
  assert.ok(!(await fs.readFile(specPath, 'utf8')).includes('privateOpaque'));
});

test('local API enforces token/origin/host and exports a pending-step REVIEW without launching browsers', async t => {
  const dir = await makeTemp();
  const app = await createApp({ port: 0, runsDir: dir });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  assert.ok(!base.endsWith(':0'));
  const call = (route, data = {}, headers = {}) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': app.csrf, ...headers }, body: JSON.stringify(data) });
  assert.equal((await call('/api/step/start', {}, { 'x-eventqa-token': 'wrong' })).status, 403);
  assert.equal((await call('/api/step/start', {}, { origin: 'https://unrelated.test' })).status, 403);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${base}/api/state`, { headers: { Host: 'unrelated.test' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(invalidHostStatus, 403);
  app.manager.start({ environment: 'LOCAL_TEST' });
  const started = await call('/api/step/start', { testCaseId: app.manager.cases[0].id, context: {} });
  assert.equal(started.status, 200);
  assert.equal((await started.json()).results[0].verdict, 'REVIEW');
  const exported = await call('/api/export');
  assert.equal(exported.status, 200);
  const state = await exported.json();
  const comparison = await (await fetch(`${base}${state.exported.json}`)).json();
  assert.equal(comparison.results[0].verdict, 'REVIEW');
  assert.ok(comparison.results.some(result => result.verdict === 'NOT_EXECUTED'));
});
