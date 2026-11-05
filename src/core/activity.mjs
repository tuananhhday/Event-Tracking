// Presentation of observed parameters. Never fill this from a specification or
// infer mobile device/app attributes from a desktop browser.
import { isGa4Transport, ga4Items } from './ga4-parameters.mjs';
import { eventKind } from './event-kind.mjs';
import { linkDeliveries, deliveryStatus, REPEAT_MS } from './delivery.mjs';
import { insiderDisplayName, insiderHitParameters, isInsiderStandardEvent } from './insider-hit.mjs';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const GA4_STANDARD = new Set(['currency', 'value', 'items', 'ecommerce', 'transaction_id', 'coupon', 'affiliation', 'shipping', 'tax', 'item_list_id', 'item_list_name', 'payment_type', 'shipping_tier', 'method', 'search_term', 'page_location', 'page_title', 'page_referrer']);
export function activityEvent(event) {
  const p = object(event.payload) ? event.payload : {};
  let defaults = Object.create(null), custom = Object.create(null), mapping = 'payload_fields';
  if (object(p.default_parameters) || object(p.custom_parameters)) {
    defaults = p.default_parameters || {}; custom = p.custom_parameters || {}; mapping = 'explicit_parameter_groups';
  } else if (event.source === 'INSIDER' && event.layer === 'TRACKING_REQUEST' && (object(p.event_params) || p.event === 'pageView')) {
    // What Insider received, listed as Insider records the event (see the AppOTA_Insider sheets).
    ({ default_parameters: defaults, custom_parameters: custom } = insiderHitParameters(p)); mapping = 'insider_event';
  } else {
    let params = p;
    if (event.source === 'INSIDER') {
      if (object(p.event_params)) { params = p.event_params; mapping = 'event_params'; }
      else if (p.type === 'custom_event' && object(p.value?.[0]?.event_parameters)) { params = p.value[0].event_parameters; mapping = 'value[0].event_parameters'; }
      else if (object(p.value)) { params = p.value; mapping = 'value'; }
    }
    const customEvent = event.source === 'INSIDER' && (p.type === 'custom_event' || !isInsiderStandardEvent(event.event_name));
    const entries = Object.entries(params).filter(([key]) => !['event', 'event_name', 'type', 'processed'].includes(key));
    for (const [key, value] of entries) {
      if (event.source === 'GA4' && isGa4Transport(key)) continue;
      if (event.source === 'INSIDER' && key === 'custom' && object(value)) custom = { ...custom, ...value };
      else if (event.source === 'INSIDER' && mapping === 'event_params' && key.startsWith('c_')) custom[key.slice(2)] = value;
      else if (customEvent && !['sid', 'session_id', 'timestamp', 'event_timestamp'].includes(key)) custom[key] = value;
      else if (event.source === 'GA4' && !GA4_STANDARD.has(key)) custom[key] = value;
      else defaults[key] = value;
    }
  }
  if (event.source === 'GA4') {
    const items = p.ecommerce?.items ?? ga4Items(p);
    if (items.length) { defaults.items = items; delete defaults.ecommerce; }
    if (object(p.ecommerce)) for (const [key, value] of Object.entries(p.ecommerce)) if (key !== 'items' && !Object.hasOwn(defaults, key)) defaults[key] = value;
    if (p.cu && !defaults.currency) defaults.currency = p.cu;
  }
  const display = event.source === 'INSIDER' ? insiderDisplayName(event.event_name) : event.event_name;
  return {
    evidence_id: event.evidence_id, event_name: event.event_name, display_name: display,
    captured_at: event.captured_at, source: event.source, layer: event.layer,
    historical: !!event.historical, capture: event.capture || null, event_kind: eventKind(event),
    parameter_mapping: mapping,
    json: { event: display, default_parameters: defaults, custom_parameters: custom,
      ...(event.capture?.incomplete ? { _capture: event.capture } : {}) },
  };
}

const pathOf = url => { try { const parsed = new URL(url); return parsed.host + parsed.pathname; } catch { return url ?? ''; } };

// One row per event: a push and the vendor hit that sent it share a row, one-to-one; two hits stay
// two occurrences even with identical payloads. Rows show what the vendor received (Google's GA4
// parameters, the event Insider records); the push stays as evidence. `delivery` says whether the
// push left the browser (delivery.mjs); `repeat` marks a hit repeating the previous one of its kind
// (same vendor, GA4 property, event and page).
export function activityEntries(events, { links = linkDeliveries(events), now = Date.now() } = {}) {
  const rows = [], rowOf = new Map();
  const entry = event => ({ ...activityEvent(event), page: event.page, evidence_ids: [event.evidence_id], layers: [event.layer], delivery: deliveryStatus(event, links, now),
    ...(event.source === 'GA4' && event.layer === 'TRACKING_REQUEST' && event.payload?.tid ? { measurement_id: event.payload.tid } : {}) });
  for (const event of events) {
    if (event.network?.phase && event.network.phase !== 'request') continue;
    const push = links.pushOf.get(event.evidence_id);
    if (push) {
      // insider_object can be recorded just after its page hit: the push row is created here then.
      let row = rowOf.get(push.evidence_id);
      if (!row) { row = entry(push); rows.push(row); rowOf.set(push.evidence_id, row); }
      const received = activityEvent(event);
      row.evidence_ids.push(event.evidence_id); row.layers.push(event.layer); row.sent_by = event.evidence_id; row.delivery = 'sent'; row.sent_at = event.captured_at;
      row.json = { ...received.json, event: row.display_name }; row.parameter_mapping = received.parameter_mapping;
      if (event.source === 'GA4' && event.payload?.tid) row.measurement_id = event.payload.tid;
      continue;
    }
    if (rowOf.has(event.evidence_id)) continue;
    const row = entry(event);
    rows.push(row); rowOf.set(event.evidence_id, row);
  }
  const last = new Map();
  for (const row of rows) {
    if (row.delivery !== 'sent' || row.event_kind !== 'business') continue;
    const key = `${row.source}|${row.measurement_id ?? ''}|${row.event_name}|${pathOf(row.page?.url)}`, at = Date.parse(row.sent_at ?? row.captured_at), previous = last.get(key);
    if (previous && at - previous.at <= REPEAT_MS) row.repeat = { evidence_id: previous.row.evidence_id, after_ms: at - previous.at };
    last.set(key, { row, at });
  }
  return rows;
}
