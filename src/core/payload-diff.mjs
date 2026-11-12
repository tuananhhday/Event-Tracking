// The specification's sample beside the actual event, field by field, as two columns that read line
// against line: a field the same on both sides is left as it is; a value that differs is marked
// (yellow), more strongly when the specification's rule fails on it; a field one side lacks gets a line
// saying so on that side. The lists say the same in words: what the actual event lacks, what it has that
// the specification does not, which values are wrong and which only differ from the sample (a product
// id, a price: values that change with each action and that the specification only checks by type).
import { isDeepStrictEqual } from 'node:util';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const objectList = value => Array.isArray(value) && value.length > 0 && value.every(isObject);
const nested = value => isObject(value) || objectList(value);
const show = value => value === undefined ? '' : JSON.stringify(value);
// Rules name list items by their first element (items.0.price).
const rulePath = path => path.replace(/\.\d+(?=\.|$)/g, '.0');

export const DIFF_LABEL = { missing: '(thiếu)', extra: '(đặc tả không có)' };

/**
 * expected: the sample of the specification row; actual: the event in the same shape (what the vendor
 * received, written like the sample). fields: the row's rules; issues: the tool's failing checks.
 * Returns { rows: [{ expected: {text, mark}, actual: {text, mark} }], same, different, wrong, missing, extra }.
 * Marks: null (same), 'different', 'wrong', 'missing', 'optional' (missing, not required), 'extra'.
 */
export function payloadDiff(expected, actual, { fields = {}, issues = [] } = {}) {
  const failing = new Map((issues ?? []).filter(issue => issue?.path && issue.verdict !== 'PASS' && issue.verdict !== 'REVIEW').map(issue => [issue.path, issue]));
  const issueAt = path => failing.get(path) ?? failing.get(rulePath(path));
  const ruleAt = path => fields?.[path] ?? fields?.[rulePath(path)];
  const out = { rows: [], same: 0, different: [], wrong: [], missing: [], extra: [] };
  const line = (expectedText, expectedMark, actualText, actualMark) => out.rows.push({ expected: { text: expectedText, mark: expectedMark }, actual: { text: actualText, mark: actualMark } });
  // A whole value on one side only: its lines there, a placeholder then blanks on the other.
  const alone = (value, label, pad, side, mark) => {
    const text = `${label}${JSON.stringify(value, null, 2)}`.split('\n').map((part, index) => index ? `${pad}${part}` : `${pad}${part}`);
    text.forEach((part, index) => {
      const placeholder = index === 0 ? `${pad}${label}${side === 'expected' ? DIFF_LABEL.missing : DIFF_LABEL.extra}` : '';
      if (side === 'expected') line(part, mark, placeholder, index === 0 ? mark : null);
      else line(placeholder, index === 0 ? mark : null, part, mark);
    });
  };
  const walk = (left, right, path, depth, key, last) => {
    const pad = '  '.repeat(depth), label = key === null ? '' : `${JSON.stringify(String(key))}: `, comma = last ? '' : ',';
    if (left === undefined && right === undefined) return;
    if (right === undefined) {
      const rule = ruleAt(path), required = !rule?.optional && rule?.op !== 'ignore' && rule?.op !== 'not_exists';
      const mark = required || issueAt(path) ? 'missing' : 'optional';
      out.missing.push({ path, expected: left, required: mark === 'missing' });
      return alone(left, label, pad, 'expected', mark);
    }
    if (left === undefined) { out.extra.push({ path, actual: right }); return alone(right, label, pad, 'actual', 'extra'); }
    // Both sides have an object (or a list of objects): field by field, keys in the sample's order.
    if (nested(left) && nested(right) && Array.isArray(left) === Array.isArray(right)) {
      const [open, close] = Array.isArray(left) ? ['[', ']'] : ['{', '}'];
      line(`${pad}${label}${open}`, null, `${pad}${label}${open}`, null);
      const keys = Array.isArray(left) ? [...Array(Math.max(left.length, right.length)).keys()] : [...new Set([...Object.keys(left), ...Object.keys(right)])];
      keys.forEach((child, index) => walk(left[child], right[child], path ? `${path}.${child}` : String(child), depth + 1, Array.isArray(left) ? null : child, index === keys.length - 1));
      line(`${pad}${close}${comma}`, null, `${pad}${close}${comma}`, null);
      return;
    }
    const expectedText = `${pad}${label}${show(left)}${comma}`, actualText = `${pad}${label}${show(right)}${comma}`;
    if (ruleAt(path)?.op === 'ignore' || isDeepStrictEqual(left, right)) { out.same++; return line(expectedText, null, actualText, null); }
    const issue = issueAt(path);
    if (issue) out.wrong.push({ path, expected: left, actual: right, code: issue.code, rule: issue.expected });
    else out.different.push({ path, expected: left, actual: right, rule: ruleAt(path)?.op ?? null });
    const mark = issue ? 'wrong' : 'different';
    line(expectedText, mark, actualText, mark);
  };
  if (isObject(expected) && isObject(actual)) walk(expected, actual, '', 0, null, true);
  else if (expected !== undefined || actual !== undefined) walk(expected ?? undefined, actual ?? undefined, '', 0, null, true);
  // A failing rule on a field neither side shows as a value (a missing list, a whole object) is listed too.
  for (const [path, issue] of failing) {
    if (!out.wrong.some(item => item.path === path || rulePath(item.path) === path) && !out.missing.some(item => item.path === path || rulePath(item.path) === path)) {
      if (issue.code === 'MISSING_FIELD') out.missing.push({ path, expected: issue.expected, required: true });
      else out.wrong.push({ path, expected: issue.expected, actual: issue.actual, code: issue.code, rule: issue.expected });
    }
  }
  return out;
}

const list = (items, write, max) => `${items.slice(0, max).map(write).join('; ')}${items.length > max ? `; và ${items.length - max} trường khác` : ''}`;
/** The differences in words, one sentence per kind: what the actual event lacks, has extra, has wrong, has different. */
export function diffSentences(diff) {
  if (!diff) return [];
  const required = diff.missing.filter(item => item.required), optional = diff.missing.filter(item => !item.required);
  const out = [];
  if (required.length) out.push(`Event thực tế thiếu (đặc tả có): ${list(required, item => `${item.path}${item.expected !== undefined ? ` = ${show(item.expected)}` : ''}`, 12)}.`);
  if (diff.wrong.length) out.push(`Sai so với đặc tả: ${list(diff.wrong, item => `${item.path} (đặc tả ${show(item.expected)}, thực tế ${show(item.actual)})`, 10)}.`);
  if (diff.extra.length) out.push(`Đặc tả không có (event thực tế có gửi): ${list(diff.extra, item => `${item.path} = ${show(item.actual)}`, 8)}.`);
  if (optional.length) out.push(`Thực tế không có, đặc tả không bắt buộc: ${list(optional, item => item.path, 8)}.`);
  if (diff.different.length) out.push(`Khác giá trị mẫu nhưng đúng đặc tả (giá trị thay đổi theo thao tác): ${list(diff.different, item => item.path, 8)}.`);
  return out;
}
