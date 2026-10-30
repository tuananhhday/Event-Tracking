// Presentation of observed parameters. Never fill this from a specification or
// infer mobile device/app attributes from a desktop browser.
import { isGa4Transport, ga4Items } from './ga4-parameters.mjs';
import { eventKind } from './event-kind.mjs';
const INSIDER_NAMES = {
  homepage_view: 'Homepage View', listing_page_view: 'Listing Page View', product_detail_page_view: 'Product Page View',
  cart_page_view: 'Cart Page View', confirmation_page_view: 'Purchase', purchase: 'Purchase',
  add_to_cart: 'Item Added to Cart', item_added_to_cart: 'Item Added to Cart', remove_from_cart: 'Item Removed from Cart', item_removed_from_cart: 'Item Removed from Cart',
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const GA4_STANDARD = new Set(['currency', 'value', 'items', 'ecommerce', 'transaction_id', 'coupon', 'affiliation', 'shipping', 'tax', 'item_list_id', 'item_list_name', 'payment_type', 'shipping_tier', 'method', 'search_term']);
export function activityEvent(event) {
  const p = object(event.payload) ? event.payload : {};
  let defaults = Object.create(null), custom = Object.create(null), mapping = 'payload_fields';
  if (object(p.default_parameters) || object(p.custom_parameters)) {
    defaults = p.default_parameters || {}; custom = p.custom_parameters || {}; mapping = 'explicit_parameter_groups';
  } else {
    let params = p;
    if (event.source === 'INSIDER') {
      if (object(p.event_params)) { params = p.event_params; mapping = 'event_params'; }
      else if (p.type === 'custom_event' && object(p.value?.[0]?.event_parameters)) { params = p.value[0].event_parameters; mapping = 'value[0].event_parameters'; }
      else if (object(p.value)) { params = p.value; mapping = 'value'; }
    }
    const customEvent = event.source === 'INSIDER' && (p.type === 'custom_event' || !INSIDER_NAMES[event.event_name] && !['pageView', 'other_page_view'].includes(event.event_name));
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
  const display = event.source === 'INSIDER' ? INSIDER_NAMES[event.event_name]
    || String(event.event_name || '').split(/[_\s]+/).map(word => word ? word[0].toUpperCase() + word.slice(1) : '').join(' ') : event.event_name;
  return {
    evidence_id: event.evidence_id, event_name: event.event_name, display_name: display,
    captured_at: event.captured_at, source: event.source, layer: event.layer,
    historical: !!event.historical, capture: event.capture || null, event_kind: eventKind(event),
    parameter_mapping: mapping,
    json: { event: display, default_parameters: defaults, custom_parameters: custom,
      ...(event.capture?.incomplete ? { _capture: event.capture } : {}) },
  };
}

// Pair only a queue record and a request, one-to-one. Two outgoing requests
// remain two occurrences, even when their payloads are identical.
export function activityEntries(events) {
  const rows = [];
  const compatible = (a, b) => {
    if (a.source !== b.source || a.event_name !== b.event_name || a.historical !== b.historical || a.layer === b.layer || a.evidence_ids.length > 1) return false;
    if (Math.abs(Date.parse(a.captured_at) - Date.parse(b.captured_at)) > 1500) return false;
    if (a.page?.target_id && b.page?.target_id && a.page.target_id !== b.page.target_id) return false;
    if (a.page?.url && b.page?.url && a.page.url !== b.page.url) return false;
    const left = { ...a.json.default_parameters, ...a.json.custom_parameters }, right = { ...b.json.default_parameters, ...b.json.custom_parameters };
    const shared = Object.keys(left).filter(k => Object.hasOwn(right, k));
    return (shared.length > 0 || !Object.keys(left).length && !Object.keys(right).length) && shared.every(k => JSON.stringify(left[k]) === JSON.stringify(right[k]));
  };
  for (const event of events) {
    if (event.network?.phase && event.network.phase !== 'request') continue;
    const entry = { ...activityEvent(event), page: event.page, evidence_ids: [event.evidence_id], layers: [event.layer] };
    const pair = entry.event_kind === 'business' && rows.slice(-100).reverse().find(row => row.event_kind === 'business' && compatible(row, entry));
    if (!pair) { rows.push(entry); continue; }
    pair.evidence_ids.push(event.evidence_id); pair.layers.push(event.layer);
    // Use one observed payload in full; do not fabricate a union of parameters.
    if (JSON.stringify(entry.json).length > JSON.stringify(pair.json).length) {
      pair.json = entry.json; pair.evidence_id = entry.evidence_id; pair.parameter_mapping = entry.parameter_mapping;
    }
  }
  return rows;
}
