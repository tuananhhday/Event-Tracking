import { redact } from '../core/privacy.mjs';

export function sensitivePath(fieldPath) {
  if (typeof fieldPath !== 'string') return false;
  const tail = fieldPath.replace(/\[\d+\]/g, '').split('.').at(-1);
  const probe = '__eventqa_privacy_probe__';
  return redact({ [tail]: probe })[tail] !== probe;
}

export function sanitizeRule(rule) {
  const cleaned = redact({ ...rule, fields: undefined });
  cleaned.fields = Object.fromEntries(Object.entries(rule.fields ?? {}).map(([fieldPath, fieldRule]) => {
    const safeRule = redact(fieldRule);
    // Type names, context references and pattern/range constraints are rule syntax.
    // Exact examples and allowlists may contain actual private data.
    if (sensitivePath(fieldPath) && ['eq', 'one_of', 'subset'].includes(fieldRule.op) && Object.hasOwn(fieldRule, 'value')) {
      safeRule.value = fieldRule.op === 'one_of' && Array.isArray(fieldRule.value) ? fieldRule.value.map(() => '[REDACTED]') : '[REDACTED]';
    }
    return [fieldPath, safeRule];
  }));
  return cleaned;
}

export function sanitizeCases(cases) {
  return cases.map(testCase => ({ ...redact({ ...testCase, rules: undefined }), rules: (testCase.rules ?? []).map(sanitizeRule) }));
}
