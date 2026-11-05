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
    NOT_SENT: 'Website đã push nhưng chưa có request gửi đi', PENDING_DELIVERY: 'Đang chờ request gửi đi', CAPTURE_INCOMPLETE: 'Dữ liệu thu thập chưa đầy đủ', NO_EXPECTED_FIELDS: 'Đặc tả chưa có quy tắc kiểm từng trường', LAYER_MISMATCH: 'Event thuộc tầng dữ liệu khác đặc tả', SOURCE_MISMATCH: 'Sai nền tảng: GA4 chỉ so với GA4, Insider chỉ so với Insider',
    SPEC_PLATFORM_MISMATCH: 'Mẫu dành cho ứng dụng; cần kiểm tra cách ghép với dữ liệu website', SPEC_INCOMPLETE: 'Mẫu đặc tả chưa đầy đủ', AMBIGUOUS_SPEC: 'Nhiều dòng đặc tả cùng phù hợp', MISSING_CONTEXT: 'Chưa có dữ liệu ngữ cảnh để kết luận' };
  const statuses = { PASS: ['PASS', 'Đạt quy tắc'], FAIL: ['FAIL', 'Lệch quy tắc'], REVIEW: ['REVIEW', 'Cần kiểm tra'], NOT_SENT: ['FAIL', 'Có push, chưa gửi server'], PENDING: ['REVIEW', 'Đang chờ gửi'], NOT_SELECTED: ['', 'Chưa chọn luồng'], NOT_SEEN: ['', 'Chưa có event trong lượt này'] };
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
  const typeText = value => [].concat(value).map(type => ({ string: 'chuỗi', number: 'số', integer: 'số nguyên', boolean: 'boolean', array: 'mảng', object: 'object', null: 'null' }[type] || type)).join(' / ');
  function fieldNote(field, check) {
    if (!field || field.op === 'ignore') return 'Trường này chưa có quy tắc kiểm giá trị.';
    if (field.op === 'type') return `${check?.verdict === 'PASS' ? 'Đạt' : 'Yêu cầu'} kiểu ${typeText(field.value)}. Giá trị trong mẫu chỉ là ví dụ.`;
    if (field.op === 'exists' || field.op === 'ref' && check?.op === 'exists') return 'Chỉ kiểm tra trường có dữ liệu; chưa đối chiếu giá trị với API hoặc thao tác.';
    if (field.op === 'eq') return `Phải bằng ${JSON.stringify(field.value)}.`;
    if (field.op === 'one_of') return `Phải thuộc ${JSON.stringify(field.value)}.`;
    if (field.op === 'subset') return `Phải chứa ${JSON.stringify(field.value)}.`;
    if (field.op === 'range') return `Phải nằm trong khoảng ${JSON.stringify(field.value)}.`;
    if (field.op === 'regex') return `Phải đúng mẫu ${field.value}.`;
    return 'Kiểm tra theo quy tắc đã khai báo.';
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
    const queue = source === 'INSIDER' ? push?.queue_name || 'InsiderQueue' : source === 'GA4' ? 'dataLayer' : 'JS queue';
    const actualLabel = !event ? 'Chưa thu được event' : queueBasis ? `${source} · ${queue}${!hit ? ' · chưa có request' : ''}` : `${source} · Request gửi đi`;
    const basisNote = !event ? '' : queueBasis ? `Đang kiểm tra ${queue}. ${hit ? `Đã thấy request ${source} gửi đi; nội dung request được xem riêng bên dưới.` : `Chưa có request ${source} để kiểm tra dữ liệu gửi đi.`}`
      : `Đang kiểm tra nội dung request ${source} gửi đi${basis?.format === 'GA4_RECEIVED' || basis?.format === 'INSIDER_RECORDED' ? ', đã đổi tên trường về dạng dùng trong đặc tả' : ''}.`;
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
      push, hit, actualLabel, expectedLabel: `Đặc tả ${expectedSource}`, basisNote, checked: checks.length, passed: checks.filter(check => check.verdict === 'PASS').length,
      errors: new Set(failures.filter(issue => issue.path).map(issue => pathOf(issue.path))).size,
      examples: new Set(lines.filter(line => !line.context && line.state === 'different').map(line => line.path)).size, expectedAvailable: testCase.sample != null,
      globalIssues: issues.filter(issue => !issue.path || !lines.some(line => line.path === pathOf(issue.path) || line.path.startsWith(pathOf(issue.path) + '.'))) };
  }

  function render(model, { owner = 'detail' } = {}) {
    let leftNumber = 0, rightNumber = 0;
    const cell = (text, side, state) => `<div class="event-diff-cell ${text === null ? 'is-absent' : ''}"><span class="event-diff-number">${text === null ? '' : side ? ++rightNumber : ++leftNumber}</span><span class="event-diff-mark" aria-hidden="true">${state === 'error' || state === 'different' ? side ? '+' : '−' : ''}</span><code>${text === null ? '<span class="event-diff-missing">—</span>' : esc(text)}</code></div>`;
    return `<section class="event-comparison" data-comparison-owner="${esc(owner)}" data-comparison-mode="${model.changes ? 'differences' : 'all'}">
      <div class="event-comparison-summary"><span class="pill ${esc(model.statusClass)}" data-comparison-verdict="${esc(model.verdict)}">${esc(model.statusLabel)}</span><span>${model.event ? [model.checked ? `${model.passed}/${model.checked} quy tắc đạt` : '', model.errors ? `${model.errors} trường lệch quy tắc` : '', model.examples ? `${model.examples} trường khác ví dụ` : '', !model.changes && model.verdict === 'PASS' ? 'Không có khác biệt' : ''].filter(Boolean).join(' · ') || 'Xem trạng thái và lưu ý của lượt này' : 'Thao tác trên website để thu event trong lượt này.'}</span></div>
      ${model.basisNote ? `<p class="event-comparison-basis">${esc(model.basisNote)}</p>` : ''}
      ${model.globalIssues.length ? `<div class="event-comparison-notice">${model.globalIssues.map(issue => `<span>${issue.path ? `<code>${esc(issue.path)}</code>: ` : ''}${esc(issueText(issue))}</span>`).join('')}</div>` : ''}
      <div class="event-comparison-toolbar"><div class="segmented"><button type="button" data-comparison-mode="differences" aria-pressed="${model.changes > 0}">Chỉ chỗ khác</button><button type="button" data-comparison-mode="all" aria-pressed="${model.changes === 0}">Toàn bộ event</button></div><span>Đỏ: lệch rule · Vàng: khác ví dụ trong đặc tả</span></div>
      ${!model.expectedAvailable ? '<p class="hint">Đặc tả chưa có JSON mẫu. Xem quy tắc trong phần chi tiết bên dưới.</p>' : ''}
      <div class="event-diff-scroll"><div class="event-diff-code" role="table" aria-label="So sánh JSON đặc tả và event thực tế"><div class="event-diff-head" role="row"><div role="columnheader">${esc(model.expectedLabel)}</div><div role="columnheader">${esc(model.actualLabel)}</div></div>
      ${model.lines.map(line => `<div class="event-diff-row is-${line.state} ${line.context ? 'is-context' : ''}" data-changed="${line.changed}" data-diff-path="${esc(line.path)}" role="row">${cell(line.left, 0, line.state)}${cell(line.right, 1, line.state)}${line.note ? `<div class="event-diff-note">${esc(line.note)}</div>` : ''}</div>`).join('')}</div></div>
      <div class="event-comparison-foot">Đạt quy tắc: đúng nền tảng, đúng tên event (hoặc tên tương đương), đạt các điều kiện đã khai báo. Trường chỉ kiểm kiểu hoặc sự có mặt được phép khác giá trị ví dụ; giá trị đó chưa được xác nhận với API.</div>
    </section>`;
  }
  window.EventQAComparison = { build, render };
})();
