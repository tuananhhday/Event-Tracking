/* JSON evidence comparison. The rule engine owns the verdict; sample changes
   are visual differences and must never become new rule failures here. */
(() => {
  'use strict';
  const missing = Symbol('missing');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const object = value => value !== null && typeof value === 'object';
  const own = (value, key) => object(value) && Object.hasOwn(value, key);
  const pathOf = path => String(path || '').replace(/\[(\d+)\]/g, '.$1');
  const failureCodes = new Set(['MISSING_FIELD', 'NULL_FIELD', 'VALUE_MISMATCH', 'WRONG_TYPE', 'DYNAMIC_VALUE_MISMATCH', 'NOT_FORWARDED', 'UNEXPECTED_FIELD']);
  const messages = { MISSING_FIELD: 'Thiếu trường bắt buộc', NULL_FIELD: 'Giá trị đang rỗng', VALUE_MISMATCH: 'Giá trị khác quy tắc', WRONG_TYPE: 'Sai kiểu dữ liệu', DYNAMIC_VALUE_MISMATCH: 'Khác dữ liệu của thao tác',
    NOT_FORWARDED: 'Website đã push trường này nhưng server không nhận', UNEXPECTED_FIELD: 'Trường không được phép', EVENT_NAME_MISMATCH: 'Tên event không đúng đặc tả',
    NOT_SENT: 'Website đã push nhưng chưa có request gửi đi', PENDING_DELIVERY: 'Đang chờ request gửi đi', CAPTURE_INCOMPLETE: 'Dữ liệu thu thập chưa đầy đủ', NO_EXPECTED_FIELDS: 'Đặc tả chưa có quy tắc kiểm từng trường', LAYER_MISMATCH: 'Event thuộc tầng dữ liệu khác đặc tả',
    SPEC_PLATFORM_MISMATCH: 'Mẫu dành cho ứng dụng; cần kiểm tra cách ghép với dữ liệu website', SPEC_INCOMPLETE: 'Mẫu đặc tả chưa đầy đủ', AMBIGUOUS_SPEC: 'Nhiều dòng đặc tả cùng phù hợp', MISSING_CONTEXT: 'Chưa có dữ liệu ngữ cảnh để kết luận' };
  const statuses = { PASS: ['PASS', 'Khớp đặc tả'], FAIL: ['FAIL', 'Lệch đặc tả'], REVIEW: ['REVIEW', 'Cần kiểm tra'], NOT_SENT: ['FAIL', 'Có push, chưa gửi server'], PENDING: ['REVIEW', 'Đang chờ gửi'], NOT_SELECTED: ['', 'Chưa chọn luồng'], NOT_SEEN: ['', 'Chưa có event trong lượt này'] };
  const verdicts = { MATCH: 'PASS', MISMATCH: 'FAIL' };

  // Dotted parameter names follow the same paths as field rules. Null prototypes
  // keep unusual payload keys as data, including __proto__ and constructor.
  function structured(value) {
    if (Array.isArray(value)) return value.map(structured);
    if (!object(value)) return value;
    const out = Object.create(null), entries = Object.entries(value);
    for (const [key, item] of entries.filter(([key]) => !key.includes('.'))) out[key] = structured(item);
    for (const [key, item] of entries.filter(([key]) => key.includes('.'))) {
      const parts = key.split('.'); let node = out;
      for (let index = 0; index < parts.length - 1; index++) {
        const part = parts[index];
        if (!own(node, part) || !object(node[part])) Object.defineProperty(node, part, { value: /^\d+$/.test(parts[index + 1]) ? [] : Object.create(null), writable: true, configurable: true, enumerable: true });
        node = node[part];
      }
      const last = parts.at(-1);
      if (last === 'length' && Array.isArray(node)) continue;
      Object.defineProperty(node, last, { value: structured(item), writable: true, configurable: true, enumerable: true });
    }
    return out;
  }
  function equal(a, b) {
    if (a === b) return true;
    if (!object(a) || !object(b) || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => own(b, key) && equal(a[key], b[key]));
  }
  const issueText = issue => messages[issue.code] || issue.code || 'Cần kiểm tra';

  function build(testCase, detail, coverage = {}) {
    const rule = testCase.rules?.[0] || {}, event = detail?.event, delivery = detail?.delivery;
    const hit = delivery ? delivery.hit : event?.layer === 'TRACKING_REQUEST' ? event : null;
    const push = delivery?.push || (event?.layer === 'JS_QUEUE' ? event : null);
    const actual = event ? structured(detail.comparison_payload ?? (hit || event).payload ?? {}) : missing;
    const expected = structured(testCase.sample ?? {}), issues = detail?.spec?.issues ?? coverage.issues ?? [];
    const verdict = !event ? coverage.status === 'NOT_SELECTED' ? 'NOT_SELECTED' : 'NOT_SEEN'
      : detail?.spec?.verdict || verdicts[coverage.status] || coverage.status || 'REVIEW';
    const fields = Object.fromEntries(Object.entries(rule.fields || {}).map(([path, field]) => [pathOf(path), field]));
    // An approved exact rule is the expected value even if its old sample differs.
    for (const [path, field] of Object.entries(fields)) if (object(expected) && field?.op === 'eq' && field.value !== undefined) {
      const parts = path.split('.'); let node = expected, valid = true;
      for (let index = 0; index < parts.length - 1; index++) {
        const part = parts[index];
        if (part === 'length' && Array.isArray(node)) { valid = false; break; }
        if (!own(node, part) || !object(node[part])) Object.defineProperty(node, part, { value: /^\d+$/.test(parts[index + 1]) ? [] : Object.create(null), enumerable: true, configurable: true, writable: true });
        node = node[part];
      }
      const last = parts.at(-1);
      if (valid && !(last === 'length' && Array.isArray(node))) Object.defineProperty(node, last, { value: structured(field.value), enumerable: true, configurable: true, writable: true });
    }
    const failures = event ? issues.filter(issue => issue.verdict === 'FAIL' || issue.verdict == null && failureCodes.has(issue.code)) : [];
    const lines = [], changes = new Set();
    function visit(left, right, path = '', depth = 0, key = null, parents = [false, false], commas = [false, false], parentIgnored = false) {
      const ignored = parentIgnored || fields[path]?.op === 'ignore' || rule.capture_platform === 'APP_SDK' && hit && /^custom_parameters\.(?:app_version|device_manufacturer|device_model|os_version|platform)$/.test(path);
      const related = failures.filter(issue => issue.path && (path === pathOf(issue.path) || path.startsWith(pathOf(issue.path) + '.')));
      const container = depth < 30 && (object(left) || object(right));
      const same = equal(left, right), sameShape = object(left) && object(right) && Array.isArray(left) === Array.isArray(right);
      const changed = !!event && !ignored && (container ? !sameShape : !same);
      const marked = changed || related.length > 0;
      const state = related.length ? 'error' : ignored ? 'ignored' : changed ? 'different' : 'same';
      const prefix = side => '  '.repeat(depth) + (key !== null && !parents[side] ? `${JSON.stringify(key)}: ` : '');
      const text = (value, side, open = false) => value === missing ? null : prefix(side) + (open && object(value) ? Array.isArray(value) ? '[' : '{' : JSON.stringify(value)) + (!open && commas[side] ? ',' : '');
      if (!container) {
        if (marked) changes.add(path);
        lines.push({ path, state, context: false, changed: marked, left: text(left, 0), right: text(right, 1), note: related.map(issue => issueText(issue) + (issue.code === 'WRONG_TYPE' && issue.expected !== undefined ? ` · Cần kiểu ${JSON.stringify(issue.expected)}` : '')).filter((value, index, all) => all.indexOf(value) === index).join(' · ') });
        return marked;
      }
      const head = { path, state, context: true, changed: marked, left: text(left, 0, object(left)), right: text(right, 1, object(right)), note: related.map(issueText).join(' · ') };
      lines.push(head);
      const a = object(left) ? Object.keys(left) : [], b = object(right) ? Object.keys(right) : [], keys = [...new Set([...a, ...b])];
      let childChange = false;
      for (const child of keys) childChange = visit(own(left, child) ? left[child] : missing, own(right, child) ? right[child] : missing,
        path ? `${path}.${child}` : child, depth + 1, child, [Array.isArray(left), Array.isArray(right)], [a.includes(child) && a.indexOf(child) < a.length - 1, b.includes(child) && b.indexOf(child) < b.length - 1], ignored) || childChange;
      head.changed = marked || childChange;
      if (marked && !keys.length) changes.add(path);
      const close = (value, side) => !object(value) ? null : '  '.repeat(depth) + (Array.isArray(value) ? ']' : '}') + (commas[side] ? ',' : '');
      lines.push({ path, state: 'same', context: true, changed: head.changed, left: close(left, 0), right: close(right, 1), note: '' });
      return head.changed;
    }
    visit(expected, actual);
    const [statusClass, statusLabel] = statuses[verdict] || statuses.REVIEW;
    return { verdict, statusClass, statusLabel, lines, changes: changes.size, issues, event, expected, actual: actual === missing ? null : actual,
      push, hit, actualLabel: hit ? 'Event gửi lên server' : event ? 'Website đã push · chưa có request' : 'Chưa thu được event', expectedAvailable: testCase.sample != null,
      globalIssues: issues.filter(issue => !issue.path || !lines.some(line => line.path === pathOf(issue.path) || line.path.startsWith(pathOf(issue.path) + '.'))) };
  }

  function render(model, { owner = 'detail' } = {}) {
    let leftNumber = 0, rightNumber = 0;
    const cell = (text, side, state) => `<div class="event-diff-cell ${text === null ? 'is-absent' : ''}"><span class="event-diff-number">${text === null ? '' : side ? ++rightNumber : ++leftNumber}</span><span class="event-diff-mark" aria-hidden="true">${state === 'error' || state === 'different' ? side ? '+' : '−' : ''}</span><code>${text === null ? '<span class="event-diff-missing">—</span>' : esc(text)}</code></div>`;
    return `<section class="event-comparison" data-comparison-owner="${esc(owner)}" data-comparison-mode="${model.changes ? 'differences' : 'all'}">
      <div class="event-comparison-summary"><span class="pill ${esc(model.statusClass)}" data-comparison-verdict="${esc(model.verdict)}">${esc(model.statusLabel)}</span><span>${model.event ? model.changes ? `${model.changes} chỗ được đánh dấu` : model.verdict === 'PASS' ? 'Không có khác biệt' : 'Xem trạng thái và lưu ý của lượt này' : 'Thao tác trên website để thu event trong lượt này.'}</span></div>
      ${model.globalIssues.length ? `<div class="event-comparison-notice">${model.globalIssues.map(issue => `<span>${issue.path ? `<code>${esc(issue.path)}</code>: ` : ''}${esc(issueText(issue))}</span>`).join('')}</div>` : ''}
      <div class="event-comparison-toolbar"><div class="segmented"><button type="button" data-comparison-mode="differences" aria-pressed="${model.changes > 0}">Chỉ chỗ khác</button><button type="button" data-comparison-mode="all" aria-pressed="${model.changes === 0}">Toàn bộ event</button></div><span>Đỏ: lệch rule · Vàng: khác ví dụ trong đặc tả</span></div>
      ${!model.expectedAvailable ? '<p class="hint">Đặc tả chưa có JSON mẫu. Xem quy tắc trong phần chi tiết bên dưới.</p>' : ''}
      <div class="event-diff-scroll"><div class="event-diff-code" role="table" aria-label="So sánh JSON đặc tả và event thực tế"><div class="event-diff-head" role="row"><div role="columnheader">ĐẶC TẢ</div><div role="columnheader">${esc(model.actualLabel)}</div></div>
      ${model.lines.map(line => `<div class="event-diff-row is-${line.state} ${line.context ? 'is-context' : ''}" data-changed="${line.changed}" data-diff-path="${esc(line.path)}" role="row">${cell(line.left, 0, line.state)}${cell(line.right, 1, line.state)}${line.note ? `<div class="event-diff-note">${esc(line.note)}</div>` : ''}</div>`).join('')}</div></div>
      <div class="event-comparison-foot">Kết luận theo bộ kiểm tra. Khác giá trị ví dụ chưa chắc là lỗi.</div>
    </section>`;
  }
  window.EventQAComparison = { build, render };
})();
