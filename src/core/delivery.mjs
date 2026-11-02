// What actually left the browser. A push into dataLayer / InsiderQueue only hands data to GTM or the
// Insider SDK; the event is fired once the vendor request carrying it is sent. GA4 batches hits
// (usually within a few seconds of the push) and sends only the parameters its GTM tag maps; Insider
// sends page data as a `pageView` hit after `init`, cart pushes under its own names, custom events
// by name.
import { eventKind } from './event-kind.mjs';
import { isGa4Transport } from './ga4-parameters.mjs';
import { INSIDER_PAGE_EVENTS } from './insider-hit.mjs';

export const DELIVERY_WINDOW_MS = 30000;
// A push younger than this may still be waiting in GA4's batch.
export const PENDING_MS = 10000;
// Same vendor, same event, same page again within this time: a repeat the site really sent.
export const REPEAT_MS = 10000;
// InsiderQueue types that carry page data (sent as a page hit once `init` follows).
const INSIDER_PAGE_DATA = new Set(['home', 'category', 'product', 'cart', 'purchase', 'other']);
// Queue pushes and the event name Insider sends to its servers for them.
export const INSIDER_SERVER_NAME = { add_to_cart: 'item_added_to_cart', remove_from_cart: 'item_removed_from_cart' };

const time = event => Date.parse(event.captured_at);
const tab = event => event.page?.target_id ?? event.page?.url ?? '';
const sameTab = (a, b) => !a.page?.target_id || !b.page?.target_id || a.page.target_id === b.page.target_id;
export const isRequest = event => event.layer === 'TRACKING_REQUEST' && (!event.network?.phase || event.network.phase === 'request');

/** Pairs every business push with the vendor hit that sent it, one hit per push. */
export function linkDeliveries(events, { windowMs = DELIVERY_WINDOW_MS } = {}) {
  const ordered = events.filter(event => Number.isFinite(time(event))).sort((a, b) => time(a) - time(b));
  const hits = new Map();
  for (const request of ordered.filter(isRequest)) {
    const key = `${request.source}|${request.event_name}`;
    if (!hits.has(key)) hits.set(key, []);
    hits.get(key).push(request);
  }
  const sentBy = new Map(), pushOf = new Map();
  const take = (push, source, names, from = time(push) - 2000) => {
    for (const name of names) {
      const hit = (hits.get(`${source}|${name}`) ?? []).find(candidate => !pushOf.has(candidate.evidence_id) && sameTab(push, candidate)
        && time(candidate) >= from && time(candidate) <= time(push) + windowMs);
      if (hit) { sentBy.set(push.evidence_id, hit); pushOf.set(hit.evidence_id, push); return; }
    }
  };
  const queue = ordered.filter(event => event.layer === 'JS_QUEUE' && !event.historical);
  // The page hit Insider sends for page data: the same page event first, any page view otherwise.
  const pageHits = push => [push.event_name, ...INSIDER_PAGE_EVENTS, 'pageView'];
  for (const [index, push] of queue.entries()) {
    if (eventKind(push) !== 'business') continue;
    if (push.source === 'GA4') take(push, 'GA4', [push.event_name]);
    else if (push.source !== 'INSIDER') continue;
    // insider_object is polled, so the snapshot can be recorded just after the page hit it caused.
    else if (push.queue_name === 'insider_object') take(push, 'INSIDER', pageHits(push), time(push) - 3000);
    else if (INSIDER_PAGE_DATA.has(push.queue_type)) {
      const init = queue.slice(index + 1, index + 30).find(other => other.queue_type === 'init' && tab(other) === tab(push) && time(other) - time(push) <= 5000);
      if (init) take(push, 'INSIDER', pageHits(push), time(init) - 2000);
    } else if (push.queue_name === 'InsiderDispatch') take(push, 'INSIDER', pageHits(push));
    else take(push, 'INSIDER', [INSIDER_SERVER_NAME[push.queue_type] ?? push.event_name]);
  }
  return { sentBy, pushOf };
}

/**
 * sent · pending (may still be in GA4's batch) · not_sent · unverified (pushed before capture
 * started, its hit may have gone earlier). Null for records that are not tracking events.
 */
export function deliveryStatus(event, links, now = Date.now()) {
  if (isRequest(event)) return 'sent';
  if (event.layer !== 'JS_QUEUE' || eventKind(event) !== 'business') return null;
  if (event.historical) return 'unverified';
  if (links.sentBy.has(event.evidence_id)) return 'sent';
  return now - time(event) < PENDING_MS ? 'pending' : 'not_sent';
}

// GA4 sends a push's ecommerce fields at event level (value, item_list_id, result_count…, currency
// as `cu`) and items as pr1, pr2…; read a hit the way the dataLayer push it stands for is written.
export function ga4HitAsPush(payload = {}) {
  const ecommerce = { ...(payload.ecommerce ?? {}) };
  for (const [key, value] of Object.entries(payload)) if (key !== 'event' && key !== 'ecommerce' && !isGa4Transport(key) && ecommerce[key] === undefined) ecommerce[key] = value;
  if (payload.cu !== undefined && ecommerce.currency === undefined) ecommerce.currency = payload.cu;
  return Object.keys(ecommerce).length ? { ...payload, ecommerce } : payload;
}

const leafPaths = (value, prefix = '', out = []) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, child] of Object.entries(value)) leafPaths(child, prefix ? `${prefix}.${key}` : key, out);
  else if (Array.isArray(value) && value[0] && typeof value[0] === 'object') leafPaths(value[0], `${prefix}.0`, out);
  else if (prefix) out.push([prefix, value]);
  return out;
};
const valueAt = (object, path) => path.split('.').reduce((value, key) => value == null ? undefined : value[key], object);

/** Fields the website pushed with a value that the GA4 hit does not carry: its GTM tag did not send them. */
export function notForwarded(push, hit) {
  const received = ga4HitAsPush(hit.payload);
  const empty = value => value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length);
  return leafPaths(push.payload).filter(([path, value]) => !/^(?:event$|gtm\.|gtag\.)/.test(path) && !empty(value) && valueAt(received, path) === undefined).map(([path]) => path);
}
