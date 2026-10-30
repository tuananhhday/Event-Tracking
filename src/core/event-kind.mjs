// Event evidence includes SDK configuration and observed state as well as business
// events. Keep that evidence, but do not present a dispatcher signal as an action.
export const INSIDER_DISPATCH_EVENTS = new Set([
  'homepage_view', 'listing_page_view', 'product_detail_page_view',
  'cart_page_view', 'confirmation_page_view', 'other_page_view',
]);

const SYSTEM_NAME = /^(?:gtm\.|gtag\.|insider_(?:init|user|currency|locale|language|consent)$|ecommerce_reset$|config$|js$|set$|consent$)/i;
const GENERIC_NAME = /^(?:QUEUE_ITEM|UNPARSED|tracking_request|insider_dispatch|insider_object|custom_event)$/i;
const INSIDER_CONFIG = new Set(['init', 'user', 'currency', 'locale', 'language', 'consent']);
const INSIDER_QUEUE_EVENTS = new Set(['home', 'category', 'product', 'cart', 'purchase', 'other', 'add_to_cart', 'remove_from_cart']);
const named = value => typeof value === 'string' && value.trim().length > 0;

/** Conservative classification also supports evidence saved before event_kind existed. */
export function eventKind(event) {
  if (['business', 'system', 'observation'].includes(event.event_kind)) return event.event_kind;
  if (SYSTEM_NAME.test(event.event_name ?? '')) return 'system';
  if (event.queue_name === 'insider_object' || event.queue_type === 'insider_object') return 'observation';
  if (event.queue_name === 'InsiderDispatch' || event.queue_type === 'dispatch') {
    return INSIDER_DISPATCH_EVENTS.has(event.event_name) || named(event.payload?.event_name) ? 'business' : 'observation';
  }
  if (event.source === 'INSIDER' && event.layer === 'JS_QUEUE' && event.payload?.type) {
    const type = event.payload.type;
    if (INSIDER_CONFIG.has(type)) return 'system';
    if (INSIDER_QUEUE_EVENTS.has(type)) return 'business';
    if (type === 'custom_event' && named(event.payload.value?.[0]?.event_name)) return 'business';
    return 'observation';
  }
  if (GENERIC_NAME.test(event.event_name ?? '') || !named(event.event_name)) return 'observation';
  // dataLayer records with no explicit event name are state/configuration pushes.
  if (event.queue_name === 'dataLayer' && !named(event.payload?.event) && !named(event.payload?.event_name)) return 'observation';
  // An object named by the SDK (or a transport message type) is not sufficient
  // evidence of a tracking event. Supported event protocols identify it explicitly.
  if (event.layer === 'TRACKING_REQUEST' && (named(event.payload?.name) || named(event.payload?.type))
    && ![event.payload?.event, event.payload?.event_name, event.payload?.ev].some(named)) return 'observation';
  return 'business';
}

export const isBusinessEvent = event => eventKind(event) === 'business';
