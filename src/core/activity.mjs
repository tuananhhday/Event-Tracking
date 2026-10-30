// Presentation of observed parameters. Never fill this from a specification or
// infer mobile device/app attributes from a desktop browser.
const INSIDER_NAMES = {
  homepage_view: 'Homepage View', listing_page_view: 'Listing Page View', product_detail_page_view: 'Product Page View',
  cart_page_view: 'Cart Page View', confirmation_page_view: 'Purchase', purchase: 'Purchase',
  add_to_cart: 'Item Added to Cart', item_added_to_cart: 'Item Added to Cart', remove_from_cart: 'Item Removed from Cart', item_removed_from_cart: 'Item Removed from Cart',
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
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
    const entries = Object.entries(params).filter(([key]) => !['event', 'event_name', 'type', 'processed'].includes(key));
    for (const [key, value] of entries) {
      if (event.source === 'INSIDER' && key === 'custom' && object(value)) custom = { ...custom, ...value };
      else if (event.source === 'INSIDER' && mapping === 'event_params' && key.startsWith('c_')) custom[key.slice(2)] = value;
      else defaults[key] = value;
    }
  }
  const display = event.source === 'INSIDER' ? INSIDER_NAMES[event.event_name]
    || String(event.event_name || '').split(/[_\s]+/).map(word => word ? word[0].toUpperCase() + word.slice(1) : '').join(' ') : event.event_name;
  return {
    evidence_id: event.evidence_id, event_name: event.event_name, display_name: display,
    captured_at: event.captured_at, source: event.source, layer: event.layer,
    historical: !!event.historical, capture: event.capture || null,
    parameter_mapping: mapping,
    json: { event: display, default_parameters: defaults, custom_parameters: custom,
      ...(event.capture?.incomplete ? { _capture: event.capture } : {}) },
  };
}
