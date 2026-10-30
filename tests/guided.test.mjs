import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGuidedPlan, assessGuidedStep, validateGuidedProposal, eligibleGuidedCases } from '../src/core/guided.mjs';

const from = '2026-10-30T00:00:00.000Z', until = '2026-10-30T00:00:10.000Z';
const c = (id = 'SEARCH', overrides = {}) => ({ id, name: 'Tìm sân golf', source: 'GA4', flow: 'Golf', description: 'Bấm tìm kiếm sân golf.',
  needs_review: true, sample_available: true, sample: { event: 'search_submit', service: 'golf', quantity: 2 },
  provenance: { file: 'WebOTA.xlsx', sheet: 'Events', row: 5 },
  rules: [{ event_name: 'search_submit', layer: 'JS_QUEUE', fields: { event: { op: 'eq', value: 'search_submit' }, service: { op: 'eq', value: 'golf' }, quantity: { op: 'type', value: 'integer' } }, count: { min: 1, max: 1 }, needs_review: true }], ...overrides });
const e = (payload = { event: 'search_submit', service: 'golf', quantity: 3 }, overrides = {}) => ({ evidence_id: 'E1', source: 'GA4', layer: 'JS_QUEUE', queue_name: 'dataLayer',
  event_name: payload.event || payload.event_name || 'search_submit', captured_at: '2026-10-30T00:00:01.000Z',
  page: { url: 'https://example.test/vi/golf/search', target_id: 'tab' }, payload, ...overrides });
const plan = cases => buildGuidedPlan(cases, { flow: 'golf', url: 'https://example.test/vi/golf' });
const assess = (cases, events, extra = {}) => assessGuidedStep({ step: plan(cases).steps[0], cases, events, startedAt: from, completedAt: until, ...extra });

test('guide selects one flow and groups the same explicit trigger across vendors without inventing requirements', () => {
  const ga = c();
  const insider = c('INS', { source: 'INSIDER', sample: { type: 'custom_event' }, rules: [{ event_name: 'search_golf', layer: 'JS_QUEUE', fields: {} }] });
  const flight = c('FLIGHT', { flow: 'Flight' });
  const before = structuredClone([ga, insider, flight]);
  const result = plan([ga, insider, flight]);
  assert.equal(result.guidance_source, 'requirements');
  assert.equal(result.steps.length, 1);
  assert.deepEqual(result.steps[0].case_ids, ['SEARCH', 'INS']);
  assert.equal(result.steps[0].expected.length, 2);
  assert.equal(result.steps[0].instruction, ga.description);
  assert.deepEqual([ga, insider, flight], before);
  assert.deepEqual(eligibleGuidedCases(before, 'Vé máy bay').map(v => v.id), ['FLIGHT']);
});

test('AI plan only rearranges existing case IDs and cannot approve or invent expected params', () => {
  const cases = [c('A'), c('B')];
  const proposal = { title: 'Kiểm tra tìm sân', steps: [{ title: 'Tìm sân', instruction: 'Chọn dữ liệu và bấm tìm kiếm.', expected_case_ids: ['A', 'B'] }] };
  assert.equal(validateGuidedProposal(proposal, cases), null);
  assert.equal(buildGuidedPlan(cases, { flow: 'golf', aiPlan: proposal }).guidance_source, 'ai');
  for (const invalid of [
    { ...proposal, approved: true },
    { ...proposal, steps: [{ ...proposal.steps[0], expected_case_ids: ['A'] }] },
    { ...proposal, steps: [{ ...proposal.steps[0], expected_case_ids: ['A', 'made-up'] }] },
    { ...proposal, steps: [{ ...proposal.steps[0], expected_case_ids: ['A', 'A'] }] },
    { ...proposal, steps: [{ ...proposal.steps[0], expected_payload: { total: 100 } }] },
  ]) assert.ok(validateGuidedProposal(invalid, cases));
});

test('sample dynamic values never become actual or exact expected values; optional operator values can verify them', () => {
  const cases = [c()];
  const p = plan(cases), step = p.steps[0];
  const result = assessGuidedStep({ step, cases, events: [e()], startedAt: from, completedAt: until });
  const row = result.expected[0];
  assert.equal(row.actual_payload.quantity, 3);
  assert.equal(row.expected_payload_sample.quantity, 2);
  assert.equal(row.status, 'match', 'structure matches despite differing dynamic sample value');
  assert.equal(row.acceptance_status, 'review');
  assert.equal(result.verdict, 'REVIEW');
  assert.equal(row.parameters.find(p => p.path === 'quantity').code, 'VALUE_NOT_VERIFIED');
  const binding = step.parameter_context.find(b => b.parameter_path === 'quantity');
  const context = {};
  const [root, key, leaf] = binding.context_path.split('.'); context[root] = { [key]: { [leaf]: 4 } };
  const wrong = assessGuidedStep({ step, cases, context, events: [e()], startedAt: from, completedAt: until });
  assert.equal(wrong.expected[0].wrong_parameters[0].expected, 4);
  assert.equal(wrong.expected[0].wrong_parameters[0].actual, 3);
});

test('queue, SDK and network observations are separate evidence and never count as three duplicate queue events', () => {
  const queue = e();
  const network = e(queue.payload, { evidence_id: 'WIRE', layer: 'TRACKING_REQUEST', network: { request_id: 'N', phase: 'request' } });
  const sdk = e(queue.payload, { evidence_id: 'SDK', queue_name: 'InsiderDispatch', queue_type: 'sdk_before_send' });
  const result = assess([c()], [queue, network, sdk]);
  assert.equal(result.expected[0].actual_count, 1);
  assert.equal(result.counts.actual_events, 1);
  assert.equal(result.observations.length, 3);
  assert.equal(result.extra_events.length, 0);
  const duplicate = assess([c()], [queue, { ...queue, evidence_id: 'REPEAT' }, network]);
  assert.equal(duplicate.expected[0].actual_count, 2);
  assert.ok(duplicate.expected[0].issues.some(i => i.code === 'DUPLICATE_EVENT'));
});

test('a network observation does not prove a required queue push and unavailable layers remain review', () => {
  const wire = e(undefined, { layer: 'TRACKING_REQUEST', evidence_id: 'WIRE', network: { request_id: 'N', phase: 'request' } });
  assert.equal(assess([c()], [wire]).expected[0].status, 'missing');
  assert.equal(assess([c()], [wire], { observedLayers: ['TRACKING_REQUEST'] }).expected[0].status, 'review');
});

test('a Flight event never fulfills Golf, and wrong-flow evidence is retained as unexpected', () => {
  const wrong = e({ event: 'search_submit', service: 'flight', quantity: 3 }, { page: { url: 'https://example.test/vi/flight/search' } });
  const result = assess([c()], [wrong]);
  assert.equal(result.expected[0].status, 'missing');
  assert.equal(result.extra_events.length, 1);
  assert.equal(result.extra_events[0].code, 'WRONG_FLOW');
  assert.equal(result.extra_events[0].payload.service, 'flight');
});

test('every captured array item is checked against the required item field types', () => {
  const cases = [c('ITEMS', { sample: { event: 'view_cart', ecommerce: { items: [{ item_id: 'sample', quantity: 1 }] } },
    rules: [{ event_name: 'view_cart', layer: 'JS_QUEUE', fields: { 'ecommerce.items': { op: 'type', value: 'array' }, 'ecommerce.items.0.item_id': { op: 'type', value: 'string' }, 'ecommerce.items.0.quantity': { op: 'type', value: 'integer' } } }] })];
  const event = e({ event: 'view_cart', ecommerce: { items: [{ item_id: 'a', quantity: 1 }, { item_id: 'b' }] } });
  const result = assess(cases, [event]);
  assert.equal(result.expected[0].status, 'mismatch');
  assert.ok(result.expected[0].missing_parameters.some(p => p.path === 'ecommerce.items.1.quantity'));
});

test('extra business events and parameters are explicit, while known incidental GA4 page views are supplementary', () => {
  const result = assess([c()], [e({ event: 'search_submit', service: 'golf', quantity: 3, extra_flag: true }),
    e({ event: 'page_view' }, { evidence_id: 'PAGE' }), e({ event: 'unexpected_action' }, { evidence_id: 'EXTRA' })]);
  assert.equal(result.extra_events.length, 1);
  assert.equal(result.extra_events[0].event_name, 'unexpected_action');
  assert.ok(result.expected[0].extra_parameters.some(p => p.path === 'extra_flag' && p.severity === 'info'));
  assert.equal(result.observations.length, 3);
});

test('old/historical and response observations cannot satisfy or duplicate a step event', () => {
  const result = assess([c()], [e(undefined, { historical: true }), e(undefined, { evidence_id: 'OLD', captured_at: '2026-10-29T00:00:00Z' }),
    e(undefined, { evidence_id: 'RESP', layer: 'TRACKING_REQUEST', network: { phase: 'response', status: 204, request_id: 'N' } })]);
  assert.equal(result.expected[0].actual_count, 0);
  assert.equal(result.expected[0].status, 'missing');
});

test('contradictory Insider page sample becomes source review rather than invented website field bugs', () => {
  const cases = [c('CART', { source: 'INSIDER', description: 'Fire khi giỏ hàng hiển thị, type=cart.',
    sample: { type: 'remove_from_cart', value: { id: 'sample' } },
    rules: [{ event_name: 'cart_page_view', layer: 'JS_QUEUE', fields: { type: { op: 'eq', value: 'remove_from_cart' }, 'value.id': { op: 'type', value: 'string' } } }] })];
  const event = e({ type: 'cart', value: { items: [{ id: 'actual' }] } }, { source: 'INSIDER', queue_name: 'InsiderQueue', event_name: 'cart_page_view' });
  const result = assess(cases, [event]);
  assert.equal(result.expected[0].status, 'review');
  assert.equal(result.expected[0].missing_parameters.length, 0);
  assert.equal(result.expected[0].wrong_parameters.length, 0);
  assert.ok(result.expected[0].spec_conflicts.length);
  assert.deepEqual(result.expected[0].actual_payload, event.payload);
});

test('failure outcome steps are optional and page-load instructions require a fresh action after start', () => {
  const failed = c('FAIL', { description: 'Thanh toán thất bại.', rules: [{ event_name: 'purchase_fail', layer: 'JS_QUEUE', fields: {} }] });
  const page = c('PAGE', { description: 'Mọi trang trong luồng Golf.', rules: [{ event_name: 'page_view', layer: 'JS_QUEUE', fields: {} }] });
  const p = plan([page, failed]);
  assert.ok(p.steps.find(s => s.case_ids.includes('PAGE')).instruction.includes('tải lại'));
  assert.equal(p.steps.find(s => s.case_ids.includes('FAIL')).optional, true);
  assert.equal(p.steps.find(s => s.case_ids.includes('FAIL')).branch, 'failure');
});

test('requirements fallback orders actions across vendor sections without conflating different triggers', () => {
  const rows = [
    c('BUY', { source: 'INSIDER', description: 'Mở xác nhận thành công.', rules: [{ event_name: 'confirmation_page_view', layer: 'JS_QUEUE', fields: {} }] }),
    c('DETAIL_LIST', { description: 'Người dùng mở chi tiết sân.', rules: [{ event_name: 'view_item_list', layer: 'JS_QUEUE', fields: {} }] }),
    c('SEARCH', { description: 'Người dùng bấm tìm kiếm.', rules: [{ event_name: 'search_submit', layer: 'JS_QUEUE', fields: {} }] }),
    c('RESULTS', { source: 'INSIDER', description: 'Trang kết quả tìm kiếm hiển thị.', rules: [{ event_name: 'listing_page_view', layer: 'JS_QUEUE', fields: {} }] }),
  ];
  const result = plan(rows);
  assert.deepEqual(result.steps.map(step => step.case_ids[0]), ['SEARCH', 'RESULTS', 'DETAIL_LIST', 'BUY']);
  assert.equal(result.steps.length, 4);
  const outcomes = [c('OK', { rules: [{ event_name: 'purchase', layer: 'JS_QUEUE', fields: {} }] }), c('FAIL', { rules: [{ event_name: 'purchase_fail', layer: 'JS_QUEUE', fields: {} }] })];
  assert.equal(validateGuidedProposal({ title: 'Invalid alternatives', steps: [{ title: 'Pay', instruction: 'Pay', expected_case_ids: ['OK', 'FAIL'] }] }, outcomes), 'INVALID_AI_GUIDE_ALTERNATIVE_OUTCOMES');
});

test('unreadable network requests cause review, not a false missing-event conclusion', () => {
  const cases = [c('NET', { rules: [{ event_name: 'search_submit', layer: 'TRACKING_REQUEST', fields: { quantity: { op: 'type', value: 'integer' } } }] })];
  const unreadable = e({}, { layer: 'TRACKING_REQUEST', event_name: 'UNPARSED', capture: { incomplete: true, reasons: ['request_body_unavailable'] }, network: { phase: 'request', request_id: 'N', decode_status: 'UNPARSED' } });
  const result = assess(cases, [unreadable]);
  assert.equal(result.expected[0].status, 'review');
  assert.ok(result.expected[0].issues.some(i => i.code === 'CAPTURE_UNAVAILABLE'));
});

test('explicit reviewed fixed-value rules can pass; missing context does not', () => {
  const reviewed = c('FIXED', { needs_review: false, rules: [{ event_name: 'search_submit', layer: 'JS_QUEUE', fields: { service: { op: 'eq', value: 'golf' } } }] });
  assert.equal(assess([reviewed], [e()]).verdict, 'PASS');
  const dynamic = c('REF', { needs_review: false, rules: [{ event_name: 'search_submit', layer: 'JS_QUEUE', fields: { quantity: { op: 'ref', value: 'context.search.quantity' } } }] });
  assert.equal(assess([dynamic], [e()]).verdict, 'REVIEW');
  assert.equal(assess([dynamic], [e()], { context: { search: { quantity: 3 } } }).verdict, 'PASS');
  assert.equal(assess([dynamic], [e()], { context: { search: { quantity: 4 } } }).verdict, 'FAIL');
});

test('matching names from another website cannot satisfy the website selected for the step', () => {
  const cases = [c('WEB', { needs_review: false, rules: [{ event_name: 'search_submit', layer: 'JS_QUEUE', fields: { service: { op: 'eq', value: 'golf' } } }] })];
  const wrongWebsite = e({ event: 'search_submit', service: 'golf' }, { page: { url: 'https://other.example/vi/golf' } });
  const result = assess(cases, [wrongWebsite], { expectedUrl: 'https://chosen.example/vi/golf' });
  assert.equal(result.expected[0].actual_count, 0);
  assert.equal(result.verdict, 'REVIEW');
  assert.ok(result.expected[0].issues.some(i => i.code === 'WEBSITE_UNVERIFIED'));
  assert.equal(result.observations.length, 1, 'evidence remains inspectable');
});
