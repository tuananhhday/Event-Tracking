import JSON5 from 'json5';

// These readers inspect data literals and known SDK signatures. They never run
// JavaScript, Swift, Java, workbook formulas, or arbitrary function calls.
const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const labelFor = name => ({ homepage_view: 'Homepage View', listing_page_view: 'Listing Page View',
  product_detail_page_view: 'Product Page View', cart_page_view: 'Cart Page View',
  add_to_cart: 'Item Added to Cart', remove_from_cart: 'Item Removed from Cart',
  confirmation_page_view: 'Purchase' }[name] ?? name);
const keyFor = label => String(label).trim().replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });

function parametersOf(payload, types = new Map()) {
  const out = [];
  const visit = (value, path, group) => {
    if (path) out.push({ path, type: types.get(path) ?? typeOf(value), group });
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      visit(child, path ? `${path}.${key}` : key, path ? group : key === 'default_parameters' ? 'default' : key === 'custom_parameters' ? 'custom' : 'event');
    }
  };
  visit(payload, '', 'event');
  return out;
}

function result(payload, format, warnings, extra = {}, types) {
  return { payload, format, status: payload ? warnings.length ? 'partial' : 'complete' : 'unparsed',
    warnings: [...new Set(warnings)], parameters: payload ? parametersOf(payload, types) : [], ...extra };
}

// Split at top-level commas, preserving quoted commas and nested literals.
function splitArguments(input) {
  const values = []; let start = 0, depth = 0, quote = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { values.push(input.slice(start, i).trim()); start = i + 1; }
  }
  if (quote || depth !== 0) throw Error('Unbalanced literal');
  if (input.slice(start).trim()) values.push(input.slice(start).trim());
  return values;
}

function literal(input, { text = false } = {}) {
  let raw = input.trim().replace(/[,;]\s*$/, '').trim();
  // Swift argument labels are syntax, not data.
  raw = raw.replace(/^(?:withID|name|taxonomy|imageURL|price|currency|withTaxonomy|withSaleID|uniqueSaleID|product|with|withProducts):\s*/, '');
  raw = raw.replace(/^new\s+String\s*\[\]\s*\{([\s\S]*)\}$/, '[$1]');
  const date = raw.match(/^parseIsoDate\(\s*((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^'\\]|\\.)*'))\s*\)$/);
  if (date) { const value = JSON5.parse(date[1]); if (!Number.isFinite(Date.parse(value))) throw Error('Invalid date literal'); return value; }
  try {
    const value = JSON5.parse(raw);
    if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) throw Error('Unsupported literal');
    return value;
  } catch (error) {
    if (!text) throw error;
    // Insider's copied parameter view uses bare strings and unquoted arrays.
    if (/^\[(?:\s*[\p{L}\p{N}_ -]+\s*,?)*\]$/u.test(raw)) return raw.slice(1, -1).split(',').map(x => x.trim()).filter(Boolean);
    if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) return Number(raw.replace(/,/g, ''));
    // Insider may serialize item lists as text: keep the text, do not promote
    // it to a nested payload that was never present in the source.
    if (/^\[[^\]]*:\s*[^\]]*\](?:,\s*\[[^\]]*\])*$/.test(raw)) return raw;
    if (!raw || /[{}]/.test(raw) || raw.startsWith('[') && raw.endsWith(']')) throw Error('Unsupported text literal');
    return raw;
  }
}

function readParen(source, start) {
  let depth = 0, quote = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return { body: source.slice(start + 1, i), end: i + 1 };
  }
  throw Error('Unclosed SDK call');
}

function callsIn(source, warnings) {
  const calls = [];
  const regex = /([A-Za-z_]\w*(?:\??\.[A-Za-z_]\w*)*)\??\.([A-Za-z_]\w*)\??\s*\(/g;
  for (let hit; (hit = regex.exec(source));) {
    try {
      let call = readParen(source, regex.lastIndex - 1);
      // Swift's generated bindings use method()(arg1, arg2).
      const next = source.slice(call.end).match(/^\s*\??\s*\(/);
      if (!call.body.trim() && next) call = readParen(source, call.end + next[0].lastIndexOf('('));
      const assignment = source.slice(Math.max(0, source.lastIndexOf('\n', hit.index)), hit.index).match(/(?:let|var|InsiderProduct|InsiderEvent)?\s*(\w+)\s*=\s*$/);
      calls.push({ receiver: hit[1], method: hit[2], args: splitArguments(call.body), variable: assignment?.[1] });
      regex.lastIndex = call.end;
    } catch { warnings.push('Một lời gọi SDK chưa đóng hoặc có đối số không đọc được.'); }
  }
  return calls;
}

function parseSDK(input, eventName) {
  const warnings = [], types = new Map();
  // The file supplies equivalent Swift/Java examples; don't double-count them.
  const sections = input.split(/\/\/\s*Android\b/i);
  const chosen = /Insider\.|\.addParameterWith/.test(sections[0]) ? sections[0] : input;
  const source = chosen.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  const calls = callsIn(source, warnings);
  const products = new Map(), records = [], recordTypes = [];
  const payload = { event: labelFor(eventName), default_parameters: {}, custom_parameters: {} };
  let recognized = false, sdkMethod;
  const set = (object, group, key, value, type) => { put(object, key, value); types.set(`${group}_parameters.${key}`, type ?? typeOf(value)); };
  const paramTypes = { String: 'string', StringArray: 'array', Int: 'number', Double: 'number', Boolean: 'boolean', Date: 'date' };
  for (const call of calls) {
    const { method, args, receiver } = call;
    try {
      if (method === 'tagEvent') { payload.event = literal(args[0]); recognized = true; sdkMethod = method; }
      else if (/^addParameterWith/.test(method)) {
        const kind = method.slice('addParameterWith'.length);
        if (!paramTypes[kind]) throw Error('Unsupported parameter method');
        set(payload.custom_parameters, 'custom', literal(args[0]), literal(args[1]), paramTypes[kind]); recognized = true;
      } else if (method === 'createNewProduct') {
        if (args.length !== 6 || !call.variable) throw Error('Unrecognized product constructor');
        const keys = ['product_id', 'product_name', 'taxonomy', 'product_image_url', 'unit_price', 'currency'];
        const product = { default_parameters: {}, custom_parameters: {}, types: new Map() };
        args.forEach((arg, i) => put(product.default_parameters, keys[i], literal(arg)));
        products.set(call.variable, product); recognized = true;
      } else if (/^setCustomAttributeWith/.test(method)) {
        const product = products.get(receiver), kind = method.slice('setCustomAttributeWith'.length);
        if (!product || !paramTypes[kind]) throw Error('Unknown product attribute');
        const key = literal(args[0]);
        put(product.custom_parameters, key, literal(args[1]));
        product.types.set(`custom_parameters.${key}`, paramTypes[kind]); recognized = true;
      } else if (method === 'setQuantity' || method === 'setProductURL') {
        const product = products.get(receiver); if (!product) throw Error('Unknown product');
        put(product.default_parameters, method === 'setQuantity' ? 'quantity' : 'url', literal(args[0])); recognized = true;
      } else if (/^visitHome[Pp]age$/.test(method)) { recognized = true; sdkMethod = method; }
      else if (method === 'visitListingPage') { set(payload.default_parameters, 'default', 'taxonomy', literal(args[0])); recognized = true; sdkMethod = method; }
      else if (method === 'visitProductDetailPage' || method === 'visitCartPage' || method === 'itemPurchased') {
        sdkMethod = method; recognized = true;
        const productArg = args.at(-1)?.replace(/^(?:with|withProducts|product):\s*/, '').trim();
        const vars = productArg?.replace(/^new\s+InsiderProduct\s*\[\]\s*\{/, '[').replace(/\}$/, ']').replace(/^\[|\]$/g, '').split(',').map(x => x.trim());
        if (!vars?.length) throw Error('Missing product references');
        for (const variable of vars) {
          const product = products.get(variable); if (!product) throw Error('Unknown product reference');
          const record = { event: labelFor(eventName), default_parameters: { ...product.default_parameters }, custom_parameters: { ...product.custom_parameters } };
          if (method === 'itemPurchased') record.default_parameters.event_group_id = literal(args[0]);
          records.push(record); recordTypes.push(product.types);
        }
      } else if (products.has(receiver) || /^addParameter/.test(method)) warnings.push(`Chưa hỗ trợ phương thức ${method}.`);
    } catch { warnings.push(`Chưa đọc được đầy đủ đối số của ${method}.`); }
  }
  if (!recognized) return result(null, 'sdk', warnings.length ? warnings : ['Chưa đọc được cấu trúc từ ví dụ SDK.']);
  if (records.length) {
    // Each product/call remains a complete event; never merge its fields with another product.
    const first = records[0];
    return result(first, 'sdk', warnings, { sdk_method: sdkMethod, records }, recordTypes[0]);
  }
  if (products.size) warnings.push('Có product nhưng chưa xác định được lời gọi phát event.');
  return result(payload, 'sdk', warnings, { sdk_method: sdkMethod }, types);
}

function parseText(input, eventName) {
  const warnings = [], records = [], types = new Map();
  let payload = { event: labelFor(eventName), default_parameters: {}, custom_parameters: {} };
  let group = null, seen = 0, unknown = false;
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim(); if (!trimmed) continue;
    const header = trimmed.match(/^(Default|Custom)\s+Param(?:eters|s)?\s*:?\s*$/i);
    if (header) {
      // A second default block denotes a second product, not a field overwrite.
      if (header[1].toLowerCase() === 'default' && Object.keys(payload.default_parameters).length) {
        records.push(payload); payload = { event: labelFor(eventName), default_parameters: {}, custom_parameters: {} };
      }
      group = header[1].toLowerCase(); continue;
    }
    if (/^(?:Param|Parameters)\s*:/i.test(trimmed) && /(?:giống|y hệt|tương tự|same)/i.test(trimmed)) { warnings.push('Nguồn chỉ tham chiếu cấu trúc event khác; cần xác nhận.'); continue; }
    if (/^(?:Insider\.|Dòng\s+\d|Lần gọi\s+\d|Event Details|Platform: App$|Date:|Time \(UTC\):)/i.test(trimmed)) continue;
    if (!group && !trimmed.includes(':') && /^(?:[A-Z][\w -]+)$/.test(trimmed)) { payload.event = trimmed; continue; }
    const field = trimmed.match(/^([\p{L}\w][\p{L}\w ._-]*):\s*(.*?)\s*$/u);
    if (!field || !group) { unknown = true; continue; }
    let key = keyFor(field[1]);
    if (group === 'default' && key === 'name') key = 'product_name';
    if (group === 'default' && key === 'unique_sale_id') key = 'event_group_id';
    if (group === 'default' && key === 'unit_sales_price') key = 'unit_sale_price';
    try {
      const raw = field[2].trim().replace(/[,;]\s*$/, '').trim();
      // A display value has no JSON type annotation. Preserve identifier,
      // version, and formatted-number strings instead of coercing them.
      const stringField = /(?:_id|_code|_string|_version)$/.test(key) || ['product_id', 'product_name', 'name', 'starting_hole'].includes(key);
      const value = stringField && !/^["']/.test(raw) ? raw : literal(raw, { text: true });
      put(payload[`${group}_parameters`], key, value); types.set(`${group}_parameters.${key}`, typeOf(value)); seen++;
      if (typeof value === 'string' && /<[^>]+>|\.\.\.|…/.test(value)) warnings.push('Nguồn có giá trị mẫu hoặc placeholder chưa xác định.');
    } catch { warnings.push(`Chưa đọc được giá trị của ${key}.`); }
  }
  if (!seen) return result(null, 'text', warnings.length ? warnings : ['Chưa có khối Default/Custom Parameters đọc được.']);
  if (unknown) warnings.push('Một số dòng mô tả chưa chuyển được thành tham số.');
  if (records.length) records.push(payload);
  return result(records[0] ?? payload, 'text', warnings, records.length ? { records } : {}, types);
}

/** Read complete Insider sample data, preserving default/custom parameter groups. */
export function parseInsiderSample(input, eventName = '') {
  const source = String(input ?? '').trim().replace(/^```(?:json|javascript|js)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!source) return result(null, 'text', ['Không có mẫu event.']);
  if (/^[{[]/.test(source)) {
    try {
      const payload = JSON5.parse(source);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('Expected object');
      return result(payload, 'json', []);
    } catch { return result(null, 'json', ['Mẫu JSON chưa hoàn chỉnh hoặc không hợp lệ; không tự điền phần thiếu.']); }
  }
  if (/^(?:Default|Custom)\s+Param(?:eters|s)?\s*:?\s*$/im.test(source)) return parseText(source, eventName);
  if (/Insider\.|\.addParameterWith|\.setCustomAttributeWith/.test(source)) return parseSDK(source, eventName);
  return parseText(source, eventName);
}
