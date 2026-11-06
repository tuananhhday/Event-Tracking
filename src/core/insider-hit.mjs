// How Insider records what its web SDK sends: the event its panel lists and the Martech
// AppOTA_Insider sheets (R1511…) document, e.g. "Product Page View" with default_parameters
// (product_id, product_name, taxonomy, unit_price…) and custom_parameters (the site's attributes).
// The web SDK sends page views as a `pageView` hit naming the page in page_type, and custom and cart
// events to the unification API with short parameter names (pid, na, up…) and c_-prefixed customs.

// page_type of a pageView hit and the page event of the tracking specifications.
export const INSIDER_PAGE_TYPES = { main: 'homepage_view', home: 'homepage_view', category: 'listing_page_view', listing: 'listing_page_view',
  productDetail: 'product_detail_page_view', product: 'product_detail_page_view', cart: 'cart_page_view', basket: 'cart_page_view',
  purchase: 'confirmation_page_view', confirmation: 'confirmation_page_view', success: 'confirmation_page_view', other: 'other_page_view' };
export const INSIDER_PAGE_EVENTS = [...new Set(Object.values(INSIDER_PAGE_TYPES))];

const DISPLAY_NAMES = {
  homepage_view: 'Homepage View', listing_page_view: 'Listing Page View', product_detail_page_view: 'Product Page View',
  cart_page_view: 'Cart Page View', confirmation_page_view: 'Purchase', purchase: 'Purchase',
  add_to_cart: 'Item Added to Cart', item_added_to_cart: 'Item Added to Cart', remove_from_cart: 'Item Removed from Cart', item_removed_from_cart: 'Item Removed from Cart',
};
/** Page and cart events Insider defines itself; everything else is a custom event. */
export const isInsiderStandardEvent = name => Object.hasOwn(DISPLAY_NAMES, name) || INSIDER_PAGE_EVENTS.includes(name) || name === 'pageView';
/** The name Insider shows: "Listing Page View", "Item Added to Cart", custom events title-cased ("Search Golf"). */
export const insiderDisplayName = name => DISPLAY_NAMES[name] || String(name || '').split(/[_\s]+/).map(word => word ? word[0].toUpperCase() + word.slice(1) : '').join(' ');

/** The specification name of a pageView hit (homepage_view, listing_page_view…); null for other hits. */
export function insiderPageEvent(payload) {
  return payload?.event === 'pageView' ? INSIDER_PAGE_TYPES[payload.page_type] ?? 'pageView' : null;
}

// Hit envelope (session, locale, SDK state) and fields read separately below: not event parameters.
const ENVELOPE = new Set(['version', 'partner_name', 'user_id', 'event', 'init_session', 'session_id', 'referrer', 'source', 'current_url', 'page_type',
  'language', 'locale', 'ucd', 'ad_blocker', 'country', 'time_zone', 'partner', 'insider_id', 'lane', 'event_name', 'timestamp', 'product', 'products', 'category', 'cart_amount']);
// Short names of default parameters in Insider's event API.
const SHORT_NAMES = { pid: 'product_id', na: 'product_name', cu: 'currency', up: 'unit_price', usp: 'unit_sale_price', piu: 'product_image_url', qu: 'quantity', ta: 'taxonomy', e_guid: 'event_group_id' };
const ORDER_KEYS = ['order_id', 'event_group_id', 'unique_sale_id', 'sale_id'];

function productParameters(product) {
  const defaults = { product_id: product.id, product_name: product.name, product_image_url: product.imgUrl, taxonomy: product.category,
    unit_price: product.price?.originalValue, unit_sale_price: product.price?.value, currency: product.price?.currency, quantity: product.quantity, url: product.url };
  return { defaults: Object.fromEntries(Object.entries(defaults).filter(([, value]) => value !== undefined)), custom: { ...(product.customAttributes ?? {}), ...(product.productAttributes ?? {}) } };
}

/** default_parameters and custom_parameters of one Insider hit, as Insider lists the event. */
export function insiderHitParameters(payload = {}) {
  const defaults = {}, custom = {};
  if (payload.event_params && typeof payload.event_params === 'object' && !Array.isArray(payload.event_params)) {
    for (const [key, value] of Object.entries(payload.event_params)) {
      if (key.startsWith('c_')) custom[key.slice(2)] = value;
      // nc_* repeat a price before currency conversion.
      else if (key.startsWith('nc_')) continue;
      else if (key === 'default' && value && typeof value === 'object' && !Array.isArray(value)) for (const [name, item] of Object.entries(value)) defaults[name.toLowerCase()] = item;
      else if (key === 'custom' && value && typeof value === 'object' && !Array.isArray(value)) Object.assign(custom, value);
      else defaults[SHORT_NAMES[key] ?? key] = value;
    }
    return { default_parameters: defaults, custom_parameters: custom };
  }
  // The page's first product is the event's product, as in the sheets; a listing has its category path.
  const products = payload.product ? [payload.product] : Array.isArray(payload.products) ? payload.products : [];
  if (products[0]) { const { defaults: first, custom: attributes } = productParameters(products[0]); Object.assign(defaults, first); Object.assign(custom, attributes); }
  else if (Array.isArray(payload.category)) defaults.taxonomy = payload.category;
  for (const key of ORDER_KEYS) if (payload[key] !== undefined && defaults.event_group_id === undefined) defaults.event_group_id = payload[key];
  if (payload.cart_amount && ['cart_page_view', 'confirmation_page_view'].includes(insiderPageEvent(payload)) && custom.total === undefined) custom.total = payload.cart_amount;
  for (const [key, value] of Object.entries(payload)) if (!ENVELOPE.has(key) && !ORDER_KEYS.includes(key) && value !== '' && value !== null && custom[key] === undefined) custom[key] = value;
  return { default_parameters: defaults, custom_parameters: custom };
}

/** One Insider hit as the event Insider records: { event, default_parameters, custom_parameters }. */
export const insiderHitView = (eventName, payload) => ({ event: insiderDisplayName(eventName), ...insiderHitParameters(payload) });
