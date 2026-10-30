import { checkField } from './rules.mjs';
import { comparisonPayload, activityEvent } from './activity.mjs';
import { flowId } from './flows.mjs';

// Queue/request records that set up a vendor SDK rather than report a user action.
const SETUP_EVENT = /^(?:gtm\.|gtag\.|insider_|ecommerce_reset$|QUEUE_ITEM$|config$|js$|set$|consent$|UNPARSED$|tracking_request$)/;

function leaves(value, prefix = '', out = new Map(), depth = 0) {
  if (value && typeof value === 'object' && depth < 6) {
    const entries = Array.isArray(value) ? value.slice(0, 1).map((item, index) => [index, item]) : Object.entries(value);
    for (const [key, child] of entries) leaves(child, prefix ? `${prefix}.${key}` : String(key), out, depth + 1);
  } else if (prefix && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) out.set(prefix, value);
  return out;
}
/**
 * Checks one captured event against one specification case without a QA step:
 * dynamic values (`ref`) only need to be present, every other rule is applied as written.
 */
function evaluate(testCase, rule, event) {
  if (event.capture?.incomplete) return { checks: [{ code: 'INCOMPLETE_CAPTURE', path: '', verdict: 'REVIEW', actual: event.capture.reasons }], score: 0 };
  const payload = comparisonPayload(testCase, event);
  const checks = Object.entries(rule.fields ?? {}).map(([path, field]) => checkField(payload, path, field?.op === 'ref' ? { op: 'exists' } : field, {}, event.evidence_id));
  const fixed = Object.entries(rule.fields ?? {}).filter(([, field]) => field?.op === 'eq' || field?.op === 'one_of').map(([path]) => path);
  const failedFixed = checks.filter(check => check.verdict !== 'PASS' && fixed.includes(check.path)).length;
  const passed = checks.filter(check => check.verdict === 'PASS').length;
  // Sample values that reappear in the event (service, breadcrumb, taxonomy...) identify the flow.
  let similar = 0;
  if (testCase.sample) {
    const expected = leaves(testCase.sample);
    for (const [path, value] of leaves(payload)) {
      const sample = expected.get(path);
      if (typeof sample === 'string' && typeof value === 'string' && sample.length <= 60 && sample.toLowerCase() === value.toLowerCase()) similar++;
    }
  }
  return { checks, score: passed + 2 * similar - 10 * failedFixed + flowHint(testCase.flow, event.page?.url) };
}

// Page paths of booking flows, matched against the flow names used in specifications.
const FLOW_PATHS = [
  [/\/(?:flight|ve-may-bay)(?:\/|$)/i, /vé máy bay|ve may bay|flight/i], [/\/(?:hotel|khach-san)(?:\/|$)/i, /khách sạn|khach san|hotel/i],
  [/\/combo(?:\/|$)/i, /combo/i], [/\/(?:experience|attraction|ticket|vui-choi)(?:\/|$)/i, /vui chơi|trải nghiệm|experience|attraction/i],
  [/\/golf(?:\/|$)/i, /golf/i], [/\/(?:event|su-kien)(?:\/|$)/i, /^event$|sự kiện/i], [/\/train(?:\/|$)/i, /train|tàu/i],
  [/\/voucher(?:\/|$)/i, /voucher/i], [/\/(?:merchandise|shop)(?:\/|$)/i, /merchandise/i],
];
function flowHint(flow, pageUrl) {
  let pathname = ''; try { pathname = new URL(pageUrl).pathname; } catch { return 0; }
  const hit = FLOW_PATHS.find(([page]) => page.test(pathname));
  if (!hit || !flow) return 0;
  return hit[1].test(flow) ? 3 : 0;
}

/** Assigns each captured event to the specification row it most likely implements. */
export function matchEvent(cases, event, index = indexCases(cases)) {
  if (event.network?.phase && event.network.phase !== 'request') return null;
  const prefix = `${event.layer}|${String(event.source).toUpperCase()}|`;
  const candidates = [...(index.get(prefix + event.event_name) || [])];
  for (const candidate of index.get(prefix + activityEvent(event).display_name) || []) {
    if (candidate.testCase.payload_format === 'default_custom_parameters' && !candidates.includes(candidate)) candidates.push(candidate);
  }
  const actualFlow = activityEvent(event).flow_id;
  const candidateFlows = new Set(candidates.map(c => flowId(c.testCase.flow)).filter(f => f !== 'unknown'));
  if (actualFlow === 'unknown' && candidateFlows.size > 1) return null;
  let best = null;
  for (const { testCase, rule } of candidates) {
    const expectedFlow = flowId(testCase.flow);
    if (actualFlow !== 'unknown' && expectedFlow !== 'unknown' && actualFlow !== expectedFlow) continue;
    const result = evaluate(testCase, rule, event);
    if (!best || result.score > best.score) best = { testCase, rule, ...result };
  }
  if (!best) return null;
  const issues = best.checks.filter(check => check.verdict !== 'PASS').map(({ path, op, code, expected, actual, verdict }) => ({ path, op, code, expected, actual, verdict }));
  // Field paths the specification expects, so a viewer can mark every parameter of the event.
  const fields = Object.fromEntries(Object.entries(best.rule.fields ?? {}).map(([path, field]) => [path, field?.op]));
  if (!Object.keys(fields).length || best.testCase.sample_available === false) issues.push({ code: 'NO_EXPECTED_FIELDS', verdict: 'REVIEW', path: '', expected: 'Chi tiết event trong đặc tả' });
  for (const [path, field] of Object.entries(best.rule.fields ?? {})) if (field?.op === 'ref') {
    issues.push({ code: 'MISSING_CONTEXT', verdict: 'REVIEW', path, expected: field.value });
  }
  const pendingReview = best.testCase.needs_review || best.rule.needs_review;
  if (pendingReview) issues.push({ code: 'RULE_NEEDS_REVIEW', verdict: 'REVIEW', path: '', expected: 'Reviewed rule' });
  return { case_id: best.testCase.id, event_name: best.rule.event_name, comparison_format: best.testCase.payload_format || 'raw', verdict: pendingReview ? 'REVIEW' : issues.some(issue => issue.verdict === 'FAIL') ? 'FAIL' : issues.length ? 'REVIEW' : 'PASS', issues, fields, ambiguous: candidates.length > 1 && best.score <= 0 };
}

export function indexCases(cases) {
  const index = new Map();
  for (const testCase of cases) for (const rule of testCase.rules ?? []) {
    for (const name of new Set([rule.event_name, ...(rule.event_aliases ?? [])])) {
      const key = `${rule.layer}|${String(rule.source ?? testCase.source).toUpperCase()}|${name}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ testCase, rule });
    }
  }
  return index;
}

/**
 * Coverage of a tracking specification by the evidence of a session: which rows fired,
 * which match their sample, which never fired, and which captured events are not specified.
 */
export function specCoverage(cases, events, cache = new Map()) {
  const index = indexCases(cases);
  const rows = new Map(cases.map(testCase => [testCase.id, {
    case_id: testCase.id, stt: testCase.stt ?? '', source: testCase.source ?? '', flow: testCase.flow ?? '', event_name: testCase.rules?.[0]?.event_name ?? testCase.name,
    layer: testCase.rules?.[0]?.layer ?? '', description: testCase.description ?? '', notes: testCase.notes ?? '', row: testCase.provenance?.row ?? null, sheet: testCase.provenance?.sheet ?? null,
    payload_format: testCase.payload_format ?? '',
    seen: 0, pass: 0, fail: 0, review: 0, last_at: null, last_evidence_id: null, last_fail_evidence_id: null, issues: [],
  }]));
  const unmatched = new Map();
  for (const event of events) {
    if (event.network?.phase && event.network.phase !== 'request') continue;
    let match = cache.get(event.evidence_id);
    if (match === undefined) { match = matchEvent(cases, event, index); cache.set(event.evidence_id, match); }
    if (!match) {
      if (SETUP_EVENT.test(event.event_name)) continue;
      const key = `${event.source}|${event.event_name}`;
      const entry = unmatched.get(key) ?? { source: event.source, event_name: event.event_name, count: 0, last_evidence_id: null, page: event.page?.url ?? '' };
      entry.count++; entry.last_evidence_id = event.evidence_id; unmatched.set(key, entry);
      continue;
    }
    const row = rows.get(match.case_id); if (!row) continue;
    row.seen++; row[match.verdict.toLowerCase()]++; row.last_at = event.captured_at; row.last_evidence_id = event.evidence_id;
    if (match.verdict !== 'PASS') row.last_fail_evidence_id = event.evidence_id;
    for (const issue of match.issues) if (row.issues.length < 12 && !row.issues.some(known => known.path === issue.path && known.code === issue.code)) row.issues.push(issue);
  }
  const list = [...rows.values()];
  for (const row of list) row.status = !row.seen ? 'NOT_SEEN' : row.fail ? 'MISMATCH' : row.review ? 'REVIEW' : 'MATCH';
  const totals = { rows: list.length, seen: list.filter(row => row.seen).length, match: list.filter(row => row.status === 'MATCH').length,
    mismatch: list.filter(row => row.status === 'MISMATCH').length, not_seen: list.filter(row => !row.seen).length, unmatched: unmatched.size };
  return { totals, rows: list, unmatched: [...unmatched.values()].sort((a, b) => b.count - a.count) };
}
