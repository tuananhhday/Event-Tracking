import test from 'node:test';
import assert from 'node:assert/strict';
import { getPath, validateCase } from '../src/core/rules.mjs';

const step = { id: 'STEP-01', evidence_id: 'STEP-EVIDENCE-01', test_case_id: 'TC-01', started_at: '2026-10-29T10:00:00.000Z', completed_at: '2026-10-29T10:00:05.000Z', status: 'COMPLETED', context: { search: { term: 'snack', adults: 2 } } };
const event = (payload = {}, extra = {}) => ({ evidence_id: 'EV-001', session_id: 'S-01', step_id: step.id, test_case_id: 'TC-01', captured_at: '2026-10-29T10:00:00.100Z', event_name: 'search_submit', layer: 'JS_QUEUE', source: 'GA4', payload: { event: 'search_submit', service: 'merchandise', search_term: 'snack', ...payload }, ...extra });
const tc = (fields = {}, more = {}) => ({ id: 'TC-01', name: 'Merchandise Search', source: 'GA4', rules: [{ event_name: 'search_submit', layer: 'JS_QUEUE', count: { min: 1, max: 1 }, fields, ...more }] });
const validate = (fields, actual = [event()], rule = {}, currentStep = step) => validateCase(tc(fields, rule), actual, currentStep);

test('dynamic context snack passes even though sample may say keychain', () => {
  assert.equal(validate({ search_term: { op: 'ref', value: 'context.search.term' } }).verdict, 'PASS');
});
test('wrong fixed value fails and points to event evidence', () => {
  const result = validate({ service: { op: 'eq', value: 'hotel' } });
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.results[0].issues[0].evidence_id, 'EV-001');
});
test('missing field is distinct from wrong value', () => {
  assert.equal(validate({ destination_id: { op: 'exists' } }).results[0].issues[0].code, 'MISSING_FIELD');
});
test('integer rejects string and null is not an existing business value', () => {
  assert.equal(validate({ count: { op: 'type', value: 'integer' } }, [event({ count: '2' })]).verdict, 'FAIL');
  assert.equal(validate({ destination_id: { op: 'exists' } }, [event({ destination_id: null })]).verdict, 'FAIL');
});
test('all remaining operators compare payload deterministically', () => {
  assert.equal(validate({
    omitted: { op: 'not_exists' },
    id: { op: 'regex', value: '^[A-Z]{3}-\\d+$' },
    kind: { op: 'one_of', value: ['a', 'b'] },
    count: { op: 'range', value: { min: 1, max: 4 } },
    nested: { op: 'subset', value: { items: [{ id: 1 }] } },
    'gtm.uniqueEventId': { op: 'ignore' },
    optional: { op: 'eq', value: 'x', optional: true },
  }, [event({ id: 'ABC-123', kind: 'b', count: 2, nested: { items: [{ id: 2 }, { id: 1, extra: 'ok' }] } })]).verdict, 'PASS');
});
test('literal dotted key takes precedence and array indices resolve', () => {
  assert.equal(getPath({ 'gtm.uniqueEventId': 17, gtm: { uniqueEventId: 18 } }, 'gtm.uniqueEventId'), 17);
  assert.equal(getPath({ items: [{ id: 'P1' }] }, 'items[0].id'), 'P1');
});
test('missing context is REVIEW with evidence', () => {
  const result = validate({ search_term: { op: 'ref', value: 'context.search.missing' } });
  assert.equal(result.verdict, 'REVIEW');
  assert.equal(result.results[0].issues[0].code, 'MISSING_CONTEXT');
  assert.ok(result.results[0].issues[0].evidence_id);
});
test('duplicate event detected without counting network response', () => {
  const result = validate({}, [event(), event({}, { evidence_id: 'EV-002' }), event({}, { network: { phase: 'response' } })]);
  assert.equal(result.results[0].issues[0].code, 'DUPLICATE_EVENT');
  assert.equal(result.results[0].issues[0].evidence_id, 'EV-002');
});
test('queue pass and missing network fail remain separate', () => {
  const testCase = tc({});
  testCase.rules.push({ event_name: 'search_submit', source: 'GA4', layer: 'TRACKING_REQUEST', fields: {}, count: { min: 1, max: 1 } });
  const result = validateCase(testCase, [event()], step);
  assert.deepEqual(result.results.map(item => item.verdict), ['PASS', 'FAIL']);
  assert.equal(result.results[1].issues[0].evidence_id, step.evidence_id);
});
test('unexecuted cases are not failures', () => {
  assert.equal(validate({}, [], {}, { ...step, status: 'NOT_EXECUTED' }).verdict, 'NOT_EXECUTED');
  assert.equal(validateCase(tc({}), []).verdict, 'NOT_EXECUTED');
});
test('active steps and draft rules cannot pass', () => {
  assert.equal(validate({}, [event()], {}, { ...step, status: 'RUNNING' }).verdict, 'REVIEW');
  assert.equal(validate({}, [event()], { needs_review: true }).verdict, 'REVIEW');
  assert.equal(validate({ service: { op: 'eq', value: 'hotel' } }, [event()], { needs_review: true }).verdict, 'REVIEW');
  assert.equal(validate({}, [], {}, { ...step, status: 'RUNNING' }).verdict, 'REVIEW');
});
test('case/step/source/history/time are isolated', () => {
  for (const extra of [{ test_case_id: 'OTHER' }, { step_id: 'OTHER' }, { source: 'INSIDER' }, { historical: true }, { captured_at: '2026-10-29T09:59:59.000Z' }, { captured_at: '2026-10-29T10:00:06.000Z' }]) {
    assert.equal(validate({}, [event({}, extra)]).results[0].issues[0].code, 'MISSING_EVENT');
  }
});
test('timing window starts at step action', () => {
  assert.equal(validate({}, [event()], { within_ms: 200 }).verdict, 'PASS');
  assert.equal(validate({}, [event()], { within_ms: 50 }).results[0].issues[0].code, 'TIMING_EXCEEDED');
});
test('ordering distinguishes predecessor missing and out of order', () => {
  const predecessor = event({}, { event_name: 'view', captured_at: '2026-10-29T10:00:00.050Z' });
  assert.equal(validate({}, [predecessor, event()], { after: 'view' }).verdict, 'PASS');
  const late = { ...predecessor, captured_at: '2026-10-29T10:00:00.200Z' };
  assert.equal(validate({}, [late, event()], { after: 'view' }).results[0].issues[0].code, 'OUT_OF_ORDER');
  assert.equal(validate({}, [event()], { after: 'view' }).results[0].issues[0].code, 'ORDER_PREDECESSOR_MISSING');
  const simultaneous = { ...predecessor, captured_at: event().captured_at };
  assert.equal(validate({}, [event(), simultaneous], { after: 'view' }).results[0].issues[0].code, 'OUT_OF_ORDER');
});
test('malformed rules/context are reviewable and do not crash', () => {
  assert.equal(validate({ service: { op: 'regex', value: '[' } }).verdict, 'REVIEW');
  assert.equal(validate({ service: { op: 'type', value: 'unknown' } }).verdict, 'REVIEW');
});
test('optional absent event can pass a zero minimum', () => {
  assert.equal(validate({}, [], { count: { min: 0, max: 1 } }).verdict, 'PASS');
});
test('request-only capture cannot claim missing JS_QUEUE evidence as a failure', () => {
  const result = validate({}, [], {}, { ...step, observed_layers: ['TRACKING_REQUEST'] });
  assert.equal(result.verdict, 'REVIEW');
  assert.deepEqual(result.results[0].issues, [{ code: 'LAYER_UNAVAILABLE', expected: 'JS_QUEUE', actual: ['TRACKING_REQUEST'], evidence_id: step.evidence_id, verdict: 'REVIEW' }]);
});
test('capability guard does not hide failures on observed layers', () => {
  const testCase = tc({});
  testCase.rules.push({ event_name: 'search_submit', source: 'GA4', layer: 'TRACKING_REQUEST', fields: {}, count: { min: 1, max: 1 } });
  const result = validateCase(testCase, [], { ...step, observed_layers: ['TRACKING_REQUEST'] });
  assert.deepEqual(result.results.map(item => item.verdict), ['REVIEW', 'FAIL']);
  assert.equal(result.results[1].issues[0].code, 'MISSING_EVENT');
  assert.equal(result.verdict, 'FAIL');
});
test('network lifecycle confirms 204 without counting a response as a duplicate request', () => {
  const request = event({}, { layer: 'TRACKING_REQUEST', page: { target_id: 'TAB' }, network: { request_id: 'R1', phase: 'request' } });
  const response = { ...request, evidence_id: 'EV-RESPONSE', network: { request_id: 'R1', phase: 'response', status: 204 } };
  const result = validate({}, [request, response], { layer: 'TRACKING_REQUEST' });
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.results[0].checks.find(check => check.path === '$count').actual, 1);
  assert.equal(result.results[0].checks.find(check => check.path === '$transport').evidence_id, 'EV-RESPONSE');
});
test('loadingFailed and HTTP 500 fail transport and point to lifecycle evidence', () => {
  const request = event({}, { layer: 'TRACKING_REQUEST', page: { target_id: 'TAB' }, network: { request_id: 'R1', phase: 'request' } });
  for (const [network, code] of [[{ request_id: 'R1', phase: 'failed', error: 'net::ERR_CONNECTION_RESET' }, 'REQUEST_FAILED'], [{ request_id: 'R1', phase: 'response', status: 500 }, 'HTTP_ERROR']]) {
    const response = { ...request, evidence_id: 'EV-LIFECYCLE', network };
    const result = validate({}, [request, response], { layer: 'TRACKING_REQUEST' });
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.results[0].issues[0].code, code);
    assert.equal(result.results[0].issues[0].evidence_id, 'EV-LIFECYCLE');
    assert.equal(result.results[0].checks.find(check => check.path === '$count').actual, 1);
  }
});
test('missing response is not a failure and lifecycle cannot cross target/case/step scope', () => {
  const request = event({}, { layer: 'TRACKING_REQUEST', page: { target_id: 'TAB' }, network: { request_id: 'R1', phase: 'request' } });
  const bad = { ...request, evidence_id: 'EV-OTHER', network: { request_id: 'R1', phase: 'response', status: 500 } };
  for (const other of [{ ...bad, page: { target_id: 'OTHER' } }, { ...bad, test_case_id: 'OTHER' }, { ...bad, step_id: 'OTHER' }]) assert.equal(validate({}, [request, other], { layer: 'TRACKING_REQUEST' }).verdict, 'PASS');
  assert.equal(validate({}, [request], { layer: 'TRACKING_REQUEST' }).verdict, 'PASS');
});
