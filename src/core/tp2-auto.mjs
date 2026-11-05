// Suggest by field meaning and item identity, never by equal prices/values.
const key = value => value.replace(/[_-]/g, '').toLowerCase();
const groups = [
  ['orderid', 'ordercode', 'ordernumber', 'bookingid', 'bookingcode', 'transactionid'],
  ['productid', 'productcode', 'sku', 'itemid'],
  ['quantity', 'qty'], ['currency', 'currencycode'],
  ['totalamount', 'totalprice', 'ordertotal', 'grandtotal'], ['price', 'unitprice'],
];
const ignored = new Set(['event', 'eventname', 'action', 'schema', 'timestamp', 'eventtime']);
export const autoValueAt = (value, path) => path.split('.').reduce((node, part) => node != null && Object.hasOwn(Object(node), part) ? node[part] : undefined, value);
const usable = value => value !== undefined && value !== null && !String(value).includes('[REDACTED]');
function leaves(value, prefix = '', out = [], depth = 0) {
  if (depth > 15 || out.length >= 500) { out.limited = true; return out; }
  if (value && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) {
      if (out.length >= 500) { out.limited = true; break; }
      leaves(item, prefix ? `${prefix}.${name}` : name, out, depth + 1);
    }
  } else if (prefix) out.push(prefix);
  return out;
}
const isProductApi = call => /\/products?(?:\/|$)/i.test(call?.path || '');
function meaning(path, orderApi = false, productApi = false) {
  const parts = path.split('.'), name = key(parts.at(-1));
  if (name === 'id') {
    const parent = key(parts.at(-2) || '');
    if (['product', 'products'].includes(parent)) return 'productid';
    if (['order', 'orders', 'booking'].includes(parent) || orderApi && parts.slice(0, -1).every(part => ['data', 'result', 'response'].includes(key(part)))) return 'orderid';
    if (productApi && parts.slice(0, -1).every(part => ['data', 'result', 'response', 'items', 'products'].includes(key(part)) || /^\d+$/.test(part))) return 'productid';
  }
  return groups.find(group => group.includes(name))?.[0] || name;
}
function sameItems(eventPath, apiPath, payload, body) {
  const ancestors = path => path.split('.').flatMap((part, index, parts) => /^\d+$/.test(part) ? [parts.slice(0, index + 1).join('.')] : []);
  const a = ancestors(eventPath), b = ancestors(apiPath);
  if (a.length !== b.length) return false;
  return a.every((path, index) => {
    const eventItem = autoValueAt(payload, path), apiItem = autoValueAt(body, b[index]);
    if (!eventItem || !apiItem || typeof eventItem !== 'object' || typeof apiItem !== 'object') return false;
    const ids = Object.keys(eventItem).filter(name => ['productid', 'orderid'].includes(meaning(name)));
    return ids.some(name => {
      const candidates = Object.keys(apiItem).filter(other => meaning(other) === meaning(name));
      return candidates.length === 1 && usable(eventItem[name]) && usable(apiItem[candidates[0]]) && String(eventItem[name]) === String(apiItem[candidates[0]]);
    });
  });
}
export const isMyOrder = call => /\/myorder(?:\/|$)/i.test(call.path || '');
export function affiliateStage(event) {
  const payload = event.payload || {}, params = payload.event_params || {};
  const names = [event.event_name, payload.event_name, payload.event, payload.action, params.action, params.event_name].filter(value => typeof value === 'string');
  if (names.some(name => /(?:^|[_\s-])(?:click|clicked)(?:$|[_\s-])/i.test(name))) return 'click';
  if (names.some(name => /(?:^|[_\s-])(?:order|purchase|transaction|conversion)(?:$|[_\s-])/i.test(name))) return 'purchase';
  return 'unknown';
}
export function orderIdentity(payload, { orderApi = false } = {}) {
  const paths = leaves(payload).filter(path => !/\.\d+\./.test(`.${path}.`) && meaning(path, orderApi) === 'orderid');
  const values = [...new Set(paths.map(path => autoValueAt(payload, path)).filter(usable).map(String))];
  return values.length === 1 ? values[0] : undefined;
}
export function sharesIdentity(event, call) {
  const identities = new Set(['orderid', 'productid', 'affiliateid', 'campaignid', 'clickid']);
  const eventPaths = leaves(event.payload), body = call.response?.body?.json, apiPaths = leaves(body);
  return eventPaths.some(eventPath => identities.has(meaning(eventPath)) && usable(autoValueAt(event.payload, eventPath))
    && apiPaths.some(apiPath => meaning(eventPath) === meaning(apiPath, isMyOrder(call), isProductApi(call)) && usable(autoValueAt(body, apiPath))
      && String(autoValueAt(event.payload, eventPath)) === String(autoValueAt(body, apiPath))));
}
export function suggestTp2Fields(event, call, { side = 'response', recordPath = '' } = {}) {
  const body = recordPath ? autoValueAt(call?.[side]?.body?.json, recordPath.replace(/\[(\d+)\]/g, '.$1')) : call?.[side]?.body?.json;
  const payload = event.payload || {}, allEventPaths = leaves(payload), eventPaths = allEventPaths.filter(path => !ignored.has(key(path.split('.').at(-1)))), apiPaths = leaves(body);
  const fields = eventPaths.slice(0, 100).map(eventPath => {
    const name = meaning(eventPath), matches = apiPaths.filter(apiPath => name === meaning(apiPath, isMyOrder(call || {}), isProductApi(call)) && sameItems(eventPath, apiPath, payload, body));
    return { event_path: eventPath, api_path: matches.length === 1 ? matches[0] : '', type: 'json',
      reason: matches.length > 1 ? 'Có nhiều trường API cùng nghĩa; chọn trường cần so sánh.' : !matches.length ? 'Chưa tìm thấy trường API tương ứng; cần chọn lại hoặc kiểm tra dữ liệu.' : 'Tự ghép theo tên trường hoặc mã định danh; giữ nguyên kiểu dữ liệu.' };
  });
  // Do not suggest multiple TP2 fields against one API field as if the join were certain.
  for (const field of fields) if (field.api_path && fields.filter(other => other.api_path === field.api_path).length > 1) {
    field.reason = 'Nhiều trường TP2 cùng trỏ tới trường API này; cần chọn lại.';
  }
  const duplicates = new Set(fields.filter(field => field.api_path && fields.filter(other => other.api_path === field.api_path).length > 1).map(field => field.api_path));
  for (const field of fields) if (duplicates.has(field.api_path)) field.api_path = '';
  return { fields, api_paths: apiPaths, limited: eventPaths.length > 100 || Boolean(allEventPaths.limited || apiPaths.limited) };
}
