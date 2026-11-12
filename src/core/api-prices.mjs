// Prices the website's own API returned (the JSON responses F12's Network tab lists), checked against
// the prices the tracking sent to Google/Insider: 500.000 sent while the API priced the same product
// at 1.000.000 is a wrong price. Only money fields are kept from an API response, each with the
// identifiers (id, slug, code…) and name of the product it belongs to.
import { isSensitiveKey } from './privacy.mjs';

const words = key => String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const MONEY = new Set(['price', 'prices', 'pricing', 'amount', 'total', 'subtotal', 'fare', 'cost', 'fee', 'revenue', 'tax', 'discount', 'charge', 'value']);
// The last word decides: totalCount, priceType, discountPercent, taxRate, totalNights are not money.
const NOT_MONEY = new Set(('count qty quantity percent percentage pct rate ratio id ids code type index unit level star stars score point points day days night nights '
  + 'date time number no status name text label format currency version size length step page pages items results records elements rows hits guests adults children '
  + 'pax rooms players holes seats people persons tickets members reviews votes views minutes hours seconds km distance weight capacity').split(' '));
/** unitPrice, sale_price, totalAmount, pricePerNight are money; a bare "value" only for GA4 or next to a currency. */
export function moneyKey(key, { bareValue = false } = {}) {
  const parts = words(key), last = parts.at(-1);
  if (!parts.length || (NOT_MONEY.has(last) && !parts.includes('per'))) return false;
  const money = parts.filter(word => MONEY.has(word));
  return money.length > 0 && !(parts.length === 1 && money[0] === 'value' && !bareValue);
}
// What a money field is: a unit price (items[].price, unit_price, price.value), a total (GA4 value, cart
// total), a fee of some kind (green_fee, caddieFee), a tax or a discount. Only fields of the same kind are
// compared. "amount"/"value" alone in an API could be either a price or a total.
const KINDS = [['discount', ['discount', 'promotion', 'voucher', 'coupon']], ['tax', ['tax', 'vat']], ['fee', ['fee', 'fees', 'charge', 'surcharge']],
  ['total', ['total', 'subtotal', 'grand', 'revenue']], ['price', ['price', 'prices', 'pricing', 'fare', 'cost']]];
const GENERIC = new Set(['unit', 'per', 'item', 'items', 'base', 'original', 'sale', 'final', 'net', 'gross', 'amount', 'value', 'price', 'custom', 'parameters']);
function kindOf(path, side) {
  const segments = path.replace(/\[\d+\]/g, '').split('.');
  let parts = words(segments.at(-1));
  if (parts.every(word => GENERIC.has(word))) parts = [...words(segments.at(-2) ?? ''), ...parts];
  const cut = parts.findIndex(word => ['after', 'before', 'with', 'without', 'incl', 'excl', 'including', 'excluding'].includes(word));
  if (cut > 0) parts = parts.slice(0, cut);
  for (const [kind, list] of KINDS) if (parts.some(word => list.includes(word))) return { kind, words: parts.filter(word => !list.includes(word) && !GENERIC.has(word)) };
  return { kind: side === 'sent' ? 'total' : 'money', words: [] };
}
function comparable(sent, api, single) {
  if (sent.kind === api.kind) return sent.kind !== 'fee' || !sent.words.length || !api.words.length || sent.words.some(word => api.words.includes(word));
  if (api.kind === 'money') return ['price', 'total'].includes(sent.kind);
  // One product: the event total is its price × quantity.
  return sent.kind === 'total' && api.kind === 'price' && single;
}
// unit_sale_price is closer to salePrice than to originalPrice.
const likeness = (sent, api) => { const a = words(sent), b = words(api); return a.filter(word => b.includes(word)).length - b.filter(word => !a.includes(word)).length / 2; };
const ID_LAST = new Set(['id', 'code', 'sku', 'slug', 'uuid']);
// currencyCode, promoCode, statusCode, airport/city codes are shared by many products: not product ids.
const SHARED_CODE = new Set(['currency', 'country', 'lang', 'language', 'locale', 'promo', 'promotion', 'coupon', 'voucher', 'discount', 'status', 'error', 'response', 'http', 'zip', 'postal', 'area', 'region', 'city', 'airport', 'iata', 'timezone']);
const idKey = key => { const parts = words(key); return ID_LAST.has(parts.at(-1)) && !(parts.length > 1 && SHARED_CODE.has(parts.at(-2))) && !isSensitiveKey(key); };
const NAME_KEYS = new Set(['name', 'title', 'productname', 'itemname', 'hotelname', 'roomname']);
// Objects about people (profile, guest, passenger…) are not products: their names are never kept.
const PERSONAL = /user|customer|guest|contact|profile|account|member|passenger|travell?er|billing|payer|owner/i;
const amount = value => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,13}(?:\.\d{1,4})?$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 && number < 1e13 ? number : null;
};
const idsOf = object => Object.entries(object).filter(([key, value]) => (typeof value === 'string' || typeof value === 'number') && idKey(key) && String(value).trim() && String(value).length <= 120).map(([, value]) => String(value));

/** Money fields of one API response: path, value, the ids of the product they belong to (own and enclosing objects), its name. */
export function apiPrices(body, { max = 400 } = {}) {
  const prices = [];
  const walk = (node, path, ids, name, parentKey, depth) => {
    if (prices.length >= max || depth > 14 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (let index = 0; index < Math.min(node.length, 500); index++) walk(node[index], `${path}[${index}]`, ids, name, parentKey, depth + 1); return; }
    const entries = Object.entries(node);
    const label = PERSONAL.test(path) ? undefined : entries.find(([key, value]) => typeof value === 'string' && value.trim() && NAME_KEYS.has(key.toLowerCase().replace(/[_-]/g, '')))?.[1];
    const here = [...idsOf(node), ...ids].slice(0, 16), title = label?.slice(0, 160) ?? name;
    const currency = entries.find(([key, value]) => /^(?:currency|currency_?code|cur)$/i.test(key) && typeof value === 'string')?.[1];
    for (const [key, value] of entries) {
      const at = path ? `${path}.${key}` : key, number = amount(value);
      if (number !== null && moneyKey(key, { bareValue: Boolean(currency) || moneyKey(parentKey ?? '') })) prices.push({ path: at, value: number, ids: here, ...(title ? { name: title } : {}), ...(currency ? { currency } : {}) });
      else if (value && typeof value === 'object') walk(value, at, here, title, key, depth + 1);
    }
  };
  walk(body, '', [], undefined, undefined, 0);
  return prices;
}

/** Money fields one sent event carried (GA4 value and items[].price, Insider unit_price, cart total…) with the ids of their product. */
export function sentPrices(row) {
  const defaults = row.json?.default_parameters ?? {}, custom = row.json?.custom_parameters ?? {};
  const items = Array.isArray(defaults.items) ? defaults.items.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];
  const fields = [], count = value => Number(value) > 0 ? Number(value) : 1;
  items.forEach((item, index) => {
    for (const [key, value] of Object.entries(item)) {
      const number = amount(value);
      if (number !== null && moneyKey(key, { bareValue: true })) fields.push({ field: `items[${index}].${key}`, value: number, ids: idsOf(item), name: item.item_name, quantity: count(item.quantity) });
    }
  });
  // An event-level total belongs to one product only when the event carries exactly one (a GA4 item).
  const single = items.length === 1, params = { ...defaults, ...custom }, ids = [...idsOf(params), ...(single ? idsOf(items[0]) : [])];
  for (const [key, value] of Object.entries(params)) {
    const number = amount(value);
    if (key === 'items' || number === null || !moneyKey(key, { bareValue: true })) continue;
    fields.push({ field: Object.hasOwn(defaults, key) ? key : `custom_parameters.${key}`, value: number, ids, name: params.product_name ?? (single ? items[0].item_name : undefined), quantity: count(params.quantity ?? (single ? items[0].quantity : 1)), single });
  }
  return fields;
}

const same = (a, b) => Math.abs(a - b) < 0.005 || Math.abs(a - b) <= Math.abs(b) * 1e-9;
// Ids a product is found under in the API: the id itself and, for a composite tracking id such as
// vinpearl-hp-golf_18_A_1_05:30, the leading parts the site builds it from (vinpearl-hp-golf).
function lookupKeys(id) {
  const text = String(id).trim().toLowerCase(), keys = new Set(text.length >= 2 ? [text] : []);
  for (let index = 6; index < text.length; index++) if ('_:|/#'.includes(text[index])) keys.add(text.slice(0, index));
  return [...keys];
}
const pageOf = url => { try { const parsed = new URL(url); return parsed.host + parsed.pathname; } catch { return ''; } };
const distinct = (items, limit) => { const seen = new Set(); return items.filter(item => !seen.has(item.entry.value) && seen.add(item.entry.value)).slice(0, limit); };
const apiView = (item, quantity = 1) => ({ value: item.entry.value, path: item.entry.path, url: item.record.url, at: item.record.captured_at, ...(item.entry.name ? { name: item.entry.name } : {}), ...(quantity > 1 ? { times: quantity } : {}) });

/**
 * One check per money field of each event sent to Google/Insider. The API responses the page had when
 * the website fired the event (its push; GA4 sends it seconds later), on the same tab within 30 minutes,
 * are searched for its product by id, keeping the most specific entries (the A course of a golf club,
 * not every course of the club). MATCH: the latest such response
 * has the sent value (or the unit price × quantity for a one-product total). MISMATCH: it prices the
 * product differently in a field of the same kind (a stale price when only an older response had the
 * sent value). MATCH_PAGE: the product is not identifiable but an API of the page has the value.
 * NO_API: no price of that kind in the APIs read.
 */
export function priceChecks(rows, records = [], { windowMs = 30 * 60000 } = {}) {
  const byId = new Map(), timeline = [];
  for (const record of records) {
    const at = Date.parse(record.captured_at);
    if (!Number.isFinite(at) || !Array.isArray(record.prices)) continue;
    const base = { record, at, page: pageOf(record.page?.url), tab: record.page?.target_id };
    timeline.push(base);
    for (const entry of record.prices) {
      const item = { ...base, entry, kind: kindOf(entry.path, 'api'), ids: new Set((entry.ids ?? []).map(value => String(value).toLowerCase())) };
      for (const id of item.ids) {
        // A masked id ([REDACTED]) names nothing: two masked ids are not the same product.
        if (id.length < 2 || id.includes('[redacted]')) continue;
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push(item);
      }
    }
  }
  const checks = [];
  for (const row of rows) {
    // TP2, and app events read from Insider's Test Lab, are not priced by the website's API.
    if (row.source === 'TP2' || row.layers?.includes('TEST_LAB') || row.layer === 'TEST_LAB') continue;
    if (row.delivery !== 'sent' || row.event_kind !== 'business') continue;
    const fields = sentPrices(row);
    if (!fields.length) continue;
    const at = Date.parse(row.captured_at), tab = row.page?.target_id, page = pageOf(row.page?.url);
    const usable = item => item.at <= at + 500 && item.at >= at - windowMs && (!tab || !item.tab || item.tab === tab);
    const currency = row.json?.default_parameters?.currency ?? row.json?.custom_parameters?.currency;
    for (const field of fields) {
      field.ids = field.ids.filter(id => !id.includes('[REDACTED]'));
      const sentKind = kindOf(field.field, 'sent'), fieldKey = field.field.replace(/^.*\./, '');
      const fits = item => same(field.value, item.entry.value) ? 1
        : field.single && field.quantity > 1 && sentKind.kind === 'total' && ['price', 'money'].includes(item.kind.kind) && same(field.value, item.entry.value * field.quantity) ? field.quantity : 0;
      const like = item => comparable(sentKind, item.kind, field.single);
      const rank = list => [...list].sort((a, b) => likeness(fieldKey, b.entry.path.replace(/^.*\./, '')) - likeness(fieldKey, a.entry.path.replace(/^.*\./, ''))
        || Math.abs(Math.log(a.entry.value / field.value)) - Math.abs(Math.log(b.entry.value / field.value)));
      const result = { evidence_id: row.evidence_id, at: row.sent_at ?? row.captured_at, source: row.source, event: row.display_name, event_name: row.event_name, page: row.page?.url ?? '',
        field: field.field, sent: field.value, ...(currency ? { currency } : {}), ...(field.name ? { name: field.name } : {}), ids: field.ids.slice(0, 4) };
      // How specifically an API entry names this product: its ids among the event's ids and their parts (vinpearl-hp-golf, 18, a…).
      const tokens = new Set(field.ids.flatMap(id => { const text = String(id).trim().toLowerCase(); return [text, ...lookupKeys(text), ...text.split(/[_:|/#]/)]; }));
      const score = item => { let count = 0; for (const id of item.ids) if (tokens.has(id)) count++; return count; };
      let linked = [...new Set(field.ids.flatMap(lookupKeys).flatMap(key => byId.get(key) ?? []))].filter(usable);
      const best = linked.reduce((max, item) => Math.max(max, score(item)), 0);
      linked = linked.filter(item => score(item) === best).sort((a, b) => b.at - a.at);
      if (linked.length) {
        const latest = linked.filter(item => item.at === linked[0].at), found = latest.find(fits), older = linked.find(item => item.at < linked[0].at && fits(item));
        if (found) { checks.push({ ...result, status: 'MATCH', api: apiView(found, fits(found)) }); continue; }
        const priced = rank(latest.filter(like));
        if (priced.length) { checks.push({ ...result, status: 'MISMATCH', api: apiView(priced[0]), candidates: distinct(priced, 3).map(item => apiView(item)), ...(older ? { stale: apiView(older, fits(older)) } : {}) }); continue; }
        if (older) { checks.push({ ...result, status: 'MATCH', api: apiView(older, fits(older)) }); continue; }
      }
      // The product is not identifiable in the API: look for the value among the prices of the page's APIs.
      const nearby = timeline.filter(item => usable(item) && (item.page === page || at - item.at <= 120000)).sort((a, b) => b.at - a.at).slice(0, 30)
        .flatMap(item => item.record.prices.map(entry => ({ ...item, entry, kind: kindOf(entry.path, 'api') }))).filter(like);
      const found = nearby.find(fits);
      if (found) { checks.push({ ...result, status: 'MATCH_PAGE', api: apiView(found, fits(found)) }); continue; }
      checks.push({ ...result, status: 'NO_API', candidates: distinct(rank(nearby), 3).map(item => apiView(item)) });
    }
  }
  const summary = { total: checks.length, api_responses: records.length };
  for (const status of ['MATCH', 'MATCH_PAGE', 'MISMATCH', 'NO_API']) summary[status.toLowerCase()] = checks.filter(check => check.status === status).length;
  return { checks, summary };
}
