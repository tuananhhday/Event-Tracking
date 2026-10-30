import { randomUUID } from 'node:crypto';
import { activityEvent, activityChannel, comparisonPayload } from './activity.mjs';
import { checkField, getPath } from './rules.mjs';
import { flowId, FLOWS } from './flows.mjs';
import { redact } from './privacy.mjs';

export const GUIDED_PLAN_SCHEMA = {
  type: 'object', required: ['title', 'steps'], additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    steps: { type: 'array', minItems: 1, maxItems: 200, items: {
      type: 'object', required: ['title', 'instruction', 'expected_case_ids'], additionalProperties: false,
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        instruction: { type: 'string', minLength: 1, maxLength: 5000 },
        optional: { type: 'boolean' }, branch: { enum: ['success', 'failure'] },
        expected_case_ids: { type: 'array', minItems: 1, maxItems: 200, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 250 } },
      },
    } },
  },
};

const plain = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();
const upper = value => String(value ?? '').toUpperCase();
const objects = value => value && typeof value === 'object' && !Array.isArray(value);
const unique = values => [...new Set(values)];
const BUSINESS_NAMES = { add_to_cart: 'item_added_to_cart', remove_from_cart: 'item_removed_from_cart' };
const SETUP = /^(?:gtm\.|gtag\.|insider_|ecommerce_reset$|QUEUE_ITEM$|UNPARSED$|tracking_request$|config$|consent$|js$|set$)/;
const SDK_INTERNAL = /^(?:pageView$|(?:Ucd|Hit|NativeSdk|NativeOptIn|Submit):)/i;

export function eligibleGuidedCases(cases = [], flow) {
  if (!Array.isArray(cases)) return [];
  const target = flowId(flow);
  return cases.filter(c => Array.isArray(c.rules) && c.rules.length && (!flow || (target !== 'unknown' ? flowId(c.flow) === target : plain(c.flow) === plain(flow))));
}

/** AI may arrange existing requirements; it cannot supply or approve expectations. */
export function validateGuidedProposal(proposal, cases = []) {
  if (!objects(proposal) || typeof proposal.title !== 'string' || !proposal.title.trim() || proposal.title.length > 200 || !Array.isArray(proposal.steps) || !proposal.steps.length || proposal.steps.length > 200) return 'INVALID_AI_GUIDE';
  if (Object.keys(proposal).some(key => !['title', 'steps'].includes(key))) return 'INVALID_AI_GUIDE_FIELDS';
  const allowed = new Set(cases.map(c => c.id));
  const byId = new Map(cases.map(c => [c.id, c]));
  if (allowed.size !== cases.length || !allowed.size) return 'INVALID_GUIDE_REQUIREMENTS';
  const seen = new Set();
  for (const step of proposal.steps) {
    if (!objects(step) || Object.keys(step).some(key => !['title', 'instruction', 'expected_case_ids', 'case_ids', 'optional', 'branch'].includes(key))) return 'INVALID_AI_GUIDE_STEP';
    if (step.optional !== undefined && typeof step.optional !== 'boolean' || step.branch !== undefined && !['success', 'failure'].includes(step.branch)) return 'INVALID_AI_GUIDE_STEP';
    if (typeof step.title !== 'string' || !step.title.trim() || step.title.length > 200 || typeof step.instruction !== 'string' || !step.instruction.trim() || step.instruction.length > 5000) return 'INVALID_AI_GUIDE_STEP';
    const ids = step.expected_case_ids ?? step.case_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 200) return 'INVALID_AI_GUIDE_CASE_IDS';
    for (const id of ids) {
      if (typeof id !== 'string' || !allowed.has(id)) return 'INVALID_AI_GUIDE_UNKNOWN_CASE';
      if (seen.has(id)) return 'INVALID_AI_GUIDE_DUPLICATE_CASE';
      seen.add(id);
    }
    const names = ids.flatMap(id => byId.get(id).rules.map(rule => rule.event_name));
    if (names.some(name => /^(?:purchase|payment)_(?:fail|failed|failure|error)$/.test(name)) && names.some(name => ['purchase', 'confirmation_page_view', 'payment_success'].includes(name))) return 'INVALID_AI_GUIDE_ALTERNATIVE_OUTCOMES';
  }
  return seen.size === allowed.size ? null : 'INVALID_AI_GUIDE_INCOMPLETE';
}

const LABELS = {
  search_term: 'Từ khóa tìm kiếm', destination: 'Điểm đến đã chọn', destination_name: 'Tên điểm đến', destination_id: 'Mã điểm đến',
  start_date: 'Ngày bắt đầu', end_date: 'Ngày kết thúc', service_start_date: 'Ngày bắt đầu', service_end_date: 'Ngày kết thúc',
  using_date: 'Ngày sử dụng', using_date_str: 'Ngày sử dụng (yyyy-MM-dd)', checkin: 'Ngày nhận phòng', checkout: 'Ngày trả phòng',
  departure_date: 'Ngày khởi hành', return_date: 'Ngày về', quantity: 'Số lượng đã chọn', adults: 'Số người lớn', children: 'Số trẻ em',
  infants: 'Số em bé', quantity_adult: 'Số người lớn', quantity_child: 'Số trẻ em', quantity_infant: 'Số em bé',
  total: 'Tổng tiền mong muốn', value: 'Giá trị đơn mong muốn', price: 'Giá mong muốn', unit_price: 'Đơn giá mong muốn', unit_sale_price: 'Đơn giá sau giảm',
  product_id: 'Mã sản phẩm đã chọn', item_id: 'Mã sản phẩm đã chọn', product_name: 'Tên sản phẩm đã chọn', item_name: 'Tên sản phẩm đã chọn',
  currency: 'Đơn vị tiền', departure_code: 'Mã sân bay đi', arrival_code: 'Mã sân bay đến', nights: 'Số đêm',
};
const numeric = /^(?:quantity(?:_(?:adult|child|infant))?|adults|children|infants|total|value|price|unit_(?:sale_)?price|nights|service_duration)$/;
const identifier = /^(?:product_id|item_id|product_name|item_name|destination|destination_id|departure_code|arrival_code|currency)$/;
const leafName = path => String(path).split('.').at(-1).replace(/^c_/, '');
const contextType = (name, sample) => numeric.test(name) || typeof sample === 'number' ? 'number' : /(?:_date_str|start_date|end_date)$/.test(name) ? 'date' : 'text';

function contextFor(cases) {
  const fields = new Map(), bindings = [];
  for (const c of cases) for (const [ruleIndex, rule] of c.rules.entries()) {
    for (const [path, field] of Object.entries(rule.fields ?? {})) {
      const name = leafName(path);
      if (field?.op === 'ref' && typeof field.value === 'string' && field.value.startsWith('context.')) {
        const target = field.value.slice(8);
        if (!target || target.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) continue;
        if (!fields.has(target)) fields.set(target, { path: target, label: LABELS[target.split('.').at(-1)] || LABELS[name] || name,
          type: contextType(name, getPath(c.sample, path)), required: true, hint: 'Nhập giá trị bạn sẽ chọn trên website; không chép từ tracking thực tế.' });
      } else if (['type', 'exists'].includes(field?.op) && (numeric.test(name) && (name !== 'value' || typeof getPath(c.sample, path) === 'number') || identifier.test(name) || /(?:_date_str|start_date|end_date)$/.test(name))) {
        // Optional expected values are independent user input, scoped to an exact
        // case/field. Never apply the first item's price/quantity to other items.
        const target = `expected.c_${String(c.id).replace(/[^\w]/g, '_')}.p_${path.replace(/[^\w]/g, '_')}`;
        bindings.push({ case_id: c.id, rule_index: ruleIndex, parameter_path: path, context_path: target });
        if (!fields.has(target)) fields.set(target, { path: target, label: `${LABELS[name] || name} · ${c.source || rule.source || ''} / ${rule.event_name}`,
          type: contextType(name, getPath(c.sample, path)), required: false, hint: 'Không bắt buộc. Điền để kiểm đúng giá trị, ngoài kiểm sự có mặt/kiểu.' });
      }
    }
  }
  // Required references stay visible. Limit optional form size; uncollected
  // values remain explicitly unverified rather than being filled from examples.
  return { fields: [...fields.values()].filter(f => f.required).concat([...fields.values()].filter(f => !f.required).slice(0, 8)), bindings };
}

const negativeCase = c => c.rules.some(rule => /(?:^|_)(?:fail|failed|failure|error|cancel|cancelled)(?:_|$)/i.test(rule.event_name));
const editCase = c => c.rules.some(rule => /^(?:remove_from_cart|item_removed_from_cart|remove from cart)$/.test(rule.event_name));
function stageRank(c) {
  const name = c.rules[0]?.event_name || '', text = plain(c.description);
  if (/^(?:login|login_success)$/.test(name)) return 0;
  if (/^(?:search_|search_submit$)/.test(name)) return 10;
  // In the supplied Golf spec, GA4 view_item_list fires on facility details,
  // unlike Insider listing_page_view on search results. Do not conflate them.
  if (/chi tiet|detail/.test(text) && /^(?:view_item_list|view_item|product_detail_page_view)$/.test(name)) return 30;
  if (/^(?:listing_page_view|view_item_list|search_result_list)$/.test(name)) return 20;
  if (/^(?:product_detail_page_view|view_item)$/.test(name)) return 30;
  if (/^(?:select_item|search_result_select)$/.test(name)) return 35;
  if (/^(?:add_to_cart|item_added_to_cart)$/.test(name)) return 40;
  if (editCase(c)) return 45;
  if (/^(?:cart_page_view|view_cart)$/.test(name)) return 50;
  if (name === 'begin_checkout') return 55;
  if (/(?:^|_)checkout$/.test(name)) return 60;
  if (/^(?:add_payment_info|add_shipping_info)$/.test(name)) return 70;
  if (/^(?:purchase|confirmation_page_view|payment_success)$/.test(name)) return 80;
  if (negativeCase(c)) return 85;
  return 50;
}
function fallbackProposal(cases, title) {
  const groups = new Map();
  for (const c of [...cases].sort((a, b) => stageRank(a) - stageRank(b))) {
    const trigger = String(c.description || '').trim();
    const key = trigger ? plain(trigger).replace(/\s+/g, ' ') : `case:${c.id}`;
    if (!groups.has(key)) groups.set(key, { title: c.name || c.rules[0].event_name, instruction: trigger || `Thực hiện thao tác phát event “${c.rules[0].event_name}” theo yêu cầu. File chưa mô tả trigger; cần xác nhận thao tác trước khi nghiệm thu.`, expected_case_ids: [] });
    if (c.rules.some(rule => /^(?:page_view|homepage_view|listing_page_view|product_detail_page_view|cart_page_view|view_item|view_item_list)$/.test(rule.event_name)) && !/bấm|click|submit/i.test(trigger)) {
      groups.get(key).instruction = `Bấm “Bắt đầu bước”, sau đó mở hoặc tải lại trang cần kiểm tra trong luồng này. Yêu cầu trong file: ${trigger || c.rules[0].event_name}`;
    }
    groups.get(key).expected_case_ids.push(c.id);
    if (negativeCase(c)) {
      groups.get(key).optional = true; groups.get(key).branch = 'failure';
    }
    if (editCase(c)) groups.get(key).optional = true;
  }
  return { title, steps: [...groups.values()] };
}

export function buildGuidedPlan(cases = [], { flow, url = '', aiPlan } = {}) {
  const eligible = eligibleGuidedCases(cases, flow);
  if (!eligible.length) throw new Error('GUIDED_NO_CASES');
  const selectedFlow = flowId(flow || eligible[0].flow);
  const title = `Kiểm tra ${FLOWS[selectedFlow] || flow || 'tracking'}`;
  if (aiPlan && validateGuidedProposal(aiPlan, eligible)) throw new Error(validateGuidedProposal(aiPlan, eligible));
  const proposal = aiPlan || fallbackProposal(eligible, title);
  const byId = new Map(eligible.map(c => [c.id, c]));
  const planId = `GUIDE-${randomUUID()}`;
  const steps = proposal.steps.map((item, index) => {
    const ids = item.expected_case_ids || item.case_ids;
    const selected = ids.map(id => byId.get(id));
    const context = contextFor(selected);
    const failure = selected.some(negativeCase);
    const expected = selected.flatMap(c => c.rules.map(rule => ({ case_id: c.id, event_name: rule.event_name, source: rule.source || c.source,
      layer: rule.layer, description: c.description || '', provenance: c.provenance || null, needs_review: !!(c.needs_review || rule.needs_review) })));
    return { id: `${planId}-STEP-${index + 1}`, index: index + 1, title: item.title, instruction: item.instruction,
      flow: selectedFlow, case_ids: ids, expected_case_ids: ids, expected, expected_events: expected,
      optional: !!item.optional || failure || selected.some(editCase), ...(failure || item.branch ? { branch: failure ? 'failure' : item.branch } : {}),
      context_fields: context.fields, parameter_context: context.bindings, provenance: selected.map(c => c.provenance).filter(Boolean) };
  });
  return redact({ id: planId, title: proposal.title || title, flow: selectedFlow, flow_label: FLOWS[selectedFlow] || flow || '', url,
    guidance_source: aiPlan ? 'ai' : 'requirements', steps,
    warnings: aiPlan ? [] : ['Hướng dẫn lấy từ mô tả trong file yêu cầu; thứ tự bước là gợi ý theo loại thao tác, chưa có hướng dẫn do model AI tạo.'],
    case_ids: eligible.map(c => c.id), created_at: new Date().toISOString() });
}

const canonicalName = (source, name) => upper(source) === 'INSIDER' ? BUSINESS_NAMES[name] || name : name;
function sameName(c, rule, event) {
  const names = [rule.event_name, ...(rule.event_aliases || [])];
  return names.includes(event.event_name) || c.payload_format === 'default_custom_parameters' && names.includes(activityEvent(event).display_name);
}
function expectedChannel(c, rule) {
  if (rule.layer === 'TRACKING_REQUEST') return 'network';
  if (/Insider\.eventManager\.dispatch\s*\(/.test(c.sample_text || '')) return 'sdk';
  if (upper(rule.source || c.source) === 'GA4' || c.sample?.type || /(?:dataLayer|InsiderQueue)\.push\s*\(/.test(c.sample_text || '')) return 'queue';
  return upper(rule.source || c.source) === 'INSIDER' ? 'queue' : null;
}
function specificationConflicts(c, rule) {
  const conflicts = Array.isArray(c.spec_conflicts) ? c.spec_conflicts.slice() : [];
  const command = { homepage_view: 'home', listing_page_view: 'category', product_detail_page_view: 'product', cart_page_view: 'cart', confirmation_page_view: 'purchase' }[rule.event_name];
  if (upper(rule.source || c.source) === 'INSIDER' && command && c.sample?.type && !['custom_event', command].includes(c.sample.type)) {
    conflicts.push({ code: 'SPEC_SAMPLE_TYPE_CONFLICT', message: `Event ${rule.event_name} dùng mẫu type=${c.sample.type}; cần duyệt lại mẫu thay vì kết luận lỗi website.` });
  }
  if (c.sample_conflict && !conflicts.length) conflicts.push({ code: 'SPEC_CONFLICT', message: 'Yêu cầu và mẫu đang mâu thuẫn.' });
  return conflicts;
}
function observation(event) {
  const a = activityEvent(event);
  return { evidence_id: event.evidence_id, event_name: event.event_name, source: event.source, layer: event.layer,
    observation: a.observation, channel: activityChannel(event), flow: a.flow_id, flow_conflict: a.flow_conflict,
    captured_at: event.captured_at, payload: event.payload, original_payload: event.original_payload,
    parameters: a.json, parameter_origins: a.parameter_origins, network: event.network, incomplete: !!event.capture?.incomplete };
}
function leaves(value, path = '', out = [], depth = 0) {
  if (depth > 10 || out.length >= 2000) return out;
  if (value && typeof value === 'object' && Object.keys(value).length) {
    for (const [key, item] of Object.entries(value)) leaves(item, path ? `${path}.${key}` : key, out, depth + 1);
  } else if (path) out.push({ path, value });
  return out;
}
function expandedPaths(payload, path) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let prefixes = [''];
  for (const part of parts) {
    prefixes = prefixes.flatMap(prefix => {
      const parent = prefix ? getPath(payload, prefix) : payload;
      if (part === '0' && Array.isArray(parent) && parent.length) return parent.slice(0, 500).map((_, index) => prefix ? `${prefix}.${index}` : String(index));
      return [prefix ? `${prefix}.${part}` : part];
    });
  }
  return prefixes;
}
const fieldStatus = check => check.verdict === 'PASS' ? 'match' : check.verdict === 'REVIEW' ? 'review' : ['MISSING_FIELD', 'NULL_FIELD'].includes(check.code) ? 'missing' : 'mismatch';

/** Assesses only observations within the user-confirmed step window. It never
 * transforms queue-shaped requirements into network-shaped expectations. */
export function assessGuidedStep({ step, cases = [], events = [], context = {}, startedAt, completedAt, expectedUrl, observedLayers = ['JS_QUEUE', 'TRACKING_REQUEST'] } = {}) {
  if (!step?.id) throw new Error('GUIDED_STEP_REQUIRED');
  const ids = step.case_ids || step.expected_case_ids || [];
  const selected = cases.filter(c => ids.includes(c.id));
  if (selected.length !== ids.length || !selected.length) throw new Error('GUIDED_STEP_CASES_MISSING');
  const start = Date.parse(startedAt || step.started_at), end = completedAt ? Date.parse(completedAt) : Infinity;
  if (!Number.isFinite(start) || completedAt && (!Number.isFinite(end) || end < start)) throw new Error('GUIDED_INVALID_WINDOW');
  const scoped = events.filter(event => !event.historical && Number.isFinite(Date.parse(event.captured_at)) && Date.parse(event.captured_at) >= start && Date.parse(event.captured_at) <= end);
  const primary = scoped.filter(event => !event.network?.phase || event.network.phase === 'request');
  let expectedHost = null;
  try { expectedHost = expectedUrl ? new URL(expectedUrl).host : null; } catch {}
  const selectedWebsite = event => {
    if (!expectedHost) return true;
    try { return new URL(event.page?.url).host === expectedHost; } catch { return false; }
  };
  const consumed = new Set(), comparisons = [], required = [];
  for (const c of selected) for (const [ruleIndex, rule] of c.rules.entries()) {
    const source = upper(rule.source || c.source), channel = expectedChannel(c, rule);
    const expectedFlow = flowId(c.flow || step.flow);
    const named = primary.filter(event => upper(event.source) === source && event.layer === rule.layer && (!channel || activityChannel(event) === channel) && sameName(c, rule, event));
    const otherWebsite = named.some(event => !selectedWebsite(event));
    const actual = named.filter(event => {
      const observed = activityEvent(event);
      return selectedWebsite(event) && (expectedFlow === 'unknown' || observed.flow_id === 'unknown' || observed.flow_id === expectedFlow);
    });
    actual.forEach(e => consumed.add(e));
    required.push({ source, channel, event_name: canonicalName(source, rule.event_name), flow: expectedFlow });
    const issues = [], parameters = [], min = rule.count?.min ?? 1, max = rule.count?.max ?? 1;
    const conflicts = specificationConflicts(c, rule);
    for (const conflict of conflicts) issues.push({ ...conflict, status: 'review' });
    const layerAvailable = observedLayers.includes(rule.layer);
    const unreadable = primary.some(event => upper(event.source) === source && event.layer === rule.layer && (!channel || activityChannel(event) === channel)
      && (event.capture?.incomplete || event.network?.decode_status === 'UNPARSED'));
    const complete = !!completedAt;
    const draft = !!(c.needs_review || rule.needs_review);
    if (!layerAvailable) issues.push({ code: 'LAYER_UNAVAILABLE', status: 'review', expected: rule.layer, actual: observedLayers });
    else if (!complete) issues.push({ code: 'STEP_NOT_COMPLETED', status: 'review' });
    else if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) issues.push({ code: 'INVALID_RULE', status: 'review', expected: '0 <= min <= max' });
    else {
      if (actual.length < min) issues.push({ code: otherWebsite ? 'WEBSITE_UNVERIFIED' : unreadable ? 'CAPTURE_UNAVAILABLE' : 'MISSING_EVENT', status: unreadable || otherWebsite ? 'review' : 'missing', expected: { min }, actual: actual.length });
      if (actual.length > max) issues.push({ code: 'DUPLICATE_EVENT', status: 'mismatch', expected: { max }, actual: actual.length });
    }
    for (const event of actual) {
      const a = activityEvent(event), payload = comparisonPayload(c, event);
      if (a.flow_id === 'unknown' && expectedFlow !== 'unknown') issues.push({ code: 'FLOW_UNVERIFIED', status: 'review', evidence_id: event.evidence_id });
      if (a.flow_conflict) issues.push({ code: 'FLOW_CONFLICT', status: 'review', evidence_id: event.evidence_id });
      if (event.capture?.incomplete) { issues.push({ code: 'INCOMPLETE_CAPTURE', status: 'review', evidence_id: event.evidence_id }); continue; }
      for (const [path, field] of Object.entries(rule.fields || {})) {
        for (const expanded of expandedPaths(payload, path)) {
          const check = checkField(payload, expanded, field, context, event.evidence_id);
          const binding = (step.parameter_context || []).find(b => b.case_id === c.id && b.rule_index === ruleIndex && b.parameter_path === expanded);
          const supplied = binding ? getPath(context, binding.context_path) : undefined;
          const independent = supplied !== undefined && supplied !== '';
          const semantic = independent && ['type', 'exists'].includes(field.op) ? checkField(payload, expanded, { op: 'eq', value: supplied }, context, event.evidence_id) : null;
          const result = check.verdict === 'PASS' && semantic ? semantic : check;
          const unverified = result.verdict === 'PASS' && ['type', 'exists'].includes(field.op) && !independent;
          parameters.push({ path: expanded, label: LABELS[leafName(expanded)] || expanded, op: field.op,
            constraint: ['type', 'ref', 'exists', 'not_exists'].includes(field.op) ? { op: field.op, ...(field.value !== undefined ? { value: field.value } : {}) } : undefined,
            expected: independent ? supplied : result.expected ?? (field.op === 'exists' ? 'Phải có tham số' : null),
            actual: result.actual, status: conflicts.length || unverified ? 'review' : fieldStatus(result), code: conflicts.length ? 'SPEC_CONFLICT' : unverified ? 'VALUE_NOT_VERIFIED' : result.code || 'MATCH',
            structural_status: fieldStatus(check), expected_origin: independent ? 'operator_context' : field.op === 'ref' ? 'context' : 'requirement_rule',
            evidence_id: event.evidence_id });
        }
      }
      const expectedPaths = Object.keys(rule.fields || {});
      for (const leaf of leaves(payload)) {
        const normalizedPath = leaf.path.replace(/\.\d+(?=\.|$)/g, '.0');
        if (expectedPaths.some(path => path === leaf.path || path === normalizedPath || (leaf.path.startsWith(path + '.') && ['type', 'ignore'].includes(rule.fields[path]?.op) && !expectedPaths.some(other => other.startsWith(path + '.'))))) continue;
        if (/(?:^|\.)(?:gtm\.|gtag\.|processed$|event$|event_name$)/.test(leaf.path)) continue;
        parameters.push({ path: leaf.path, actual: leaf.value, expected: null, status: conflicts.length ? 'review' : 'extra', code: conflicts.length ? 'SPEC_CONFLICT' : 'ADDITIONAL_PARAMETER', severity: 'info', evidence_id: event.evidence_id });
      }
      if (rule.layer === 'TRACKING_REQUEST' && event.network?.request_id) {
        const lifecycle = scoped.filter(other => upper(other.source) === source && other.network?.request_id === event.network.request_id && (other.page?.target_id ?? null) === (event.page?.target_id ?? null));
        for (const transport of lifecycle) {
          if (transport.network?.phase === 'failed') issues.push({ code: 'REQUEST_FAILED', status: 'mismatch', actual: transport.network.error, evidence_id: transport.evidence_id });
          else if (Number(transport.network?.status) >= 400) issues.push({ code: 'HTTP_ERROR', status: 'mismatch', actual: transport.network.status, evidence_id: transport.evidence_id });
        }
      }
      if (rule.within_ms !== undefined) {
        const delta = Date.parse(event.captured_at) - start;
        if (!Number.isFinite(rule.within_ms) || rule.within_ms < 0) issues.push({ code: 'INVALID_RULE', status: 'review', evidence_id: event.evidence_id });
        else if (delta > rule.within_ms) issues.push({ code: 'TIMING_EXCEEDED', status: 'mismatch', expected: rule.within_ms, actual: delta, evidence_id: event.evidence_id });
      }
      if (rule.after && !primary.some(before => upper(before.source) === source && before.layer === rule.layer && before.event_name === rule.after && Date.parse(before.captured_at) <= Date.parse(event.captured_at) && primary.indexOf(before) < primary.indexOf(event))) {
        issues.push({ code: 'OUT_OF_ORDER', status: 'mismatch', expected: `after ${rule.after}`, evidence_id: event.evidence_id });
      }
    }
    if (max > 0 && (!Object.keys(rule.fields || {}).length || c.sample_available === false)) issues.push({ code: 'NO_EXPECTED_FIELDS', status: 'review' });
    const missing = parameters.filter(p => p.status === 'missing'), wrong = parameters.filter(p => p.status === 'mismatch'), extra = parameters.filter(p => p.status === 'extra');
    let status = conflicts.length ? 'review' : issues.some(i => i.status === 'missing') ? 'missing' : issues.some(i => i.status === 'mismatch') || missing.length || wrong.length ? 'mismatch'
      : issues.some(i => i.status === 'review') ? 'review' : 'match';
    const acceptance = draft || status === 'review' || parameters.some(p => p.status === 'review') ? 'review' : status === 'match' ? 'match' : 'mismatch';
    comparisons.push({ case_id: c.id, event_name: rule.event_name, source, layer: rule.layer, channel, status,
      acceptance_status: acceptance, needs_review: draft, trigger_verification: complete ? 'operator_confirmed_window' : 'pending',
      actual_count: actual.length, expected_count: { min, max }, expected_payload_sample: c.sample || null, expected_payload: c.sample || null,
      expected_rules: rule.fields || {}, actual_events: actual.map(observation), actual_payload: actual[0]?.payload ?? null,
      parameters, missing_parameters: missing, wrong_parameters: wrong, extra_parameters: extra, issues,
      provenance: c.provenance || null, description: c.description || '', notes: c.notes || '', spec_conflicts: conflicts });
  }
  const vendors = new Set(required.map(r => r.source));
  const extraEvents = primary.filter(event => {
    if (!selectedWebsite(event) || consumed.has(event) || event.diagnostic || SETUP.test(event.event_name) || SDK_INTERNAL.test(event.event_name)) return false;
    if (upper(event.source) === 'GA4' && /^(?:page_view|session_start|first_visit|user_engagement|scroll)$/.test(event.event_name)) return false;
    const source = upper(event.source), channel = activityChannel(event);
    if (!vendors.has(source)) return false;
    // Only the required observation source counts as extra. Other layers are
    // still in observations; they are not duplicate business events.
    return required.some(r => r.source === source && (!r.channel || r.channel === channel))
      && !required.some(r => r.source === source && r.event_name === canonicalName(source, event.event_name) && r.channel !== channel);
  }).map(event => ({ ...observation(event), status: 'extra', code: activityEvent(event).flow_id !== 'unknown' && step.flow && activityEvent(event).flow_id !== flowId(step.flow) ? 'WRONG_FLOW' : 'UNEXPECTED_EVENT_FOR_STEP' }));
  const counts = { expected_events: comparisons.length, actual_events: consumed.size + extraEvents.length,
    missing: comparisons.filter(r => r.status === 'missing').length, mismatch: comparisons.filter(r => r.status === 'mismatch').length,
    extra: extraEvents.length, review: comparisons.filter(r => r.acceptance_status === 'review').length,
    missing_parameters: comparisons.reduce((n, r) => n + r.missing_parameters.length, 0), wrong_parameters: comparisons.reduce((n, r) => n + r.wrong_parameters.length, 0),
    extra_parameters: comparisons.reduce((n, r) => n + r.extra_parameters.length, 0), observations: scoped.length };
  const status = counts.missing ? 'missing' : counts.mismatch ? 'mismatch' : counts.extra ? 'extra' : comparisons.some(r => r.status === 'review') ? 'review' : 'match';
  const acceptance = comparisons.some(r => r.acceptance_status === 'review') || !completeWindow(completedAt) ? 'review' : status === 'match' ? 'match' : 'mismatch';
  return redact({ step_id: step.id, title: step.title || '', status, acceptance_status: acceptance,
    verdict: acceptance === 'review' ? 'REVIEW' : acceptance === 'match' ? 'PASS' : 'FAIL', counts,
    summary: `Mong đợi ${counts.expected_events} event; ghi nhận ${counts.actual_events}. Thiếu ${counts.missing}, sai ${counts.mismatch}, ngoài bước ${counts.extra}.`,
    expected: comparisons, comparisons, extra_events: extraEvents, unexpected_events: extraEvents,
    observations: scoped.map(observation), started_at: startedAt || step.started_at, completed_at: completedAt || null,
    context, warnings: counts.review ? ['Một số yêu cầu hoặc giá trị chưa đủ căn cứ nghiệm thu. Kết quả vẫn hiển thị cụ thể phần thiếu/sai đã quan sát.'] : [] });
}
const completeWindow = value => !!value;
