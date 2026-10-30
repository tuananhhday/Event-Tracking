// Decode GA4's compact ecommerce records without treating transport fields as
// business parameters. Original wire data stays in request_payload.
const names = { id: 'item_id', nm: 'item_name', br: 'item_brand', ca: 'item_category', c2: 'item_category2', c3: 'item_category3', c4: 'item_category4', c5: 'item_category5', va: 'item_variant', pr: 'price', qt: 'quantity', cp: 'coupon', ds: 'discount', af: 'affiliation', li: 'item_list_id', ln: 'item_list_name', lp: 'index', lo: 'location_id' };
const numeric = new Set(['pr', 'qt', 'ds', 'lp']);
export function ga4Items(payload) {
  return Object.keys(payload).filter(k => /^pr\d+$/.test(k)).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))).map(key => {
    const item = Object.create(null), keys = new Map(), values = [], unknown = [];
    for (const token of String(payload[key]).split('~')) {
      const custom = token.match(/^k(\d+)([\s\S]*)$/);
      if (custom) { keys.set(custom[1], custom[2]); continue; }
      if (/^v\d/.test(token)) { values.push(token.slice(1)); continue; }
      const code = token.slice(0, 2), value = token.slice(2);
      if (names[code]) item[names[code]] = numeric.has(code) && value.trim() && Number.isFinite(Number(value)) ? Number(value) : value;
      else if (token) unknown.push(token);
    }
    for (const value of values) {
      const index = [...keys.keys()].sort((a, b) => b.length - a.length).find(key => value.startsWith(key));
      if (index !== undefined) Object.defineProperty(item, keys.get(index), { value: value.slice(index.length), enumerable: true, writable: true, configurable: true });
      else unknown.push(`v${value}`);
    }
    if (unknown.length) item._unparsed = unknown;
    return item;
  });
}

const transport = new Set('v tid gtm gcd npa dma dma_cps cid ul sr uaa uab uafvl uamb uam uap uapv uaw frm pscdl sid sct seg dl dr dt tfd ec_mode tag_exp ngs gcs gcu richsstsse pae ir tt apve apvf gtm_up gcut dp ecid en rcb cu'.split(' '));
export const isGa4Transport = key => transport.has(key) || key.startsWith('_') || /^pr\d+$/.test(key) || key.startsWith('gtm.');
