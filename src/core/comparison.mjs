import { specCoverage, compareSelectedEvent } from './catalog.mjs';
import { linkDeliveries } from './delivery.mjs';

export const flowName = testCase => String(testCase.flow || '').trim() || 'Chưa phân luồng';
export function comparisonFlows(cases) {
  const groups = new Map();
  for (const testCase of cases) {
    const name = flowName(testCase), group = groups.get(name) || { name, case_ids: [], sources: [] };
    group.case_ids.push(testCase.id);
    for (const source of [testCase.source, ...(testCase.rules || []).map(rule => rule.source)].filter(Boolean)) if (!group.sources.includes(source)) group.sources.push(source);
    groups.set(name, group);
  }
  return [...groups.values()];
}
const summarize = rows => ({ rows: rows.length, seen: rows.filter(row => row.seen).length,
  match: rows.filter(row => row.status === 'MATCH').length, mismatch: rows.filter(row => row.status === 'MISMATCH').length,
  not_sent: rows.filter(row => row.status === 'NOT_SENT').length, not_seen: rows.filter(row => row.status === 'NOT_SEEN').length,
  unmatched: 0, ambiguous: 0 });

/** UI shows the selected attempt; reports use the latest attempt of each flow.
 * Step-scoped evidence is an explicit choice made by the automation runner. */
export function comparisonCoverage(cases, events, selection, { all = false, steps = [], cache = new Map(), now = Date.now() } = {}) {
  const attempts = selection?.attempts || [], current = attempts.find(attempt => attempt.id === (selection?.active_id || selection?.view_id));
  const chosen = all ? [...new Map(attempts.map(attempt => [attempt.flow, attempt])).values()] : current ? [current] : [];
  const rows = new Map(), unmatched = [];
  function scope(id, selectedCases, scopedEvents, overrides = {}) {
    if (!cache.has(id)) cache.set(id, new Map());
    const links = linkDeliveries(scopedEvents), coverage = specCoverage(selectedCases, scopedEvents, cache.get(id), { links, now });
    for (const row of coverage.rows) {
      row.attempt_id = id; row.observed_count = row.seen;
      const selected = scopedEvents.find(event => event.evidence_id === overrides[row.case_id]);
      if (selected) {
        const testCase = selectedCases.find(testCase => testCase.id === row.case_id), comparison = compareSelectedEvent(testCase, selected, { links, now });
        if (comparison) Object.assign(row, { seen: ['NOT_SENT', 'PENDING'].includes(comparison.verdict) ? 0 : 1, not_sent: comparison.verdict === 'NOT_SENT' ? 1 : 0, pending: comparison.verdict === 'PENDING' ? 1 : 0, pass: comparison.verdict === 'PASS' ? 1 : 0, fail: comparison.verdict === 'FAIL' ? 1 : 0, review: comparison.verdict === 'REVIEW' ? 1 : 0,
          status: comparison.verdict === 'PASS' ? 'MATCH' : comparison.verdict === 'FAIL' ? 'MISMATCH' : comparison.verdict === 'NOT_SENT' ? 'NOT_SENT' : comparison.verdict === 'PENDING' ? 'PENDING' : 'REVIEW',
          issues: comparison.issues, last_evidence_id: selected.evidence_id, last_fail_evidence_id: comparison.verdict !== 'PASS' ? selected.evidence_id : null, last_at: selected.captured_at, manual: true });
      }
      rows.set(row.case_id, row);
    }
    unmatched.push(...coverage.unmatched.map(item => ({ ...item, attempt_id: id })));
  }
  if (!current || all) {
    const ids = new Set(steps.map(step => step.test_case_id));
    for (const id of ids) scope(`step:${id}`, cases.filter(testCase => testCase.id === id), events.filter(event => event.test_case_id === id && event.step_id));
  }
  for (const attempt of chosen) scope(attempt.id, cases.filter(testCase => attempt.case_ids.includes(testCase.id)), events.filter(event => event.comparison_attempt_id === attempt.id), attempt.overrides);
  let list = [...rows.values()];
  if (!all && !current && !list.length) list = specCoverage(cases, [], new Map(), { now }).rows.map(row => ({ ...row, status: 'NOT_SELECTED' }));
  return { explicit: true, rows: list, unmatched, totals: { ...summarize(list), unmatched: unmatched.filter(item => !item.ambiguous).length, ambiguous: unmatched.filter(item => item.ambiguous).length },
    selection: { active: selection?.active_id != null, attempt: current || null, flows: comparisonFlows(cases), attempts: attempts.map(({ overrides, ...attempt }) => attempt) } };
}
