// Redact before persistence, reporting and external AI calls.
const sensitive = /^(authorization|proxy[-_]?authorization|cookies?|set[-_]?cookie|x[-_]?api[-_]?key|api[-_]?key|secure[-_]?hash|vpc[-_]?securehash|access[-_]?token|refresh[-_]?token|id[-_]?token|token|password|passwd|secret|session([-_]?id|[-_]?token)?|visitor[-_]?id|insider[-_]?id|device[-_]?id|sid|vid|email|e[-_]?mail|phone|phone[-_]?number|mobile|telephone|full[-_]?name|first[-_]?name|last[-_]?name|address|credit[-_]?card|card[-_]?number|cvv|user[-_]?id|client[-_]?id|cid|uid|_ga|gclid|fbclid)$/i;
const MASK = '[REDACTED]';
function cleanText(value) {
  return value
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]+/g, MASK)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${MASK}`)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, MASK)
    .replace(/((?:authorization|api[_-]?key|secure[_-]?hash|vpc[_-]?securehash|access[_-]?token|refresh[_-]?token|token|password|secret|cookie)["']?\s*[=:]\s*["']?)([^\s&,;"'}]+)/gi, `$1${MASK}`)
    .replace(/(?<![\w-])(?:\+?84[ .-]?|0)(?:\d[ .-]?){8,10}(?![\w-])/g, MASK);
}
export function redactUrl(value) {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    if (url.username) url.username = MASK;
    if (url.password) url.password = MASK;
    for (const [key, val] of [...url.searchParams]) {
      const bare = key.replace(/^(epn?|upn?)\./i, '').replace(/^c_/i, '');
      url.searchParams.set(key, sensitive.test(bare) ? MASK : /^https?:\/\//i.test(val) ? redactUrl(val) : cleanText(val));
    }
    url.hash = url.hash ? cleanText(url.hash).replace(/((?:token|key|password)=)[^&]+/gi, `$1${MASK}`) : '';
    return cleanText(url.toString());
  } catch { return cleanText(value); }
}
export function redact(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return redactUrl(value);
    if (/^\s*[\[{]/.test(value)) {
      try { return JSON.stringify(redact(JSON.parse(value), seen)); } catch { /* Safe text fallback for JavaScript samples. */ }
    }
    return cleanText(value);
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  const sensitiveIssue = typeof value.path === 'string' && sensitive.test(value.path.split('.').at(-1).replace(/^c_/i, ''));
  const result = Array.isArray(value) ? value.map(v => redact(v, seen)) : Object.fromEntries(
    Object.entries(value).map(([key, val]) => {
      if (sensitiveIssue && ['actual', 'expected'].includes(key)) return [key, MASK];
      if (sensitive.test(key.replace(/^(epn?|upn?)\./i, '').replace(/^c_/i, ''))) {
        // Preserve expected-rule structure; redact sensitive exact examples only.
        if (val && typeof val === 'object' && typeof val.op === 'string') {
          const safeRule = redact(val, seen);
          if (['eq', 'one_of', 'subset'].includes(val.op) && Object.hasOwn(val, 'value')) {
            safeRule.value = val.op === 'one_of' && Array.isArray(val.value) ? val.value.map(() => MASK) : MASK;
          }
          return [key, safeRule];
        }
        return [key, MASK];
      }
      return [key, redact(val, seen)];
    })
  );
  seen.delete(value);
  return result;
}
