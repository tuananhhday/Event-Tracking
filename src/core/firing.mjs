// Firing checks from the team's tracking guidelines (Martech WebOTA "Insider user guide",
// GA4 event sheets). They judge how an event was fired, independently of any specification row:
// Insider page data must be followed by `init`, events must reach the vendor, dates come in
// ISO + _str pairs, ecommerce data is reset first, and nothing is fired twice.

const INSIDER_PAGE_TYPES = new Set(['home', 'category', 'product', 'cart', 'purchase', 'other']);
// Queue pushes and the event name Insider sends to its servers for them.
const INSIDER_SERVER_NAME = { add_to_cart: 'item_added_to_cart', remove_from_cart: 'item_removed_from_cart' };
const GA4_ECOMMERCE = new Set(['view_item_list', 'view_item', 'select_item', 'add_to_cart', 'remove_from_cart', 'view_cart', 'begin_checkout', 'add_shipping_info',
  'add_payment_info', 'purchase', 'refund', 'search_result_list', 'search_result_select', 'view_promotion', 'select_promotion', 'purchase_fail']);
// Date parameters of the guidelines: each one is sent as ISO8601 and as yyyy-MM-dd in <name>_str.
// Insider convention only (guide 2.2.2); GA4 samples send plain yyyy-MM-dd without a _str twin.
const DATE_FIELDS = ['checkin', 'checkout', 'departure_date', 'return_date', 'arrival_date', 'using_date', 'service_date', 'service_start_date', 'service_end_date', 'start_date', 'end_date', 'play_date', 'event_date'];
const COUPON_ACTIONS = ['view_list', 'enter_code', 'apply_success', 'apply_failed', 'remove'];
const SYSTEM = /^(?:gtm\.|gtag\.|ecommerce_reset$|QUEUE_ITEM$)/;

export const FIRING_RULES = {
  INSIDER_INIT: 'Dữ liệu trang Insider phải có init theo sau',
  DELIVERED: 'Event phải được gửi lên server vendor',
  CUSTOM_EVENT_SHAPE: 'custom_event: value là mảng {event_name, event_parameters}',
  DATE_PAIR: 'Ngày có cặp field (ISO8601) + field_str (yyyy-MM-dd) khớp nhau',
  DESTINATION_PAIR: 'Địa điểm có destination + destination_id',
  DUPLICATE: 'Không bắn trùng',
  ECOMMERCE_RESET: 'GA4 ecommerce: push {ecommerce: null} trước event',
  ECOMMERCE_ITEMS: 'GA4 ecommerce: items có item_id, item_name',
  COUPON_ACTION: 'coupon_interacted.action thuộc danh sách quy định',
};

const time = event => Date.parse(event.captured_at);
const tab = event => event.page?.target_id ?? event.page?.url ?? '';
const isRequest = event => event.layer === 'TRACKING_REQUEST' && (!event.network?.phase || event.network.phase === 'request');
const sameTab = (a, b) => !a.page?.target_id || !b.page?.target_id || a.page.target_id === b.page.target_id;

function leaves(value, prefix = '', out = [], depth = 0) {
  if (value && typeof value === 'object' && !Array.isArray(value) && depth < 6) {
    for (const [key, child] of Object.entries(value)) leaves(child, prefix ? `${prefix}.${key}` : key, out, depth + 1);
  } else if (Array.isArray(value) && value.length && value[0] && typeof value[0] === 'object' && depth < 6) leaves(value[0], `${prefix}.0`, out, depth + 1);
  else if (prefix) out.push([prefix, value]);
  return out;
}

function dateChecks(payload) {
  const checks = [];
  const fields = new Map(leaves(payload).map(([path, value]) => [path, value]));
  const seen = new Set();
  for (const path of fields.keys()) {
    const leaf = path.split('.').at(-1).replace(/^c_/, '');
    const base = leaf.endsWith('_str') ? leaf.slice(0, -4) : leaf;
    if (!DATE_FIELDS.includes(base)) continue;
    const parent = path.slice(0, path.length - path.split('.').at(-1).length);
    const prefix = path.split('.').at(-1).startsWith('c_') ? 'c_' : '';
    const isoPath = `${parent}${prefix}${base}`, strPath = `${parent}${prefix}${base}_str`;
    if (seen.has(isoPath)) continue; seen.add(isoPath);
    const iso = fields.get(isoPath), str = fields.get(strPath);
    if (iso == null && str == null) continue;
    if (!fields.has(strPath) || str == null) { checks.push({ rule: 'DATE_PAIR', status: 'FAIL', message: `Có ${isoPath} nhưng thiếu ${strPath}` }); continue; }
    if (!fields.has(isoPath) || iso == null) { checks.push({ rule: 'DATE_PAIR', status: 'FAIL', message: `Có ${strPath} nhưng thiếu ${isoPath}` }); continue; }
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) || !Number.isFinite(Date.parse(iso))) checks.push({ rule: 'DATE_PAIR', status: 'FAIL', message: `${isoPath} không phải ISO8601: ${JSON.stringify(iso)}` });
    else if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) checks.push({ rule: 'DATE_PAIR', status: 'FAIL', message: `${strPath} không đúng yyyy-MM-dd: ${JSON.stringify(str)}` });
    else if (iso.slice(0, 10) !== str) checks.push({ rule: 'DATE_PAIR', status: 'FAIL', message: `${isoPath} (${iso.slice(0, 10)}) khác ${strPath} (${str})` });
    else checks.push({ rule: 'DATE_PAIR', status: 'PASS', message: `${base}: ${str}` });
  }
  return checks;
}

function destinationCheck(payload) {
  const fields = new Map(leaves(payload));
  for (const [path, value] of fields) {
    const leaf = path.split('.').at(-1);
    if (leaf !== 'destination' && leaf !== 'c_destination') continue;
    if (value == null || value === '') continue;
    const idPath = `${path}_id`;
    if (!fields.has(idPath) || fields.get(idPath) == null || fields.get(idPath) === '') return { rule: 'DESTINATION_PAIR', status: 'WARN', message: `Có ${path} = ${JSON.stringify(value)} nhưng ${idPath} trống` };
    return { rule: 'DESTINATION_PAIR', status: 'PASS', message: `${value} · ${fields.get(idPath)}` };
  }
  return null;
}

/** Checks for every captured event, keyed by evidence ID, plus a per-rule summary. */
export function firingChecks(events, { deliveryWindowMs = 30000, duplicateWindowMs = 1000 } = {}) {
  const ordered = events.filter(event => !event.capture?.incomplete && Number.isFinite(time(event))).sort((a, b) => time(a) - time(b));
  const queue = ordered.filter(event => event.layer === 'JS_QUEUE' && !event.historical);
  const requests = ordered.filter(isRequest);
  const used = new Set();
  const results = new Map();
  const add = (event, check) => { if (!check) return; if (!results.has(event.evidence_id)) results.set(event.evidence_id, []); results.get(event.evidence_id).push(check); };
  for (const event of events.filter(e => e.capture?.incomplete)) add(event, { rule: 'INCOMPLETE_CAPTURE', status: 'WARN', message: 'Payload thu chưa đầy đủ; không dùng mẫu thiếu để kết luận cách bắn của website.' });
  const deliveredBy = (event, name, source, test = () => true) => {
    const request = requests.find(candidate => !used.has(candidate.evidence_id) && candidate.source === source && candidate.event_name === name
      && time(candidate) >= time(event) - 2000 && time(candidate) <= time(event) + deliveryWindowMs && sameTab(event, candidate) && test(candidate));
    if (request) used.add(request.evidence_id);
    return request;
  };

  for (const [index, event] of queue.entries()) {
    const payload = event.payload ?? {};
    if (SYSTEM.test(event.event_name) && event.source === 'GA4') continue;

    // Duplicates: the same push again within a second on the same tab.
    const signature = JSON.stringify([event.event_name, event.payload]);
    const previous = queue.slice(Math.max(0, index - 20), index).reverse().find(other => tab(other) === tab(event) && time(event) - time(other) <= duplicateWindowMs && JSON.stringify([other.event_name, other.payload]) === signature);
    if (previous) add(event, event.queue_type === 'init'
      ? { rule: 'DUPLICATE', status: 'WARN', message: `init được push lại sau ${time(event) - time(previous)} ms: mỗi trang chỉ nên push init một lần, sau khi đủ dữ liệu user + trang`, evidence_id: previous.evidence_id }
      : { rule: 'DUPLICATE', status: 'FAIL', message: `Bắn lại y hệt sau ${time(event) - time(previous)} ms`, evidence_id: previous.evidence_id });

    if (event.source === 'INSIDER') {
      const type = event.queue_type;
      if (INSIDER_PAGE_TYPES.has(type)) {
        // Page data is only sent once `init` follows it (guide 2.0).
        const init = queue.slice(index + 1, index + 30).find(other => other.queue_type === 'init' && tab(other) === tab(event) && time(other) - time(event) <= 5000);
        add(event, init ? { rule: 'INSIDER_INIT', status: 'PASS', message: `init sau ${time(init) - time(event)} ms`, evidence_id: init.evidence_id }
          : { rule: 'INSIDER_INIT', status: 'FAIL', message: 'Không có init sau push: Insider sẽ không gửi page view này' });
        if (init) {
          const hit = deliveredBy(init, 'pageView', 'INSIDER');
          add(event, hit ? { rule: 'DELIVERED', status: 'PASS', message: `Insider đã gửi pageView${hit.payload?.page_type ? ` (page_type=${hit.payload.page_type})` : ''} sau ${time(hit) - time(event)} ms`, evidence_id: hit.evidence_id }
            : { rule: 'DELIVERED', status: 'WARN', message: 'Chưa thấy request pageView của Insider (hit.api) sau init' });
        }
      }
      if (type === 'custom_event') {
        const item = payload.value?.[0];
        const shapeOk = Array.isArray(payload.value) && item && typeof item.event_name === 'string' && item.event_parameters && typeof item.event_parameters === 'object';
        add(event, shapeOk ? { rule: 'CUSTOM_EVENT_SHAPE', status: 'PASS', message: 'Đúng cấu trúc' } : { rule: 'CUSTOM_EVENT_SHAPE', status: 'FAIL', message: 'value phải là mảng các {event_name, event_parameters}' });
      }
      if (type === 'custom_event' || INSIDER_SERVER_NAME[type]) {
        const name = INSIDER_SERVER_NAME[type] ?? event.event_name;
        const request = deliveredBy(event, name, 'INSIDER');
        add(event, request ? { rule: 'DELIVERED', status: 'PASS', message: `Insider đã nhận ${name} sau ${time(request) - time(event)} ms`, evidence_id: request.evidence_id }
          : { rule: 'DELIVERED', status: 'WARN', message: `Chưa thấy request ${name} gửi lên Insider trong ${deliveryWindowMs / 1000}s` });
      }
    }

    if (event.source === 'GA4' && !SYSTEM.test(event.event_name)) {
      if (GA4_ECOMMERCE.has(event.event_name)) {
        // GTM merges ecommerce objects across pushes unless the previous one is cleared.
        const before = queue.slice(Math.max(0, index - 5), index).reverse().find(other => tab(other) === tab(event) && other.source === 'GA4');
        add(event, before?.event_name === 'ecommerce_reset' && time(event) - time(before) <= 2000
          ? { rule: 'ECOMMERCE_RESET', status: 'PASS', message: 'Có {ecommerce: null} ngay trước' }
          : { rule: 'ECOMMERCE_RESET', status: 'WARN', message: 'Không có {ecommerce: null} ngay trước: dữ liệu ecommerce cũ có thể bị gộp vào' });
        const items = payload.ecommerce?.items;
        if (!Array.isArray(items) || !items.length) add(event, { rule: 'ECOMMERCE_ITEMS', status: 'FAIL', message: 'ecommerce.items rỗng hoặc không có' });
        else {
          const broken = items.findIndex(item => !item || item.item_id == null || item.item_id === '' || item.item_name == null || item.item_name === '');
          add(event, broken === -1 ? { rule: 'ECOMMERCE_ITEMS', status: 'PASS', message: `${items.length} item, đủ item_id/item_name` } : { rule: 'ECOMMERCE_ITEMS', status: 'FAIL', message: `items[${broken}] thiếu item_id hoặc item_name` });
        }
      }
      if (event.event_name === 'coupon_interacted') {
        add(event, COUPON_ACTIONS.includes(payload.action) ? { rule: 'COUPON_ACTION', status: 'PASS', message: payload.action } : { rule: 'COUPON_ACTION', status: 'FAIL', message: `action ${JSON.stringify(payload.action)} không thuộc ${COUPON_ACTIONS.join('/')}` });
      }
      const request = deliveredBy(event, event.event_name, 'GA4');
      add(event, request ? { rule: 'DELIVERED', status: 'PASS', message: `GA4 đã nhận sau ${time(request) - time(event)} ms`, evidence_id: request.evidence_id }
        : { rule: 'DELIVERED', status: 'WARN', message: `Chưa thấy request GA4 (/g/collect) cho ${event.event_name} trong ${deliveryWindowMs / 1000}s: tag GA4 chưa cấu hình, bị chặn, hoặc đang gom batch` });
    }

    if (event.source === 'INSIDER') for (const check of dateChecks(payload)) add(event, check);
    add(event, destinationCheck(payload));
  }

  for (const request of requests) if (request.source === 'INSIDER') for (const check of dateChecks(request.payload?.event_params ?? {})) add(request, check);

  const summary = Object.entries(FIRING_RULES).map(([rule, label]) => {
    const all = [...results.entries()].flatMap(([id, checks]) => checks.filter(check => check.rule === rule).map(check => ({ ...check, id })));
    return { rule, label, pass: all.filter(c => c.status === 'PASS').length, warn: all.filter(c => c.status === 'WARN').length, fail: all.filter(c => c.status === 'FAIL').length };
  });
  return { byEvent: results, summary };
}
