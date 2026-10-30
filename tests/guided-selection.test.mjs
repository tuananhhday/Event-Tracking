import test from 'node:test';
import assert from 'node:assert/strict';
import { eligibleGuidedCases, buildGuidedPlan, validateGuidedProposal, assessGuidedStep, summarizeGuidedCompleteness } from '../src/core/guided.mjs';

const target = 'https://uat.example.test/vi/golf';
const from = '2026-10-30T00:00:00Z', until = '2026-10-30T00:00:10Z';
const c = (id, fields = { service: { op: 'eq', value: 'golf' } }, extra = {}) => ({ id, name: id, flow: 'Golf', source: 'GA4', target_platform: 'WEB',
  needs_review: false, description: `Trigger ${id}`, sample: { event: 'search_submit', service: 'golf' },
  rules: [{ event_name: 'search_submit', layer: 'JS_QUEUE', fields, count: { min: 1, max: 1 }, needs_review: false }], ...extra });
const event = (payload, extra = {}) => ({ evidence_id: 'E', source: 'GA4', layer: 'JS_QUEUE', queue_name: 'dataLayer', event_name: 'search_submit',
  page: { url: target }, captured_at: '2026-10-30T00:00:01Z', payload: { event: 'search_submit', service: 'golf', ...payload }, ...extra });
const assess = (plan, row, events, context = {}) => assessGuidedStep({ step: plan.steps.find(s => s.case_ids.includes(row.id)), cases: [row], events,
  context, startedAt: from, completedAt: until, expectedUrl: target });

test('explicit selection runs only requested events and can include shared requirements without including them automatically', () => {
  const rows = [c('G1'), c('G2'), c('COMMON', {}, { flow: 'All luồng' }), c('FLIGHT', {}, { flow: 'Vé máy bay' })];
  assert.deepEqual(eligibleGuidedCases(rows, 'Golf').map(c => c.id), ['G1', 'G2']);
  const plan = buildGuidedPlan(rows, { flow: 'Golf', selectedCaseIds: ['G2', 'COMMON'], url: target });
  assert.deepEqual(plan.case_ids, ['G2', 'COMMON']);
  assert.deepEqual(plan.steps.flatMap(s => s.case_ids), ['G2', 'COMMON']);
  assert.deepEqual(plan.selection.excluded_case_ids, ['G1']);
  assert.deepEqual(plan.selection.out_of_scope_case_ids, ['FLIGHT']);
  assert.equal(plan.selection.total_candidates, 3);
  assert.equal(plan.selection.selected_count, 2);
  const common = buildGuidedPlan(rows, { flow: 'All luồng', selectedCaseIds: ['COMMON'] });
  assert.equal(common.flow_label, 'Chung');
});

test('invalid explicit selections fail rather than silently expanding or changing scope', () => {
  const rows = [c('G1'), c('F1', {}, { flow: 'Flight' })];
  for (const [ids, code] of [[[], 'EMPTY'], [['unknown'], 'UNKNOWN_CASE'], [['G1', 'G1'], 'DUPLICATE'], [['F1'], 'FLOW_MISMATCH'], [null, 'INVALID']]) {
    assert.throws(() => buildGuidedPlan(rows, { flow: 'Golf', selectedCaseIds: ids }), new RegExp(`GUIDED_SELECTION_${code}`));
  }
  assert.throws(() => buildGuidedPlan([c('G1'), c('G1')], { flow: 'Golf', selectedCaseIds: ['G1'] }), /GUIDED_INVALID_REQUIREMENTS/);
});

test('AI cannot reintroduce excluded requirements or omit a selected requirement', () => {
  const rows = [c('G1'), c('G2')], selected = eligibleGuidedCases(rows, 'Golf', { selectedCaseIds: ['G2'] });
  const ai = ids => ({ title: 'Guide', steps: [{ title: 'Action', instruction: 'Act', expected_case_ids: ids }] });
  assert.equal(validateGuidedProposal(ai(['G2']), selected), null);
  assert.equal(validateGuidedProposal(ai(['G1', 'G2']), selected), 'INVALID_AI_GUIDE_UNKNOWN_CASE');
  assert.throws(() => buildGuidedPlan(rows, { flow: 'Golf', selectedCaseIds: ['G2'], aiPlan: ai(['G1']) }), /INVALID_AI_GUIDE_UNKNOWN_CASE/);
});

test('selection completeness distinguishes verified values, structural checks, missing events, skipped and not run', () => {
  const rows = [c('EXACT'), c('TYPE', { quantity: { op: 'type', value: 'integer' } }), c('MISSING'), c('SKIP'), c('WAIT'), c('EXCLUDED')];
  const plan = buildGuidedPlan(rows, { flow: 'Golf', url: target, selectedCaseIds: rows.slice(0, 5).map(c => c.id) });
  const results = [assess(plan, rows[0], [event({})]), assess(plan, rows[1], [event({ quantity: 3 })]), assess(plan, rows[2], [])];
  results.push({ step_id: plan.steps.find(s => s.case_ids.includes('SKIP')).id, status: 'not_executed', verdict: 'NOT_EXECUTED' });
  const coverage = summarizeGuidedCompleteness(plan, results, rows);
  assert.deepEqual(coverage.requirements.map(r => [r.case_id, r.status]), [
    ['EXACT', 'verified'], ['TYPE', 'checked_unverified'], ['MISSING', 'missing'], ['SKIP', 'skipped'], ['WAIT', 'not_run'],
  ]);
  assert.deepEqual({ selected: coverage.selected, executed: coverage.executed, skipped: coverage.skipped, remaining: coverage.remaining, excluded: coverage.excluded },
    { selected: 5, executed: 3, skipped: 1, remaining: 1, excluded: 1 });
  const typed = coverage.requirements.find(r => r.case_id === 'TYPE');
  assert.equal(typed.checked_parameters, 1); assert.equal(typed.verified_parameters, 0); assert.equal(typed.unverified_parameters, 1);
  assert.equal(typed.parameter_checks.structural_matched, 1);
  assert.equal(coverage.complete, false);
});

test('draft contracts and undeclared origin/platform never count as complete verification', () => {
  for (const extra of [{ needs_review: true }, { target_platform: undefined }]) {
    const row = c('DRAFT', undefined, extra), plan = buildGuidedPlan([row], { flow: 'Golf', url: target, selectedCaseIds: ['DRAFT'] });
    const checked = assess(plan, row, [event({})]);
    const coverage = summarizeGuidedCompleteness(plan, [checked], [row]);
    assert.equal(coverage.requirements[0].status, 'checked_unverified');
    assert.equal(coverage.complete, false);
  }
  const row = c('ORIGIN'), plan = buildGuidedPlan([row], { flow: 'Golf', selectedCaseIds: ['ORIGIN'] });
  const checked = assessGuidedStep({ step: plan.steps[0], cases: [row], events: [event({})], startedAt: from, completedAt: until });
  assert.equal(summarizeGuidedCompleteness(plan, [checked], [row]).complete, false);
});

test('retry uses the latest result and a skipped step is never misreported as missing', () => {
  const row = c('A'), plan = buildGuidedPlan([row], { flow: 'Golf', url: target, selectedCaseIds: ['A'] });
  const skipped = { step_id: plan.steps[0].id, status: 'not_executed' };
  const checked = assess(plan, row, [event({})]);
  assert.equal(summarizeGuidedCompleteness(plan, [checked, skipped], [row]).requirements[0].status, 'skipped');
  assert.equal(summarizeGuidedCompleteness(plan, [skipped, checked], [row]).requirements[0].status, 'verified');
  assert.equal(summarizeGuidedCompleteness(plan, [checked], [row], { currentStep: { id: plan.steps[0].id } }).requirements[0].status, 'in_progress');
});

test('large arrays visibly report incomplete checks instead of claiming all elements were verified', () => {
  const row = c('ITEMS', { 'items.0.quantity': { op: 'type', value: 'integer' } });
  const plan = buildGuidedPlan([row], { flow: 'Golf', url: target, selectedCaseIds: ['ITEMS'] });
  const items = Array.from({ length: 501 }, () => ({ quantity: 1 })); delete items[500].quantity;
  const result = assess(plan, row, [event({ items })]);
  assert.equal(result.verdict, 'REVIEW');
  assert.ok(result.expected[0].issues.some(i => i.code === 'PARAMETER_CHECK_LIMIT'));
  assert.equal(summarizeGuidedCompleteness(plan, [result], [row]).complete, false);
});

test('indexed exact/ref values are not copied into sibling items while type templates still inspect each item', () => {
  const row = c('ITEMS', { 'items.0.quantity': { op: 'ref', value: 'context.first_quantity' }, 'items.0.id': { op: 'type', value: 'string' } });
  const plan = buildGuidedPlan([row], { flow: 'Golf', url: target, selectedCaseIds: ['ITEMS'] });
  const result = assess(plan, row, [event({ items: [{ id: 'a', quantity: 1 }, { id: 'b', quantity: 2 }] })], { first_quantity: 1 });
  const fields = result.expected[0].parameters;
  assert.ok(fields.some(p => p.path === 'items.0.quantity' && p.status === 'match'));
  assert.ok(!fields.some(p => p.path === 'items.1.quantity' && p.status === 'mismatch'));
  assert.ok(fields.some(p => p.path === 'items.1.id' && p.structural_status === 'match'));
});

test('coverage keeps exact indexed rules separate from sibling structural rules', () => {
  const row = c('INDEXED', { 'items.0.quantity': { op: 'eq', value: 1 }, 'items.1.quantity': { op: 'type', value: 'integer' } });
  const plan = buildGuidedPlan([row], { flow: 'Golf', url: target, selectedCaseIds: ['INDEXED'] });
  const result = assess(plan, row, [event({ items: [{ quantity: 1 }, { quantity: 2 }] })]);
  const covered = summarizeGuidedCompleteness(plan, [result], [row]).requirements[0];
  assert.equal(covered.total_parameters, 2);
  assert.equal(covered.checked_parameters, 2);
  assert.equal(covered.verified_parameters, 1);
  assert.equal(covered.unverified_parameters, 1);
  assert.equal(covered.status, 'checked_unverified');
});

test('dataLayer merged state is retained only as diagnostic evidence and cannot supply a missing push parameter', () => {
  const row = c('RAW', { quantity: { op: 'eq', value: 3 } });
  const plan = buildGuidedPlan([row], { flow: 'Golf', url: target, selectedCaseIds: ['RAW'] });
  const captured = event({}, { data_layer_model: { values: { quantity: 3 }, inherited_paths: ['quantity'], complete: true, is_gtm_private_state: false } });
  const result = assess(plan, row, [captured]);
  assert.equal(result.expected[0].missing_parameters[0].path, 'quantity');
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.observations[0].data_layer_model.values.quantity, 3);
  assert.equal(result.expected[0].actual_events[0].data_layer_model.inherited_paths[0], 'quantity');
  assert.equal(result.expected[0].actual_payload.quantity, undefined);
});

test('Insider network aliases match declared business names without letting network satisfy a queue contract', () => {
  const row = c('ADD', { 'event_params.c_quantity': { op: 'eq', value: 1 } }, { source: 'INSIDER', rules: [{ event_name: 'add_to_cart', layer: 'TRACKING_REQUEST', fields: { 'event_params.c_quantity': { op: 'eq', value: 1 } } }] });
  const plan = buildGuidedPlan([row], { flow: 'Golf', url: target, selectedCaseIds: ['ADD'] });
  const sent = event({}, { source: 'INSIDER', layer: 'TRACKING_REQUEST', event_name: 'item_added_to_cart', payload: { event_params: { c_quantity: 1 } }, network: { phase: 'request' } });
  assert.equal(assess(plan, row, [sent]).expected[0].actual_count, 1);
  row.rules[0].layer = 'JS_QUEUE'; row.sample = { type: 'custom_event' };
  assert.equal(assess(plan, row, [sent]).expected[0].actual_count, 0);
});

test('known excluded events stay out of selection while future selected and unknown events remain visible', () => {
  const rows = [c('SEARCH'), c('LIST', { service: { op: 'eq', value: 'golf' } }, { rules: [{ event_name: 'view_item_list', layer: 'JS_QUEUE', fields: { service: { op: 'eq', value: 'golf' } } }] })];
  const plan = buildGuidedPlan(rows, { flow: 'Golf', selectedCaseIds: ['SEARCH'], url: target });
  const events = [event({}), event({}, { evidence_id: 'LIST', event_name: 'view_item_list', payload: { event: 'view_item_list', service: 'golf' } })];
  const result = assessGuidedStep({ step: plan.steps[0], cases: rows, events, startedAt: from, completedAt: until, expectedUrl: target });
  assert.equal(result.extra_events.length, 0);
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.observations.find(e => e.evidence_id === 'LIST').scope_status, 'out_of_selection');
  events.push(event({}, { evidence_id: 'OTHER', event_name: 'unknown_business', payload: { event: 'unknown_business', service: 'golf' } }));
  const extra = assessGuidedStep({ step: plan.steps[0], cases: rows, events, startedAt: from, completedAt: until, expectedUrl: target });
  assert.deepEqual(extra.extra_events.map(e => e.event_name), ['unknown_business']);
  assert.equal(extra.verdict, 'REVIEW', 'an unspecified event is not automatically a forbidden event');
  const both = buildGuidedPlan(rows, { flow: 'Golf', selectedCaseIds: ['SEARCH', 'LIST'], url: target });
  const premature = assessGuidedStep({ step: both.steps.find(s => s.case_ids.includes('SEARCH')), cases: rows, events: events.slice(0, 2), startedAt: from, completedAt: until, expectedUrl: target });
  assert.equal(premature.extra_events[0].event_name, 'view_item_list', 'selected future steps are not mislabeled excluded');
});

test('same-name excluded requirements do not relabel evidence that fulfills a selected requirement', () => {
  const rows = [c('SEARCH'), c('SEARCH_ALTERNATE')];
  const plan = buildGuidedPlan(rows, { flow: 'Golf', selectedCaseIds: ['SEARCH'], url: target });
  const result = assessGuidedStep({ step: plan.steps[0], cases: rows, events: [event({})], startedAt: from, completedAt: until, expectedUrl: target });
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.observations[0].scope_status, undefined);
});
