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
  const messages = { MISSING_FIELD: 'Thiếu thông tin bắt buộc', NULL_FIELD: 'Thông tin này đang trống', VALUE_MISMATCH: 'Giá trị không đúng yêu cầu', WRONG_TYPE: 'Sai kiểu dữ liệu', DYNAMIC_VALUE_MISMATCH: 'Không giống thông tin đã nhập trên website',
    NOT_FORWARDED: 'Website có thông tin này nhưng chưa gửi đi', UNEXPECTED_FIELD: 'Thông tin này không được phép xuất hiện', EVENT_NAME_MISMATCH: 'Tên event không đúng đặc tả',
    NOT_SENT: 'Website đã tạo event nhưng chưa thấy gửi đi', PENDING_DELIVERY: 'Đang chờ website gửi event', CAPTURE_INCOMPLETE: 'Chưa thu được đầy đủ dữ liệu. Hãy thử lại', NO_EXPECTED_FIELDS: 'Chưa có yêu cầu để kiểm tra event này', LAYER_MISMATCH: 'Cần chọn đúng dữ liệu trên website hoặc dữ liệu đã gửi', SOURCE_MISMATCH: 'Chọn sai nền tảng. GA4 so với GA4, Insider so với Insider',
    SPEC_PLATFORM_MISMATCH: 'Mẫu dành cho ứng dụng; chưa đủ thông tin để kiểm tra website', SPEC_INCOMPLETE: 'Mẫu trong file chưa đầy đủ', AMBIGUOUS_SPEC: 'Có nhiều dòng đặc tả phù hợp; chưa biết dùng dòng nào', MISSING_CONTEXT: 'Chưa có thông tin đã nhập trên website để so sánh', INVALID_RULE: 'Cách kiểm tra chưa hợp lệ' };
  const statuses = { PASS: ['PASS', 'Chưa thấy lỗi'], FAIL: ['FAIL', 'Có lỗi'], REVIEW: ['REVIEW', 'Cần kiểm tra thêm'], NOT_SENT: ['FAIL', 'Chưa thấy gửi đi'], PENDING: ['REVIEW', 'Đang chờ gửi'], NOT_SELECTED: ['', 'Chưa chọn luồng'], NOT_SEEN: ['', 'Chưa có event trong lượt này'] };
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
  const typeText = value => [].concat(value).map(type => ({ string: 'văn bản', number: 'số', integer: 'số nguyên', boolean: 'đúng / sai', array: 'danh sách', object: 'nhóm thông tin', null: 'giá trị trống' }[type] || type)).join(' hoặc ');
  const sourceText = source => source === 'INSIDER' ? 'Insider' : source;
  function fieldNote(field, check) {
    if (!field || field.op === 'ignore') return 'Chưa kiểm tra nội dung này.';
    if (field.op === 'type') return `${check?.verdict === 'PASS' ? 'Đúng kiểu dữ liệu' : 'Cần kiểu dữ liệu'}: ${typeText(field.value)}. Chưa kiểm tra nội dung.`;
    if (field.op === 'exists' || field.op === 'ref' && check?.op === 'exists') return 'Chỉ kiểm tra có dữ liệu. Chưa kiểm tra nội dung.';
    if (field.op === 'eq') return `Cần đúng giá trị: ${JSON.stringify(field.value)}.`;
    if (field.op === 'one_of') return `Chấp nhận một trong các giá trị: ${JSON.stringify(field.value)}.`;
    if (field.op === 'subset') return `Cần có: ${JSON.stringify(field.value)}.`;
    if (field.op === 'range') return field.value?.min != null && field.value?.max != null ? `Cho phép từ ${field.value.min} đến ${field.value.max}.`
      : field.value?.min != null ? `Tối thiểu: ${field.value.min}.` : `Tối đa: ${field.value?.max}.`;
    if (field.op === 'regex') return `Cần đúng định dạng: ${field.value}.`;
    return 'So với yêu cầu đã lưu.';
  }

  function build(testCase, detail, coverage = {}) {
    const rule = testCase.rules?.[detail?.spec?.rule_index ?? 0] || {}, event = detail?.event, delivery = detail?.delivery, basis = detail?.spec?.comparison;
    const hit = delivery ? delivery.hit : event?.layer === 'TRACKING_REQUEST' ? event : null;
    const push = delivery?.push || (event?.layer === 'JS_QUEUE' ? event : null);
    const actual = event ? structured(detail.comparison_payload ?? event.payload ?? {}) : missing;
    const expected = structured(testCase.sample ?? {}), issues = detail?.spec?.issues ?? coverage.issues ?? [];
    const verdict = !event ? coverage.status === 'NOT_SELECTED' ? 'NOT_SELECTED' : 'NOT_SEEN'
      : detail?.spec?.verdict || verdicts[coverage.status] || coverage.status || 'REVIEW';
    const checks = detail?.spec?.checks?.filter(check => check.path && check.op !== 'ignore') || [];
    const source = String(basis?.source || event?.source || testCase.source || rule.source || '').toUpperCase();
    const expectedSource = String(rule.source || testCase.source || '').toUpperCase();
    const queueBasis = (basis?.layer || event?.layer) === 'JS_QUEUE';
    const actualLabel = !event ? 'Chưa thu được event' : `Thực tế · ${sourceText(source)}`;
    const basisNote = !event ? '' : queueBasis ? `Đang so sánh dữ liệu ${sourceText(source)} trên website. ${hit ? 'Đã thấy event được gửi đi.' : 'Chưa thấy event được gửi đi.'}`
      : `Đang so sánh dữ liệu đã gửi tới ${sourceText(source)}.`;
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
        const explanation = related.length ? related.map(issue => issueText(issue) + (issue.code === 'WRONG_TYPE' && issue.expected !== undefined ? ` · Cần kiểu ${typeText(issue.expected)}` : '')).filter((value, index, all) => all.indexOf(value) === index).join(' · ')
          : changed ? fieldNote(fields[path], checks.find(check => pathOf(check.path) === path)) : '';
        lines.push({ path, state, context: false, changed: marked, left: text(left, 0), right: text(right, 1), note: explanation });
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
      push, hit, actualLabel, expectedLabel: `Theo đặc tả${expectedSource ? ` · ${sourceText(expectedSource)}` : ''}`, basisNote, checked: checks.length, passed: checks.filter(check => check.verdict === 'PASS').length,
      errors: new Set(failures.filter(issue => issue.path).map(issue => pathOf(issue.path))).size,
      examples: new Set(lines.filter(line => !line.context && line.state === 'different').map(line => line.path)).size, expectedAvailable: testCase.sample != null,
      globalIssues: issues.filter(issue => !issue.path || !lines.some(line => line.path === pathOf(issue.path) || line.path.startsWith(pathOf(issue.path) + '.'))) };
  }

  function render(model, { owner = 'detail' } = {}) {
    let leftNumber = 0, rightNumber = 0;
    const cell = (text, side, state) => `<div class="event-diff-cell ${text === null ? 'is-absent' : ''}"><span class="event-diff-number">${text === null ? '' : side ? ++rightNumber : ++leftNumber}</span><span class="event-diff-mark" aria-hidden="true">${state === 'error' || state === 'different' ? side ? '+' : '−' : ''}</span><code>${text === null ? '<span class="event-diff-missing">—</span>' : esc(text)}</code></div>`;
    return `<section class="event-comparison" data-comparison-owner="${esc(owner)}" data-comparison-mode="${model.changes ? 'differences' : 'all'}">
      <div class="event-comparison-summary"><span class="pill ${esc(model.statusClass)}" data-comparison-verdict="${esc(model.verdict)}">${esc(model.statusLabel)}</span><span>${model.event ? [model.checked ? `Đạt ${model.passed}/${model.checked} yêu cầu` : '', model.errors ? `${model.errors} mục có lỗi` : '', model.examples ? `${model.examples} mục khác mẫu` : '', !model.changes && model.verdict === 'PASS' ? 'Không có chỗ khác trong phần so sánh' : ''].filter(Boolean).join(' · ') || 'Xem ghi chú bên dưới' : 'Thao tác trên website để thu event trong lượt này.'}</span></div>
      ${model.basisNote ? `<p class="event-comparison-basis">${esc(model.basisNote)}</p>` : ''}
      ${model.globalIssues.length ? `<div class="event-comparison-notice">${model.globalIssues.map(issue => `<span>${issue.path ? `<code>${esc(issue.path)}</code>: ` : ''}${esc(issueText(issue))}</span>`).join('')}</div>` : ''}
      <div class="event-comparison-toolbar"><div class="segmented"><button type="button" data-comparison-mode="differences" aria-pressed="${model.changes > 0}">Chỉ xem chỗ khác</button><button type="button" data-comparison-mode="all" aria-pressed="${model.changes === 0}">Xem tất cả</button></div><span>Đỏ: có lỗi · Vàng: khác mẫu, xem ghi chú</span></div>
      ${!model.expectedAvailable ? '<p class="hint">File chưa có dữ liệu mẫu. Xem yêu cầu kiểm tra bên dưới.</p>' : ''}
      <div class="event-diff-scroll"><div class="event-diff-code" role="table" aria-label="So sánh JSON đặc tả và event thực tế"><div class="event-diff-head" role="row"><div role="columnheader">${esc(model.expectedLabel)}</div><div role="columnheader">${esc(model.actualLabel)}</div></div>
      ${model.lines.map(line => `<div class="event-diff-row is-${line.state} ${line.context ? 'is-context' : ''}" data-changed="${line.changed}" data-diff-path="${esc(line.path)}" role="row">${cell(line.left, 0, line.state)}${cell(line.right, 1, line.state)}${line.note ? `<div class="event-diff-note">${esc(line.note)}</div>` : ''}</div>`).join('')}</div></div>
      <div class="event-comparison-foot">“Chưa thấy lỗi” chỉ áp dụng cho phần đã kiểm tra. Mục ghi “Chưa kiểm tra nội dung” chưa được xác nhận đúng/sai.</div>
    </section>`;
  }
  window.EventQAComparison = { build, render };
})();
