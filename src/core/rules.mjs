import { isDeepStrictEqual } from 'node:util';
import { comparisonPayload, activityEvent } from './activity.mjs';
import { flowId } from './flows.mjs';

const MISSING = Symbol('missing');
const SUPPORTED = new Set(['eq', 'exists', 'not_exists', 'type', 'regex', 'one_of', 'range', 'ref', 'subset', 'ignore']);

/** A literal dotted property has precedence, as required for gtm.uniqueEventId. */
export function getPath(value, path, fallback = undefined) {
  if (typeof path !== 'string' || !path) return fallback;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let node = value;
  for (let index = 0; index < parts.length; index++) {
    if (node === null || typeof node !== 'object') return fallback;
    const rest = parts.slice(index).join('.');
    if (Object.hasOwn(node, rest)) return node[rest];
    if (!Object.hasOwn(node, parts[index])) return fallback;
    node = node[parts[index]];
  }
  return node;
}

function typeMatches(value, expected) {
  if (Array.isArray(expected)) return expected.some(type => typeMatches(value, type));
  switch (expected) {
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null': return value === null;
    case 'string': case 'boolean': return typeof value === expected;
    default: throw new Error(`Unsupported type: ${expected}`);
  }
}

function subset(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every(item => actual.some(candidate => subset(candidate, item)));
  if (expected !== null && typeof expected === 'object') {
    return actual !== null && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && subset(actual[key], value));
  }
  return isDeepStrictEqual(actual, expected);
}

export function checkField(payload, path, rule, context, evidenceId) {
  const actual = getPath(payload, path, MISSING);
  const result = { path, op: rule?.op, expected: rule?.value, actual: actual === MISSING ? null : actual, evidence_id: evidenceId, verdict: 'PASS' };
  const fail = (code, verdict = 'FAIL') => ({ ...result, verdict, code });
  if (!rule || !SUPPORTED.has(rule.op)) return fail('INVALID_RULE', 'REVIEW');
  if (rule.op === 'ignore' || (rule.optional && actual === MISSING)) return result;
  if (rule.op === 'not_exists') return actual === MISSING ? result : fail('UNEXPECTED_FIELD');
  if (actual === MISSING) return fail('MISSING_FIELD');
  if (rule.op === 'exists') return actual !== null ? result : fail('NULL_FIELD');
  try {
    let pass;
    switch (rule.op) {
      case 'eq': pass = isDeepStrictEqual(actual, rule.value); break;
      case 'ref': {
        if (typeof rule.value !== 'string' || !rule.value.startsWith('context.')) return fail('INVALID_RULE', 'REVIEW');
        const expected = getPath({ context }, rule.value, MISSING);
        if (expected === MISSING) return fail('MISSING_CONTEXT', 'REVIEW');
        result.expected = expected;
        pass = isDeepStrictEqual(actual, expected);
        break;
      }
      case 'type': pass = typeMatches(actual, rule.value); break;
      case 'regex':
        if (typeof rule.value !== 'string' || rule.value.length > 512) return fail('INVALID_RULE', 'REVIEW');
        if (typeof actual === 'string' && actual.length > 16384) return fail('VALUE_TOO_LARGE', 'REVIEW');
        pass = typeof actual === 'string' && new RegExp(rule.value).test(actual);
        break;
      case 'one_of':
        if (!Array.isArray(rule.value)) return fail('INVALID_RULE', 'REVIEW');
        pass = rule.value.some(value => isDeepStrictEqual(actual, value));
        break;
      case 'range': {
        const bounds = rule.value;
        if (!bounds || typeof bounds !== 'object' || (!Number.isFinite(bounds.min) && !Number.isFinite(bounds.max))) return fail('INVALID_RULE', 'REVIEW');
        if (Number.isFinite(bounds.min) && Number.isFinite(bounds.max) && bounds.min > bounds.max) return fail('INVALID_RULE', 'REVIEW');
        pass = typeof actual === 'number' && Number.isFinite(actual) && (!Number.isFinite(bounds.min) || actual >= bounds.min) && (!Number.isFinite(bounds.max) || actual <= bounds.max);
        break;
      }
      case 'subset': pass = subset(actual, rule.value); break;
    }
    return pass ? result : fail(rule.op === 'type' ? 'WRONG_TYPE' : rule.op === 'ref' ? 'DYNAMIC_VALUE_MISMATCH' : 'VALUE_MISMATCH');
  } catch {
    return fail('INVALID_RULE', 'REVIEW');
  }
}

function verdictOf(items, fallback = 'PASS') {
  if (items.some(item => item.verdict === 'FAIL')) return 'FAIL';
  if (items.some(item => item.verdict === 'REVIEW')) return 'REVIEW';
  return fallback;
}

/** Deterministic validation. It never infers ingestion from a queue/request. */
export function validateCase(testCase, events = [], step) {
  const base = { test_case_id: testCase.id, step_id: step?.id ?? null, results: [] };
  if (!step || step.status === 'NOT_EXECUTED') return { ...base, verdict: 'NOT_EXECUTED' };
  const stepEvidence = step.evidence_id || `STEP-${step.id}`;
  const windowStart = Date.parse(step.started_at);
  const windowEnd = step.completed_at ? Date.parse(step.completed_at) : Infinity;
  const associated = events.filter(event => !event.historical && event.step_id === step.id && event.test_case_id === testCase.id);
  const scoped = associated.filter(event => {
    if (event.network?.phase && event.network.phase !== 'request') return false;
    const timestamp = Date.parse(event.captured_at);
    return !Number.isFinite(timestamp) || ((!Number.isFinite(windowStart) || timestamp >= windowStart) && (!Number.isFinite(windowEnd) || timestamp <= windowEnd));
  });
  for (const rule of testCase.rules ?? []) {
    const source = rule.source ?? testCase.source;
    if (Array.isArray(step.observed_layers) && !step.observed_layers.includes(rule.layer)) {
      const issue = { code: 'LAYER_UNAVAILABLE', expected: rule.layer, actual: step.observed_layers, evidence_id: stepEvidence, verdict: 'REVIEW' };
      base.results.push({ event_name: rule.event_name, layer: rule.layer, source, verdict: 'REVIEW', evidence_ids: [], checks: [issue], issues: [issue] });
      continue;
    }
    const matchesSource = event => !source || String(event.source).toUpperCase() === String(source).toUpperCase();
    const expectedFlow = flowId(testCase.flow);
    const matching = scoped.filter(event => {
      const names = [rule.event_name, ...(rule.event_aliases ?? [])];
      if (!(names.includes(event.event_name) || (testCase.payload_format === 'default_custom_parameters' && names.includes(activityEvent(event).display_name))) || event.layer !== rule.layer || !matchesSource(event)) return false;
      const actualFlow = expectedFlow === 'unknown' ? 'unknown' : activityEvent(event).flow_id;
      return expectedFlow === 'unknown' || actualFlow === 'unknown' || actualFlow === expectedFlow;
    });
    const checks = [];
    const issues = [];
    const add = (code, expected, actual, evidenceId = stepEvidence, verdict = 'FAIL', path = undefined) => {
      checks.push({ code, expected, actual, evidence_id: evidenceId, verdict, ...(path ? { path } : {}) });
      issues.push({ code, expected, actual, evidence_id: evidenceId, verdict, ...(path ? { path } : {}) });
    };
    const min = rule.count?.min ?? 1;
    const max = rule.count?.max ?? 1;
    if (!Number.isInteger(min) || min < 0 || !Number.isInteger(max) || max < min) add('INVALID_RULE', '0 <= count.min <= count.max', rule.count, stepEvidence, 'REVIEW');
    else {
      checks.push({ path: '$count', expected: { min, max }, actual: matching.length, verdict: matching.length >= min && matching.length <= max ? 'PASS' : 'FAIL', evidence_id: matching[0]?.evidence_id ?? stepEvidence });
      if (matching.length < min) add('MISSING_EVENT', { min }, matching.length);
      if (matching.length > max) add('DUPLICATE_EVENT', { max }, matching.length, matching[max]?.evidence_id ?? stepEvidence);
    }
    for (const event of matching) {
      const evidenceId = event.evidence_id || stepEvidence;
      if (event.capture?.incomplete) { add('INCOMPLETE_CAPTURE', 'Complete captured payload', event.capture.reasons, evidenceId, 'REVIEW'); continue; }
      if (rule.layer === 'TRACKING_REQUEST' && event.network?.request_id) {
        const lifecycle = associated.filter(candidate => candidate.layer === 'TRACKING_REQUEST' && matchesSource(candidate)
          && candidate.network?.request_id === event.network.request_id
          && (candidate.page?.target_id ?? null) === (event.page?.target_id ?? null)
          && ['response', 'failed'].includes(candidate.network?.phase));
        for (const transport of [event, ...lifecycle]) {
          const transportEvidence = transport.evidence_id || evidenceId;
          if (transport.network?.phase === 'failed') add('REQUEST_FAILED', 'Request completed without network failure', transport.network.error ?? 'Network request failed', transportEvidence);
          else if (Number.isFinite(Number(transport.network?.status)) && transport.network.status !== undefined) {
            const status = Number(transport.network.status);
            if (status >= 400) add('HTTP_ERROR', 'HTTP status < 400', status, transportEvidence);
            else checks.push({ path: '$transport', expected: 'HTTP status < 400', actual: status, evidence_id: transportEvidence, verdict: 'PASS' });
          }
        }
      }
      const observedPayload = comparisonPayload(testCase, event);
      for (const [path, fieldRule] of Object.entries(rule.fields ?? {})) {
        const check = checkField(observedPayload, path, fieldRule, step.context ?? {}, evidenceId);
        checks.push(check);
        if (check.verdict !== 'PASS') issues.push({ ...check, code: check.code });
      }
      if (rule.within_ms !== undefined) {
        const delta = Date.parse(event.captured_at) - windowStart;
        if (!Number.isFinite(rule.within_ms) || rule.within_ms < 0) add('INVALID_RULE', 'within_ms >= 0', rule.within_ms, evidenceId, 'REVIEW');
        else if (!Number.isFinite(delta)) add('MISSING_TIMING', rule.within_ms, null, evidenceId, 'REVIEW');
        else {
          checks.push({ path: '$timing', expected: { within_ms: rule.within_ms }, actual: delta, evidence_id: evidenceId, verdict: delta <= rule.within_ms && delta >= 0 ? 'PASS' : 'FAIL' });
          if (delta > rule.within_ms || delta < 0) add('TIMING_EXCEEDED', { within_ms: rule.within_ms }, delta, evidenceId);
        }
      }
      if (rule.after) {
        const previous = scoped.filter(candidate => candidate.event_name === rule.after && candidate.layer === rule.layer && matchesSource(candidate));
        const candidateTime = Date.parse(event.captured_at);
        if (!previous.length) add('ORDER_PREDECESSOR_MISSING', rule.after, null, evidenceId);
        else if (!Number.isFinite(candidateTime) || previous.every(candidate => !Number.isFinite(Date.parse(candidate.captured_at)))) add('MISSING_TIMING', `after ${rule.after}`, null, evidenceId, 'REVIEW');
        else if (!previous.some(candidate => {
          const previousTime = Date.parse(candidate.captured_at);
          return previousTime < candidateTime || (previousTime === candidateTime && scoped.indexOf(candidate) < scoped.indexOf(event));
        })) add('OUT_OF_ORDER', `after ${rule.after}`, event.event_name, evidenceId);
        else checks.push({ path: '$order', expected: `after ${rule.after}`, actual: event.event_name, evidence_id: evidenceId, verdict: 'PASS' });
      }
    }
    if (rule.needs_review) add('RULE_NEEDS_REVIEW', 'Reviewed rule', 'Draft rule', stepEvidence, 'REVIEW');
    const pendingReview = rule.needs_review || testCase.needs_review || step.status !== 'COMPLETED';
    const result = { event_name: rule.event_name, layer: rule.layer, source, verdict: pendingReview ? 'REVIEW' : verdictOf(checks), evidence_ids: [...new Set(matching.map(event => event.evidence_id).filter(Boolean))], checks, issues };
    base.results.push(result);
  }
  const overallChecks = base.results.map(result => ({ verdict: result.verdict }));
  if (testCase.needs_review || !testCase.rules?.length || step.status !== 'COMPLETED') overallChecks.push({ verdict: 'REVIEW' });
  return { ...base, verdict: testCase.needs_review || step.status !== 'COMPLETED' ? 'REVIEW' : verdictOf(overallChecks), ...(step.status !== 'COMPLETED' ? { warning: 'Step has not been completed.' } : {}) };
}
