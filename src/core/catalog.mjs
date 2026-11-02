import { checkField } from './rules.mjs';
import { isBusinessEvent } from './event-kind.mjs';
import { linkDeliveries, deliveryStatus, ga4HitAsPush } from './delivery.mjs';
import { insiderHitView } from './insider-hit.mjs';

// Queue/request records that set up a vendor SDK rather than report a user action.
const SETUP_EVENT = /^(?:gtm\.|gtag\.|insider_|ecommerce_reset$|QUEUE_ITEM$|config$|js$|set$|consent$|UNPARSED$|tracking_request$)/;

function leaves(value, prefix = '', out = new Map(), depth = 0) {
  if (value && typeof value === 'object' && depth < 6) {
    const entries = Array.isArray(value) ? value.slice(0, 1).map((item, index) => [index, item]) : Object.entries(value);
    for (const [key, child] of entries) leaves(child, prefix ? `${prefix}.${key}` : String(key), out, depth + 1);
  } else if (prefix && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) out.set(prefix, value);
  return out;
}
const APP_ONLY_FIELD = /^custom_parameters\.(?:app_version|device_manufacturer|device_model|os_version|platform)$/;
// Which row an event belongs to (its flow) is told by everything observed, including the push behind
// a GA4 hit (page_type, service…); whether its fields are right is judged on the hit alone.
const observedLeaves = event => event.pushed ? new Map([...leaves(event.pushed), ...leaves(event.payload)]) : leaves(event.payload);
const valueAt = (object, path) => path.split('.').reduce((value, key) => value == null ? undefined : value[key], object);
// A field judged on a GA4 hit: GA4 omits empty values and sends booleans as text, and a field the
// website did push but Google did not receive points at the GTM tag, not at the website.
function receivedCheck(check, field, pushed) {
  if (check.verdict === 'PASS') return check;
  const pushedValue = pushed ? valueAt(pushed, check.path) : undefined;
  if (check.code === 'MISSING_FIELD') {
    if (pushed && (pushedValue === null || pushedValue === '')) return { ...check, verdict: 'PASS', code: undefined };
    if (!pushed && field?.op === 'type' && [].concat(field.value).includes('null')) return { ...check, verdict: 'PASS', code: undefined };
    if (pushedValue !== undefined) return { ...check, code: 'NOT_FORWARDED', pushed: pushedValue };
  }
  if (check.code === 'WRONG_TYPE' && [].concat(field?.value).includes('boolean') && ['true', 'false'].includes(check.actual)) return { ...check, verdict: 'PASS', code: undefined };
  return check;
}

/**
 * Checks one captured event against one specification case without a QA step:
 * dynamic values (`ref`) only need to be present, every other rule is applied as written.
 */
function evaluate(testCase, rule, event) {
  if (event.capture?.incomplete) return { checks: [{ code: 'CAPTURE_INCOMPLETE', verdict: 'REVIEW' }], score: 0 };
  // An AppOTA_Insider row (R1511…) describes the event as Insider records it: a web Insider hit is
  // judged in that form, without the fields only the app sends (app_version, device_*, os_version, platform).
  const appRow = rule.capture_platform === 'APP_SDK', webAsInsider = appRow && event.insider_view;
  const payload = webAsInsider ? event.insider_view : event.payload;
  const referenceOnly = appRow && !(payload?.default_parameters && payload?.custom_parameters);
  const fields = Object.entries(rule.fields ?? {}).filter(([path]) => !(webAsInsider && APP_ONLY_FIELD.test(path)));
  let checks = referenceOnly ? [{ code: 'SPEC_PLATFORM_MISMATCH', verdict: 'REVIEW', expected: 'APP_SDK', actual: 'WEB', evidence_id: event.evidence_id }]
    : fields.map(([path, field]) => checkField(payload, path, field?.op === 'ref' ? { op: 'exists' } : field, {}, event.evidence_id));
  if (event.received_by_google) checks = checks.map(check => receivedCheck(check, rule.fields?.[check.path], event.pushed));
  if (!referenceOnly && (!Object.keys(rule.fields ?? {}).length || ['partial', 'unparsed'].includes(rule.sample_status))) checks.push({ code: !Object.keys(rule.fields ?? {}).length ? 'NO_EXPECTED_FIELDS' : 'SPEC_INCOMPLETE', verdict: 'REVIEW', evidence_id: event.evidence_id });
  const fixed = Object.entries(rule.fields ?? {}).filter(([, field]) => field?.op === 'eq' || field?.op === 'one_of').map(([path]) => path);
  const failedFixed = checks.filter(check => check.verdict !== 'PASS' && fixed.includes(check.path)).length;
  const passed = checks.filter(check => check.verdict === 'PASS').length;
  // Sample values that reappear in the event (service, breadcrumb, taxonomy...) identify the flow.
  let similar = 0;
  if (testCase.sample) {
    const expected = leaves(testCase.sample);
    for (const [path, value] of observedLeaves(event)) {
      const sample = expected.get(path);
      if (typeof sample === 'string' && typeof value === 'string' && sample.length <= 60 && sample.toLowerCase() === value.toLowerCase()) similar++;
    }
  }
  return { checks, score: passed + 2 * similar - 10 * failedFixed + flowHint(testCase.flow, event) };
}

// Page paths of booking flows, matched against the flow names used in specifications.
const FLOW_PATHS = [
  [/\/(?:flight|ve-may-bay)(?:\/|$)/i, /vé máy bay|ve may bay|flight/i], [/\/(?:hotel|khach-san)(?:\/|$)/i, /khách sạn|khach san|hotel/i],
  [/\/combo(?:\/|$)/i, /combo/i], [/\/(?:experience|attraction|ticket|vui-choi)(?:\/|$)/i, /vui chơi|trải nghiệm|experience|attraction/i],
  [/\/golf(?:\/|$)/i, /golf/i], [/\/(?:event|su-kien)(?:\/|$)/i, /^event$|sự kiện/i], [/\/train(?:\/|$)/i, /train|tàu/i],
  [/\/voucher(?:\/|$)/i, /voucher/i], [/\/(?:merchandise|shop)(?:\/|$)/i, /merchandise/i],
];
// The page path and the payload's own words (breadcrumb "Khách sạn", taxonomy "golf", service "hotel")
// name the flow; rows of the same event in other flows, or in "All", score lower.
function flowHint(flow, event) {
  if (!flow) return 0;
  let pathname = ''; try { pathname = new URL(event.page?.url).pathname; } catch { /* no page URL */ }
  const page = FLOW_PATHS.find(([path]) => path.test(pathname));
  const words = [...observedLeaves(event).values()].filter(value => typeof value === 'string' && value.length <= 60 && !/^https?:/i.test(value));
  const named = FLOW_PATHS.filter(([, name]) => words.some(word => name.test(word)));
  return (page?.[1].test(flow) ? 3 : 0) + (named.some(([, name]) => name.test(flow)) ? 3 : 0);
}

/** Assigns each captured event to the specification row it most likely implements. */
export function matchEvent(cases, event, index = indexCases(cases)) {
  if (!isBusinessEvent(event)) return null;
  if (event.network?.phase && event.network.phase !== 'request') return null;
  // Rows are found by event name or by the name the vendor shows (an Insider "Item Added to Cart").
  const candidates = [...new Map([event.event_name, ...(event.aliases ?? [])].flatMap(name => index.get(`${event.layer}|${String(event.source).toUpperCase()}|${name}`) ?? [])
    .map(candidate => [candidate.testCase.id, candidate])).values()];
  let best = null, tied = [];
  for (const { testCase, rule } of candidates) {
    const result = evaluate(testCase, rule, event);
    if (!best || result.score > best.score) { best = { testCase, rule, ...result }; tied = [testCase.id]; }
    else if (result.score === best.score && !tied.includes(testCase.id)) tied.push(testCase.id);
  }
  if (!best) return null;
  if (tied.length > 1) return { case_id: null, verdict: 'REVIEW', ambiguous: true, candidate_case_ids: tied, fields: {}, issues: [{ code: 'AMBIGUOUS_SPEC', verdict: 'REVIEW', expected: 'One specification row', actual: tied }] };
  const issues = best.checks.filter(check => check.verdict !== 'PASS').map(({ path, op, code, expected, actual, verdict, pushed }) => ({ path, op, code, expected, actual, verdict, ...(pushed !== undefined ? { pushed } : {}) }));
  // Field paths the specification expects, so a viewer can mark every parameter of the event.
  const fields = Object.fromEntries(Object.entries(best.rule.fields ?? {}).map(([path, field]) => [path, field?.op]));
  return { case_id: best.testCase.id, verdict: issues.some(issue => issue.verdict === 'FAIL') ? 'FAIL' : issues.length ? 'REVIEW' : 'PASS', issues, fields, ambiguous: candidates.length > 1 && best.score <= 0 };
}

/**
 * The specification view of one record, judged on what reached the vendor. A GA4 push that was sent
 * is judged on its hit (Google's parameters, with the push to tell a missing push from a field the
 * GTM tag did not send); a push that never left the browser is NOT_SENT, or PENDING while it may
 * still be in GA4's batch. Insider pushes are judged as pushed once sent; Insider hits match
 * request-format rows as sent and AppOTA_Insider rows (R1511…) as the event Insider records.
 */
export function matchTracked(cases, event, { links = linkDeliveries([event]), now = Date.now(), index = indexCases(cases) } = {}) {
  if (!isBusinessEvent(event) || (event.network?.phase && event.network.phase !== 'request')) return null;
  if (event.layer === 'JS_QUEUE') {
    const hit = links.sentBy.get(event.evidence_id);
    if (hit && event.source === 'GA4') return matchTracked(cases, hit, { links, now, index });
    const match = matchEvent(cases, event, index);
    const status = deliveryStatus(event, links, now);
    if (!match || match.ambiguous || !['pending', 'not_sent'].includes(status)) return match;
    return { ...match, verdict: status === 'pending' ? 'PENDING' : 'NOT_SENT',
      issues: [{ code: status === 'pending' ? 'PENDING_DELIVERY' : 'NOT_SENT', verdict: status === 'pending' ? 'REVIEW' : 'FAIL', evidence_id: event.evidence_id }] };
  }
  if (event.source === 'GA4') {
    const push = links.pushOf.get(event.evidence_id);
    const received = { ...event, layer: 'JS_QUEUE', payload: ga4HitAsPush(event.payload), received_by_google: true, pushed: push?.payload };
    return matchEvent(cases, received, index) ?? matchEvent(cases, event, index);
  }
  // A web SDK hit is read as the event Insider records; an event already in that form (from the app) is kept.
  if (event.source === 'INSIDER' && !event.payload?.default_parameters && !event.payload?.custom_parameters) {
    const view = insiderHitView(event.event_name, event.payload);
    return matchEvent(cases, { ...event, aliases: [view.event], insider_view: view }, index);
  }
  return matchEvent(cases, event, index);
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
export function specCoverage(cases, events, cache = new Map(), { links = linkDeliveries(events), now = Date.now() } = {}) {
  const index = indexCases(cases);
  // A specification of one vendor (R1511 is Insider only) says nothing about the other's events.
  const specSources = new Set(cases.flatMap(testCase => (testCase.rules ?? []).map(rule => String(rule.source ?? testCase.source).toUpperCase())));
  const rows = new Map(cases.map(testCase => [testCase.id, {
    case_id: testCase.id, stt: testCase.stt ?? '', source: testCase.source ?? '', flow: testCase.flow ?? '', event_name: testCase.rules?.[0]?.event_name ?? testCase.name,
    layer: testCase.rules?.[0]?.layer ?? '', description: testCase.description ?? '', notes: testCase.notes ?? '', row: testCase.provenance?.row ?? null, sheet: testCase.provenance?.sheet ?? null,
    capture_platform: testCase.capture_platform, sample_status: testCase.sample_import?.status,
    seen: 0, pass: 0, fail: 0, review: 0, not_sent: 0, pending: 0, last_at: null, last_evidence_id: null, last_fail_evidence_id: null, issues: [],
  }]));
  const unmatched = new Map();
  for (const event of events) {
    if (!isBusinessEvent(event)) continue;
    if (event.network?.phase && event.network.phase !== 'request') continue;
    // Each fired event counts once: a sent GA4 push through its hit, a pushed Insider event through its push.
    if (event.layer === 'JS_QUEUE' && event.source === 'GA4' && links.sentBy.has(event.evidence_id)) continue;
    const carriedPush = event.layer === 'TRACKING_REQUEST' && event.source !== 'GA4' && links.pushOf.has(event.evidence_id);
    // Delivery can still change (a hit arrives, a pending push expires): it is part of the cache key.
    const key = `${event.evidence_id}|${deliveryStatus(event, links, now) ?? ''}|${links.sentBy.get(event.evidence_id)?.evidence_id ?? links.pushOf.get(event.evidence_id)?.evidence_id ?? ''}`;
    let match = cache.get(key);
    if (match === undefined) { match = matchTracked(cases, event, { links, now, index }); cache.set(key, match); }
    if (!match || match.ambiguous) {
      if (carriedPush || SETUP_EVENT.test(event.event_name) || !specSources.has(String(event.source).toUpperCase())) continue;
      const key = `${event.source}|${event.event_name}`;
      const entry = unmatched.get(key) ?? { source: event.source, event_name: event.event_name, count: 0, last_evidence_id: null, page: event.page?.url ?? '', ambiguous: Boolean(match?.ambiguous), candidate_case_ids: match?.candidate_case_ids };
      entry.count++; entry.last_evidence_id = event.evidence_id; unmatched.set(key, entry);
      continue;
    }
    const row = rows.get(match.case_id); if (!row) continue;
    if (match.verdict === 'NOT_SENT' || match.verdict === 'PENDING') {
      row[match.verdict === 'NOT_SENT' ? 'not_sent' : 'pending']++; row.last_evidence_id ??= event.evidence_id;
      if (match.verdict === 'NOT_SENT') row.last_fail_evidence_id = event.evidence_id;
      continue;
    }
    row.seen++; row[match.verdict.toLowerCase()]++; row.last_at = event.captured_at; row.last_evidence_id = event.evidence_id;
    if (match.verdict !== 'PASS') row.last_fail_evidence_id = event.evidence_id;
    for (const issue of match.issues) if (row.issues.length < 12 && !row.issues.some(known => known.path === issue.path && known.code === issue.code)) row.issues.push(issue);
  }
  const list = [...rows.values()];
  // NOT_SENT: the website pushed the event but no request carried it to the vendor.
  for (const row of list) row.status = row.seen ? (row.fail ? 'MISMATCH' : row.review ? 'REVIEW' : 'MATCH') : row.not_sent ? 'NOT_SENT' : row.pending ? 'PENDING' : 'NOT_SEEN';
  const totals = { rows: list.length, seen: list.filter(row => row.seen).length, match: list.filter(row => row.status === 'MATCH').length,
    mismatch: list.filter(row => row.status === 'MISMATCH').length, not_sent: list.filter(row => row.status === 'NOT_SENT').length, not_seen: list.filter(row => row.status === 'NOT_SEEN').length,
    unmatched: [...unmatched.values()].filter(item => !item.ambiguous).length, ambiguous: [...unmatched.values()].filter(item => item.ambiguous).length };
  return { totals, rows: list, unmatched: [...unmatched.values()].sort((a, b) => b.count - a.count) };
}
