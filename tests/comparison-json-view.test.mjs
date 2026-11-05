import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL('../src/web/shared/comparison-view.js', import.meta.url), 'utf8'), context);
const { build, render } = context.window.EventQAComparison;
const spec = (sample, fields = {}) => ({ sample, rules: [{ event_name: 'page_view', fields }] });
const detail = (payload, verdict = 'PASS', issues = [], extra = {}) => {
  const hit = { event_name: 'page_view', source: 'GA4', layer: 'TRACKING_REQUEST', payload };
  return { event: hit, comparison_payload: payload, delivery: { hit, push: null }, spec: { verdict, issues }, ...extra };
};

test('a backend PASS stays PASS, including legitimate aliases and dynamic sample differences', () => {
  const expected = spec({ event: 'Listing Page View', value: 100 }, { value: { op: 'type', value: 'number' } });
  expected.rules[0].event_name = 'listing_page_view'; expected.rules[0].event_aliases = ['Listing Page View'];
  const actual = detail({ event: 'Listing Page View', value: 200 }); actual.event.event_name = 'pageView';
  const model = build(expected, actual), html = render(model);
  assert.equal(model.verdict, 'PASS'); assert.equal(model.statusClass, 'PASS'); assert.equal(model.changes, 1);
  assert.ok(!model.lines.some(line => line.state === 'error'));
  assert.match(html, /data-comparison-verdict="PASS"/); assert.ok(!html.includes('Tên event không đúng'));
});

test('missing received fields remain visibly absent and are never filled from the website push', () => {
  const expected = spec({ event: 'page_view', page_type: 'listing' }, { page_type: { op: 'eq', value: 'listing' } });
  const actual = detail({ event: 'page_view' }, 'FAIL', [{ path: 'page_type', code: 'NOT_FORWARDED', verdict: 'FAIL', pushed: 'listing' }]);
  actual.delivery.push = { event_name: 'page_view', layer: 'JS_QUEUE', payload: expected.sample };
  const model = build(expected, actual), row = model.lines.find(line => line.path === 'page_type' && !line.context);
  assert.equal(model.verdict, 'FAIL'); assert.equal(row.right, null); assert.equal(row.state, 'error');
  assert.match(row.left, /listing/); assert.match(row.note, /Website có thông tin này nhưng chưa gửi đi/);
  assert.match(render(model), /data-comparison-mode="differences"/);
});

test('zero, false, null and empty strings are shown as values, distinct from absent fields', () => {
  const payload = { zero: 0, flag: false, empty: '', nullable: null, items: [{ id: 'A' }] };
  const model = build(spec(payload), detail(payload));
  for (const [path, value] of [['zero', '0'], ['flag', 'false'], ['empty', '""'], ['nullable', 'null']]) {
    const row = model.lines.find(line => line.path === path && !line.context);
    assert.ok(row.right.includes(value)); assert.equal(row.state, 'same');
  }
  assert.equal(model.changes, 0); assert.match(render(model), /data-comparison-mode="all"/);
  assert.ok(model.lines.some(line => line.path === 'items.0.id'));
});

test('nested failures highlight the correct JSON subtree while review warnings never become red failures', () => {
  const model = build(spec({ items: [{ id: 'A' }] }), detail({ items: [] }, 'FAIL', [{ path: 'items.0.id', code: 'MISSING_FIELD', verdict: 'FAIL' }]));
  assert.equal(model.lines.find(line => line.path === 'items.0.id').state, 'error');
  const review = build(spec({ value: 1 }), detail({ value: '1' }, 'REVIEW', [{ path: 'value', code: 'WRONG_TYPE', verdict: 'REVIEW' }]));
  assert.equal(review.statusClass, 'REVIEW'); assert.ok(!review.lines.some(line => line.state === 'error'));
});

test('dotted parameters align with nested specification paths without mutating evidence or prototypes', () => {
  const raw = detail(JSON.parse('{"nested.count":0,"items.0.id":"A","__proto__.polluted":"no"}'));
  const before = JSON.stringify(raw), model = build(spec({ nested: { count: 0 }, items: [{ id: 'A' }] }), raw);
  assert.equal(model.lines.find(line => line.path === 'nested.count').state, 'same');
  assert.equal(model.lines.find(line => line.path === 'items.0.id').state, 'same');
  assert.equal(JSON.stringify(raw), before); assert.equal({}.polluted, undefined);
});

test('unselected, unseen and push-only states retain delivery meaning instead of claiming a server match', () => {
  assert.equal(build(spec({}), null, { status: 'NOT_SELECTED' }).verdict, 'NOT_SELECTED');
  assert.equal(build(spec({}), null).verdict, 'NOT_SEEN');
  const push = { event_name: 'page_view', layer: 'JS_QUEUE', payload: { event: 'page_view' } };
  const model = build(spec(push.payload), { event: push, comparison_payload: push.payload, delivery: { hit: null, push }, spec: { verdict: 'NOT_SENT', issues: [] } });
  assert.equal(model.verdict, 'NOT_SENT'); assert.match(model.basisNote, /Chưa thấy event được gửi đi/);
});

test('ignored subtrees do not become visual mismatches, and unsafe values are escaped', () => {
  const model = build(spec({ context: { name: 'old' } }, { context: { op: 'ignore' } }), detail({ context: { name: 'new' } }));
  assert.equal(model.changes, 0);
  const html = render(build(spec({ x: '<img src=x onerror=alert(1)>' }), detail({ x: '</code><script>bad()</script>' })));
  assert.ok(!html.includes('<img') && !html.includes('<script>')); assert.match(html, /&lt;img/); assert.match(html, /&lt;script/);
});

test('exact approved rules override stale examples and expose missing values directly in the expected JSON', () => {
  const expected = spec({ price: 100 }, { price: { op: 'eq', value: 200 }, currency: { op: 'eq', value: 'VND' } });
  const model = build(expected, detail({ price: 100 }, 'FAIL', [{ path: 'price', code: 'VALUE_MISMATCH', verdict: 'FAIL' }, { path: 'currency', code: 'MISSING_FIELD', verdict: 'FAIL' }]));
  assert.match(model.lines.find(line => line.path === 'price').left, /200/);
  assert.match(model.lines.find(line => line.path === 'currency').left, /VND/);
  assert.equal(model.lines.find(line => line.path === 'currency').right, null);
  assert.equal(expected.sample.price, 100, 'the original specification is unchanged');
});

test('rule failures remain visible in differences-only mode even when both example and actual values are identical', () => {
  const model = build(spec({ price: 100, label: 'old' }, { price: { op: 'range', value: { max: 10 } } }),
    detail({ price: 100, label: 'new' }, 'FAIL', [{ path: 'price', code: 'VALUE_MISMATCH', verdict: 'FAIL' }]));
  const row = model.lines.find(line => line.path === 'price');
  assert.equal(row.left, row.right); assert.equal(row.state, 'error'); assert.equal(row.changed, true);
  assert.ok(model.changes > 0);
});
