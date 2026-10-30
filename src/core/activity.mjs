// Presentation of observed parameters. Never fill this from a specification or
// infer mobile device/app attributes from a desktop browser.
import { inferEventFlow } from './flows.mjs';
const INSIDER_NAMES = {
  homepage_view: 'Homepage View', listing_page_view: 'Listing Page View', product_detail_page_view: 'Product Page View',
  cart_page_view: 'Cart Page View', confirmation_page_view: 'Purchase', purchase: 'Purchase',
  add_to_cart: 'Item Added to Cart', item_added_to_cart: 'Item Added to Cart', remove_from_cart: 'Item Removed from Cart', item_removed_from_cart: 'Item Removed from Cart',
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function activityEvent(event) {
  const p = object(event.payload) ? event.payload : {};
  let defaults = Object.create(null), custom = Object.create(null), mapping = 'payload_fields';
  const origins = Object.create(null);
  const origin = (group, key, path) => {
    let original = path;
    const decoded = event.decoded_parameter_origins?.[path.replace(/^payload\./, '')];
    if (decoded) original = decoded;
    else if (event.original_payload && Number.isInteger(event.original_event_index)) {
      if (event.queue_type === 'custom_event') original = path.replace(/^payload\.value\[0\]/, `original_payload.value[${event.original_event_index}]`);
      else original = path.replace(/^payload\./, `original_payload.events[${event.original_event_index}].`);
    }
    origins[`${group}.${key}`] = original;
  };
  if (object(p.default_parameters) || object(p.custom_parameters)) {
    defaults = p.default_parameters || {}; custom = p.custom_parameters || {}; mapping = 'explicit_parameter_groups';
    for (const key of Object.keys(defaults)) origin('default_parameters', key, `payload.default_parameters.${key}`);
    for (const key of Object.keys(custom)) origin('custom_parameters', key, `payload.custom_parameters.${key}`);
  } else {
    let params = p;
    if (event.source === 'INSIDER') {
      if (object(p.event_params)) { params = p.event_params; mapping = 'event_params'; }
      else if (p.type === 'custom_event' && object(p.value?.[0]?.event_parameters)) { params = p.value[0].event_parameters; mapping = 'value[0].event_parameters'; }
      else if (object(p.value)) { params = p.value; mapping = 'value'; }
    }
    const entries = Object.entries(params).filter(([key]) => !['event', 'event_name', 'type', 'processed'].includes(key));
    const prefix = mapping === 'payload_fields' ? 'payload' : `payload.${mapping}`;
    for (const [key, value] of entries) {
      if (event.source === 'INSIDER' && key === 'custom' && object(value)) {
        for (const [name, item] of Object.entries(value)) {
          Object.defineProperty(custom, name, { value: item, enumerable: true, configurable: true, writable: true });
          origin('custom_parameters', name, `${prefix}.custom.${name}`);
        }
      } else if (event.source === 'INSIDER' && mapping === 'event_params' && key.startsWith('c_')) {
        Object.defineProperty(custom, key.slice(2), { value, enumerable: true, configurable: true, writable: true });
        origin('custom_parameters', key.slice(2), `${prefix}.${key}`);
      } else { defaults[key] = value; origin('default_parameters', key, `${prefix}.${key}`); }
    }
  }
  const display = event.source === 'INSIDER' ? INSIDER_NAMES[event.event_name]
    || String(event.event_name || '').split(/[_\s]+/).map(word => word ? word[0].toUpperCase() + word.slice(1) : '').join(' ') : event.event_name;
  return {
    evidence_id: event.evidence_id, event_name: event.event_name, display_name: display,
    captured_at: event.captured_at, source: event.source, layer: event.layer,
    historical: !!event.historical, capture: event.capture || null,
    parameter_mapping: mapping, parameter_origins: origins, queue_name: event.queue_name || null,
    diagnostic: !!event.diagnostic || (event.queue_type === 'dispatch' && event.event_name.includes(':')),
    observation: event.layer === 'TRACKING_REQUEST' ? 'network_request' : event.queue_type === 'sdk_before_send' ? 'sdk_before_send' : event.queue_name === 'InsiderDispatch' ? 'sdk_dispatch' : 'queue_push',
    sdk_event: event.sdk_event || null,
    ...inferEventFlow(event, { default_parameters: defaults, custom_parameters: custom }),
    json: { event: display, default_parameters: defaults, custom_parameters: custom,
      ...(event.capture?.incomplete ? { _capture: event.capture } : {}) },
  };
}

export function activityChannel(event) {
  if (event.layer === 'TRACKING_REQUEST') return 'network';
  if (event.queue_name === 'dataLayer' || event.queue_name === 'InsiderQueue') return 'queue';
  return 'sdk';
}

export function comparisonPayload(testCase, event) {
  return testCase.payload_format === 'default_custom_parameters' ? activityEvent(event).json : event.payload;
}
