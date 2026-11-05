// Redact before persistence, reporting and external AI calls.
const sensitive = /^(authorization|proxy[-_]?authorization|cookies?|set[-_]?cookie|x[-_]?api[-_]?key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|password|passwd|secret|session([-_]?id|[-_]?token)?|visitor[-_]?id|device[-_]?id|sid|vid|email|e[-_]?mail|phone|phone[-_]?number|mobile|telephone|full[-_]?name|first[-_]?name|last[-_]?name|address|credit[-_]?card|card[-_]?number|cvv|user[-_]?id|client[-_]?id|cid|uid|_ga|gclid|fbclid)$/i;
const MASK = '[REDACTED]';
const personal = /^(?:email|emailaddress|mail|phone|phonenumber|mobile|mobilenumber|telephone|fullname|firstname|lastname|middlename|customername|guestname|passengername|recipientname|username|address|streetaddress|billingaddress|shippingaddress|passport|passportnumber|nationalid|identitynumber|cccd|cmnd|dateofbirth|dob|birthday|birthdate|creditcard|cardnumber|bankaccount|accountnumber|ip|ipaddress|userid|customerid|clientid|visitorid|deviceid|sessionid|sid|vid|cid|uid|ga|gclid|fbclid)$/;
const fieldName = key => String(key).replace(/^(epn?|upn?)\./i, '').replace(/\[\d+\]/g, '').split('.').at(-1).replace(/[^a-z0-9]/gi, '').toLowerCase();
export const isPersonalKey = key => personal.test(fieldName(key));
export const isSensitiveKey = key => sensitive.test(String(key).replace(/^(epn?|upn?)\./i, ''));
const isAiSensitiveKey = key => isSensitiveKey(key) || sensitive.test(fieldName(key)) || /^(?:x?authtoken|bearertoken|clientsecret|privatekey|jwt|jwttoken|x?csrftoken|xsrftoken|otp|pin|verificationcode)$/.test(fieldName(key)) || isPersonalKey(key);
const privateValue = (value, key, personalize) => personalize && isPersonalKey(key) ? personalize(value) : MASK;
function cleanText(value, personalize) {
  if (personalize) value = value
    .replace(/(["']?([a-z_][\w.-]*)["']?\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'{}[\],;&<>][^\r\n,;}&\]<>]*))/gi,
      (match, prefix, key, double, single, bare) => {
        if (!isAiSensitiveKey(key)) return match;
        const safe = privateValue(double ?? single ?? bare.trim(), key, personalize);
        return `${prefix}${double !== undefined || single !== undefined ? JSON.stringify(safe) : safe}`;
      })
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, `Basic ${MASK}`)
    .replace(/((?:họ\s+(?:và\s+)?tên|tên\s+khách(?:\s+hàng)?|địa\s+chỉ|ngày\s+sinh)\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\r\n,;<>]+))/giu,
      (_, prefix, double, single, bare) => `${prefix}${personalize(double ?? single ?? bare.trim())}`)
    .replace(/((?:[a-z]:[\\/](?:Users|Documents and Settings)[\\/]|\/(?:home|Users)\/))([^\\/\s]+)/gi, (_, prefix, user) => `${prefix}${personalize(user)}`);
  return value
    .replace(/((?:ue_px|ue_pr|cx)["']?\s*[=:]\s*["']?)([^\s&,;"'}]+)/gi, '$1[ENCODED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MASK}`)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, value => privateValue(value, 'email', personalize))
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|cookie)["']?\s*[=:]\s*["']?)([^\s&,;"'}]+)/gi, `$1${MASK}`)
    .replace(/(?<![\w-])(?:\+?84[ .-]?|0)(?:\d[ .-]?){8,10}(?![\w-])/g, value => privateValue(value, 'phone', personalize));
}
export function redactUrl(value, personalize) {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    if (url.username) url.username = MASK;
    if (url.password) url.password = MASK;
    for (const [key, val] of [...url.searchParams]) {
      const bare = key.replace(/^(epn?|upn?)\./i, '');
      const safeKey = personalize ? cleanText(key, personalize) : key;
      if (safeKey !== key) url.searchParams.delete(key);
      url.searchParams.set(safeKey, /^(ue_px|ue_pr|cx)$/i.test(bare) ? MASK : (personalize ? isAiSensitiveKey(bare) : isSensitiveKey(bare)) ? privateValue(val, bare, personalize) : /^https?:\/\//i.test(val) ? redactUrl(val, personalize) : cleanText(val, personalize));
    }
    if (personalize) {
      let pathname = url.pathname; try { pathname = decodeURIComponent(pathname); } catch { /* retain malformed escapes */ }
      url.pathname = cleanText(pathname.replace(/(\/(?:users|customers|guests|passengers)\/)([^/]+)/gi, (_, prefix, id) => `${prefix}${personalize(id)}`), personalize);
    }
    let fragment = url.hash;
    if (personalize) { try { fragment = decodeURIComponent(fragment); } catch { /* retain malformed escapes */ } }
    url.hash = fragment ? cleanText(fragment, personalize).replace(/((?:token|key|password)=)[^&]+/gi, `$1${MASK}`) : '';
    return personalize ? url.toString() : cleanText(url.toString());
  } catch { return cleanText(value, personalize); }
}
export function redact(value, seen = new WeakSet(), personalize, parentKey = '') {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return redactUrl(value, personalize);
    if (/^\s*[\[{]/.test(value)) {
      try { return JSON.stringify(redact(JSON.parse(value), seen, personalize, parentKey)); } catch { /* Safe text fallback for JavaScript samples. */ }
    }
    return cleanText(value, personalize);
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  const issuePath = typeof value.path === 'string' ? value.path : personalize && typeof value.field === 'string' ? value.field : '';
  const sensitiveIssue = personalize ? isAiSensitiveKey(issuePath) : isSensitiveKey(issuePath.split('.').at(-1));
  const result = Array.isArray(value) ? value.map(v => redact(v, seen, personalize, parentKey)) : Object.fromEntries(
    Object.entries(value).map(([key, val]) => {
      if (/^(ue_px|ue_pr|cx)$/i.test(key) && typeof val === 'string') return [key, '[ENCODED: xem dữ liệu TP2 đã giải mã]'];
      if (sensitiveIssue && ['actual', 'expected'].includes(key)) return [key, privateValue(val, issuePath, personalize)];
      const personalName = personalize && key === 'name' && /^(?:user|customer|guest|passenger|recipient|travell?er|contact|profile)s?$/i.test(parentKey);
      if ((personalize ? isAiSensitiveKey(key) : isSensitiveKey(key)) || personalName) {
        // Preserve expected-rule structure; redact sensitive exact examples only.
        if (val && typeof val === 'object' && typeof val.op === 'string') {
          const safeRule = redact(val, seen, personalize, key);
          if (['eq', 'one_of', 'subset'].includes(val.op) && Object.hasOwn(val, 'value')) {
            safeRule.value = val.op === 'one_of' && Array.isArray(val.value) ? val.value.map(item => privateValue(item, key, personalize)) : privateValue(val.value, key, personalize);
          }
          return [key, safeRule];
        }
        return [key, personalName ? personalize(val) : privateValue(val, key, personalize)];
      }
      return [key, redact(val, seen, personalize, key)];
    })
  );
  seen.delete(value);
  return personalize && !Array.isArray(result) ? Object.fromEntries(Object.entries(result).map(([key, value]) => [cleanText(key, personalize), value])) : result;
}
