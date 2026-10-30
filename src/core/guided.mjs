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

const sharedFlow = flow => /^(?:all|all luong|chung|common)$/.test(plain(flow));
const flowMatches = (c, flow) => !flow || (flowId(flow) !== 'unknown' ? flowId(c.flow) === flowId(flow) : plain(c.flow) === plain(flow));
export function eligibleGuidedCases(cases = [], flow, { selectedCaseIds } = {}) {
  if (!Array.isArray(cases)) return [];
  const usable = cases.filter(c => Array.isArray(c.rules) && c.rules.length);
  const matchesFlow = c => flowMatches(c, flow);
  if (selectedCaseIds === undefined) return usable.filter(matchesFlow);
  if (!Array.isArray(selectedCaseIds) || selectedCaseIds.some(id => typeof id !== 'string' || !id)) throw new Error('GUIDED_SELECTION_INVALID');
  if (!selectedCaseIds.length) throw new Error('GUIDED_SELECTION_EMPTY');
  if (new Set(selectedCaseIds).size !== selectedCaseIds.length) throw new Error('GUIDED_SELECTION_DUPLICATE');
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('GUIDED_INVALID_REQUIREMENTS');
  const byId = new Map(usable.map(c => [c.id, c]));
  for (const id of selectedCaseIds) {
    const c = byId.get(id);
    if (!c) throw new Error('GUIDED_SELECTION_UNKNOWN_CASE');
    if (!matchesFlow(c) && !sharedFlow(c.flow)) throw new Error('GUIDED_SELECTION_FLOW_MISMATCH');
  }
  const selected = new Set(selectedCaseIds);
  return usable.filter(c => selected.has(c.id));
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

export function buildGuidedPlan(cases = [], { flow, url = '', selectedCaseIds, aiPlan } = {}) {
  const eligible = eligibleGuidedCases(cases, flow, { selectedCaseIds });
  if (!eligible.length) throw new Error('GUIDED_NO_CASES');
  if (new Set(eligible.map(c => c.id)).size !== eligible.length) throw new Error('GUIDED_INVALID_REQUIREMENTS');
  const candidates = selectedCaseIds === undefined ? eligibleGuidedCases(cases, flow)
    : cases.filter(c => Array.isArray(c.rules) && c.rules.length && (flowMatches(c, flow) || sharedFlow(c.flow)));
  const selectedIds = new Set(eligible.map(c => c.id)), candidateIds = new Set(candidates.map(c => c.id));
  const selection = { selected_case_ids: [...selectedIds], excluded_case_ids: candidates.filter(c => !selectedIds.has(c.id)).map(c => c.id),
    out_of_scope_case_ids: cases.filter(c => !candidateIds.has(c.id)).map(c => c.id), total_candidates: candidates.length, selected_count: eligible.length,
    total_file_requirements: cases.length, total: candidates.length, selected: eligible.length, excluded: candidates.length - eligible.length };
  const selectedFlow = flowId(flow || eligible[0].flow);
  const title = `Kiểm tra ${sharedFlow(flow) ? 'chung' : FLOWS[selectedFlow] || flow || 'tracking'}`;
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
      flow: selectedFlow, case_ids: ids, expected_case_ids: ids, selected_case_ids: [...selectedIds], expected, expected_events: expected,
      optional: !!item.optional || failure || selected.some(editCase), ...(failure || item.branch ? { branch: failure ? 'failure' : item.branch } : {}),
      context_fields: context.fields, parameter_context: context.bindings, provenance: selected.map(c => c.provenance).filter(Boolean) };
  });
  return redact({ id: planId, title: proposal.title || title, flow: selectedFlow, flow_label: sharedFlow(flow) ? 'Chung' : FLOWS[selectedFlow] || flow || '', url,
    guidance_source: aiPlan ? 'ai' : 'requirements', steps,
    warnings: aiPlan ? [] : ['Hướng dẫn lấy từ mô tả trong file yêu cầu; thứ tự bước là gợi ý theo loại thao tác, chưa có hướng dẫn do model AI tạo.'],
    case_ids: eligible.map(c => c.id), selection, created_at: new Date().toISOString() });
}

const canonicalName = (source, name) => upper(source) === 'INSIDER' ? BUSINESS_NAMES[name] || name : name;
function sameName(c, rule, event) {
  const names = [rule.event_name, ...(rule.event_aliases || [])];
  return names.includes(event.event_name)
    || upper(rule.source || c.source) === 'INSIDER' && rule.layer === 'TRACKING_REQUEST' && names.some(name => canonicalName('INSIDER', name) === canonicalName('INSIDER', event.event_name))
    || c.payload_format === 'default_custom_parameters' && names.includes(activityEvent(event).display_name);
}
function expectedChannel(c, rule) {
  if (rule.layer === 'TRACKING_REQUEST') return 'network';
  if (/Insider\.eventManager\.dispatch\s*\(/.test(c.sample_text || '')) return 'sdk';
  if (upper(rule.source || c.source) === 'GA4' || c.sample?.type || /(?:dataLayer|InsiderQueue)\.push\s*\(/.test(c.sample_text || '')) return 'queue';
  return upper(rule.source || c.source) === 'INSIDER' ? 'queue' : null;
}
function specificationConflicts(c, rule) {
  const conflicts = Array.isArray(c.spec_conflicts) ? c.spec_conflicts.slice() : [];
  if (c.target_platform === 'APP') conflicts.push({ code: 'PLATFORM_REQUIREMENT_MISMATCH', message: 'Yêu cầu dành cho App điện thoại, chưa phải hợp đồng Web.' });
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
    parameters: a.json, parameter_origins: a.parameter_origins, network: event.network,
    ...(event.data_layer_model ? { data_layer_model: event.data_layer_model } : {}), incomplete: !!event.capture?.incomplete };
}
function leaves(value, path = '', out = [], depth = 0, limit) {
  if (depth > 10 || out.length >= 2000) { if (limit) limit.incomplete = true; return out; }
  if (value && typeof value === 'object' && Object.keys(value).length) {
    for (const [key, item] of Object.entries(value)) {
      if (out.length >= 2000) { if (limit) limit.incomplete = true; break; }
      leaves(item, path ? `${path}.${key}` : key, out, depth + 1, limit);
    }
  } else if (path) out.push({ path, value });
  return out;
}
const templateOperator = op => ['type', 'exists', 'not_exists', 'ignore'].includes(op);
function expandedPaths(payload, path, limit, expandArrays = true) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let prefixes = [''];
  for (const part of parts) {
    const next = [];
    outer: for (const prefix of prefixes) {
      const parent = prefix ? getPath(payload, prefix) : payload;
      if (expandArrays && part === '0' && Array.isArray(parent) && parent.length) {
        if (parent.length > 500 && limit) limit.incomplete = true;
        for (let index = 0; index < Math.min(parent.length, 500); index++) {
          if (next.length >= 2000) { if (limit) limit.incomplete = true; break outer; }
          next.push(prefix ? `${prefix}.${index}` : String(index));
        }
      } else {
        if (next.length >= 2000) { if (limit) limit.incomplete = true; break; }
        next.push(prefix ? `${prefix}.${part}` : part);
      }
    }
    prefixes = next;
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
      const workLimit = { incomplete: false };
      for (const [path, field] of Object.entries(rule.fields || {})) {
        if (parameters.length >= 10000) { workLimit.incomplete = true; break; }
        for (const expanded of expandedPaths(payload, path, workLimit, templateOperator(field.op))) {
          if (parameters.length >= 10000) { workLimit.incomplete = true; break; }
          const check = checkField(payload, expanded, field, context, event.evidence_id);
          const binding = (step.parameter_context || []).find(b => b.case_id === c.id && b.rule_index === ruleIndex && b.parameter_path === expanded);
          const supplied = binding ? getPath(context, binding.context_path) : undefined;
          const independent = supplied !== undefined && supplied !== '';
          const semantic = independent && ['type', 'exists'].includes(field.op) ? checkField(payload, expanded, { op: 'eq', value: supplied }, context, event.evidence_id) : null;
          const result = check.verdict === 'PASS' && semantic ? semantic : check;
          const unverified = result.verdict === 'PASS' && ['type', 'exists'].includes(field.op) && !independent;
          parameters.push({ path: expanded, requirement_path: path, label: LABELS[leafName(expanded)] || expanded, op: field.op,
            constraint: ['type', 'ref', 'exists', 'not_exists'].includes(field.op) ? { op: field.op, ...(field.value !== undefined ? { value: field.value } : {}) } : undefined,
            expected: independent ? supplied : result.expected ?? (field.op === 'exists' ? 'Phải có tham số' : null),
            actual: result.actual, status: conflicts.length || unverified ? 'review' : fieldStatus(result), code: conflicts.length ? 'SPEC_CONFLICT' : unverified ? 'VALUE_NOT_VERIFIED' : result.code || 'MATCH',
            structural_status: fieldStatus(check), expected_origin: independent ? 'operator_context' : field.op === 'ref' ? 'context' : 'requirement_rule',
            evidence_id: event.evidence_id });
        }
      }
      const expectedPaths = Object.keys(rule.fields || {});
      for (const leaf of leaves(payload, '', [], 0, workLimit)) {
        const normalizedPath = leaf.path.replace(/\.\d+(?=\.|$)/g, '.0');
        if (expectedPaths.some(path => path === leaf.path || path === normalizedPath && templateOperator(rule.fields[path]?.op) || (leaf.path.startsWith(path + '.') && ['type', 'ignore'].includes(rule.fields[path]?.op) && !expectedPaths.some(other => other.startsWith(path + '.'))))) continue;
        if (/(?:^|\.)(?:gtm\.|gtag\.|processed$|event$|event_name$)/.test(leaf.path)) continue;
        parameters.push({ path: leaf.path, actual: leaf.value, expected: null, status: conflicts.length ? 'review' : 'extra', code: conflicts.length ? 'SPEC_CONFLICT' : 'ADDITIONAL_PARAMETER', severity: 'info', evidence_id: event.evidence_id });
      }
      if (workLimit.incomplete) issues.push({ code: 'PARAMETER_CHECK_LIMIT', status: 'review', evidence_id: event.evidence_id, message: 'Chưa kiểm hết tham số/phần tử vì đạt giới hạn xử lý; không kết luận đã đầy đủ.' });
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
    const acceptance = draft || status === 'review' || issues.some(i => i.status === 'review') || parameters.some(p => p.status === 'review') ? 'review' : status === 'match' ? 'match' : 'mismatch';
    comparisons.push({ case_id: c.id, rule_index: ruleIndex, event_name: rule.event_name, source, layer: rule.layer, channel, status,
      acceptance_status: acceptance, needs_review: draft, trigger_verification: complete ? 'operator_confirmed_window' : 'pending',
      platform_verification: c.target_platform === 'WEB' ? 'web_requirement' : c.target_platform === 'APP' ? 'app_requirement' : 'not_declared',
      origin_verification: expectedHost ? actual.length ? 'selected_website' : 'not_observed' : 'not_configured',
      actual_count: actual.length, expected_count: { min, max }, expected_payload_sample: c.sample || null, expected_payload: c.sample || null,
      expected_rules: rule.fields || {}, actual_events: actual.map(observation), actual_payload: actual[0]?.payload ?? null,
      parameters, missing_parameters: missing, wrong_parameters: wrong, extra_parameters: extra, issues,
      provenance: c.provenance || null, description: c.description || '', notes: c.notes || '', spec_conflicts: conflicts });
  }
  const vendors = new Set(required.map(r => r.source));
  const planSelection = new Set(step.selected_case_ids || ids);
  const matchesKnownCase = (event, c) => c.rules?.some(rule => upper(rule.source || c.source) === upper(event.source)
    && rule.layer === event.layer && (!expectedChannel(c, rule) || expectedChannel(c, rule) === activityChannel(event)) && sameName(c, rule, event)
    && (flowId(c.flow) === 'unknown' || activityEvent(event).flow_id === 'unknown' || flowId(c.flow) === activityEvent(event).flow_id));
  const outOfSelection = event => !consumed.has(event) && !cases.some(c => planSelection.has(c.id) && matchesKnownCase(event, c))
    && cases.some(c => !planSelection.has(c.id) && matchesKnownCase(event, c));
  const extraEvents = primary.filter(event => {
    if (!selectedWebsite(event) || consumed.has(event) || outOfSelection(event) || event.diagnostic || SETUP.test(event.event_name) || SDK_INTERNAL.test(event.event_name)) return false;
    if (upper(event.source) === 'GA4' && /^(?:page_view|session_start|first_visit|user_engagement|scroll)$/.test(event.event_name)) return false;
    const source = upper(event.source), channel = activityChannel(event);
    if (!vendors.has(source)) return false;
    // Only the required observation source counts as extra. Other layers are
    // still in observations; they are not duplicate business events.
    return required.some(r => r.source === source && (!r.channel || r.channel === channel))
      && !required.some(r => r.source === source && r.event_name === canonicalName(source, event.event_name) && r.channel !== channel);
  }).map(event => ({ ...observation(event), status: 'extra', severity: 'info', code: activityEvent(event).flow_id !== 'unknown' && flowId(step.flow) !== 'unknown' && activityEvent(event).flow_id !== flowId(step.flow) ? 'WRONG_FLOW' : 'UNEXPECTED_EVENT_FOR_STEP' }));
  const counts = { expected_events: comparisons.length, actual_events: consumed.size + extraEvents.length,
    missing: comparisons.filter(r => r.status === 'missing').length, mismatch: comparisons.filter(r => r.status === 'mismatch').length,
    extra: extraEvents.length, review: comparisons.filter(r => r.acceptance_status === 'review').length,
    missing_parameters: comparisons.reduce((n, r) => n + r.missing_parameters.length, 0), wrong_parameters: comparisons.reduce((n, r) => n + r.wrong_parameters.length, 0),
    extra_parameters: comparisons.reduce((n, r) => n + r.extra_parameters.length, 0), observations: scoped.length };
  const status = counts.missing ? 'missing' : counts.mismatch ? 'mismatch' : counts.extra ? 'extra' : comparisons.some(r => r.status === 'review') ? 'review' : 'match';
  const acceptance = comparisons.some(r => r.acceptance_status === 'review') || !completeWindow(completedAt) || status === 'extra' ? 'review' : status === 'match' ? 'match' : 'mismatch';
  return redact({ step_id: step.id, title: step.title || '', status, acceptance_status: acceptance,
    verdict: acceptance === 'review' ? 'REVIEW' : acceptance === 'match' ? 'PASS' : 'FAIL', counts,
    summary: `Mong đợi ${counts.expected_events} event; ghi nhận ${counts.actual_events}. Thiếu ${counts.missing}, sai ${counts.mismatch}, ngoài bước ${counts.extra}.`,
    expected: comparisons, comparisons, extra_events: extraEvents, unexpected_events: extraEvents,
    observations: scoped.map(event => ({ ...observation(event), ...(outOfSelection(event) ? { scope_status: 'out_of_selection' } : {}) })), started_at: startedAt || step.started_at, completed_at: completedAt || null,
    context, warnings: counts.review ? ['Một số yêu cầu hoặc giá trị chưa đủ căn cứ nghiệm thu. Kết quả vẫn hiển thị cụ thể phần thiếu/sai đã quan sát.'] : [] });
}
const completeWindow = value => !!value;

const canonicalParameter = path => String(path).replace(/\[(\d+)\]/g, '.$1');
const normalizedParameter = path => canonicalParameter(path).replace(/\.\d+(?=\.|$)/g, '.0');
const semanticParameter = p => p.expected_origin === 'operator_context' || ['eq', 'ref', 'regex', 'range', 'one_of', 'subset', 'not_exists'].includes(p.op);

/** Coverage is scoped to the user's selection, with observed structure kept
 * separate from values verified against independent requirements/context. */
export function summarizeGuidedCompleteness(plan, results = [], cases = [], { currentStep } = {}) {
  if (!plan) return { selected: 0, executed: 0, skipped: 0, remaining: 0, excluded: 0, verified: 0, unverified: 0, requirements: [] };
  const ids = unique(plan.selection?.selected_case_ids || plan.case_ids || plan.steps.flatMap(s => s.case_ids || s.expected_case_ids || []));
  const byId = new Map(cases.map(c => [c.id, c]));
  const requirements = ids.map(id => {
    const c = byId.get(id), step = plan.steps.find(s => (s.case_ids || s.expected_case_ids || []).includes(id));
    const result = results.filter(r => (r.plan_step_id || r.step_id) === step?.id).at(-1);
    const rows = (result?.comparisons || result?.expected || []).filter(row => row.case_id === id);
    const fields = (c?.rules || []).flatMap((rule, index) => Object.entries(rule.fields || {}).map(([path, field]) => ({ index, path, canonical: canonicalParameter(path), normalized: normalizedParameter(path), template: templateOperator(field?.op) })));
    const checks = rows.flatMap(row => (row.parameters || []).map(p => ({ ...p, rule_index: row.rule_index ?? (c?.rules || []).findIndex(r => r.event_name === row.event_name && r.layer === row.layer) })));
    const counts = { total_parameters: fields.length, checked_parameters: 0, verified_parameters: 0, unverified_parameters: 0, missing_parameters: 0, wrong_parameters: 0,
      parameter_checks: { total: checks.length, structural_matched: 0, structural_failed: 0, semantic_matched: 0, semantic_failed: 0, unverified: 0, extra: 0 } };
    for (const p of checks) {
      const structural = p.structural_status || p.status;
      if (p.code === 'ADDITIONAL_PARAMETER' || p.status === 'extra') { counts.parameter_checks.extra++; continue; }
      if (structural === 'match') counts.parameter_checks.structural_matched++;
      else if (['missing', 'mismatch'].includes(structural)) counts.parameter_checks.structural_failed++;
      if (p.status === 'match' && semanticParameter(p)) counts.parameter_checks.semantic_matched++;
      else if (['missing', 'mismatch'].includes(p.status) && semanticParameter(p)) counts.parameter_checks.semantic_failed++;
      else if (p.status === 'review' || p.status === 'match' && !semanticParameter(p)) counts.parameter_checks.unverified++;
    }
    for (const field of fields) {
      const observed = checks.filter(p => p.rule_index === field.index && p.code !== 'ADDITIONAL_PARAMETER'
        && (p.requirement_path !== undefined ? p.requirement_path === field.path : field.template ? normalizedParameter(p.path) === field.normalized : canonicalParameter(p.path) === field.canonical));
      if (observed.length) counts.checked_parameters++;
      if (observed.some(p => p.status === 'missing')) counts.missing_parameters++;
      else if (observed.some(p => p.status === 'mismatch')) counts.wrong_parameters++;
      else if (observed.length && observed.every(p => p.status === 'match' && semanticParameter(p))) counts.verified_parameters++;
      else counts.unverified_parameters++;
    }
    const resultStatus = String(result?.status || result?.verdict || '').toLowerCase();
    let status;
    if (currentStep && (currentStep.plan_step_id || currentStep.id) === step?.id || resultStatus === 'running') status = 'in_progress';
    else if (!result) status = 'not_run';
    else if (['not_executed', 'skipped'].includes(resultStatus)) status = 'skipped';
    else if (rows.some(row => row.status === 'missing')) status = 'missing';
    else if (rows.some(row => row.status === 'mismatch')) status = 'mismatch';
    else {
      const expectedRuleCount = c?.rules?.length || 0;
      const absenceOnly = expectedRuleCount > 0 && c.rules.every(r => r.count?.max === 0);
      const unresolved = !expectedRuleCount || rows.length !== expectedRuleCount || rows.some(row => row.status !== 'match' || row.acceptance_status !== 'match' || row.needs_review
        || row.platform_verification !== 'web_requirement' || row.origin_verification !== 'selected_website' && !(absenceOnly && row.origin_verification !== 'not_configured')
        || row.issues?.some(issue => issue.status === 'review')) || counts.unverified_parameters > 0 || !fields.length && !absenceOnly;
      status = unresolved ? 'checked_unverified' : 'verified';
    }
    const pending = ['not_run', 'skipped', 'in_progress'].includes(status);
    return { case_id: id, step_id: step?.id, event_name: c?.rules?.[0]?.event_name || '', source: c?.source || '', flow: c?.flow || '', status,
      needs_review: !!c?.needs_review || rows.some(row => row.needs_review), total_rules: c?.rules?.length || 0, checked_rules: pending ? 0 : rows.length,
      ...counts, ...(pending ? { checked_parameters: 0, verified_parameters: 0, unverified_parameters: fields.length, missing_parameters: 0, wrong_parameters: 0,
        parameter_checks: { total: 0, structural_matched: 0, structural_failed: 0, semantic_matched: 0, semantic_failed: 0, unverified: 0, extra: 0 } } : {}) };
  });
  const selected = requirements.length, skipped = requirements.filter(r => r.status === 'skipped').length;
  const remaining = requirements.filter(r => ['not_run', 'in_progress'].includes(r.status)).length;
  return { selected, executed: selected - skipped - remaining, skipped, remaining,
    excluded: plan.selection?.excluded_case_ids?.length || 0, out_of_scope: plan.selection?.out_of_scope_case_ids?.length || 0,
    verified: requirements.filter(r => r.status === 'verified').length, unverified: requirements.filter(r => r.status === 'checked_unverified').length,
    missing: requirements.filter(r => r.status === 'missing').length, mismatch: requirements.filter(r => r.status === 'mismatch').length,
    complete: selected > 0 && requirements.every(r => r.status === 'verified'), requirements };
}
