import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TestLabTracker, TestLabCatalog, testLabEvent, testLabValue, testLabSpecView, defineComparison, isInsiderPanel, isTestLabCatalog } from '../src/core/testlab.mjs';
import { importDefine, defineTemplate } from '../src/spec/define.mjs';
import { createApp } from '../src/server.mjs';
import ExcelJS from 'exceljs';
import { writeFileSync } from 'node:fs';
import { matchTracked, specCoverage } from '../src/core/catalog.mjs';
import { validateCase } from '../src/core/rules.mjs';
import { SessionManager } from '../src/core/session.mjs';
import { findBrowser } from '../src/browser/launcher.mjs';
import { CDPCollector, CDPConnection, listTargets } from '../src/collectors/cdp.mjs';

// The panel's catalogue (GET …/test-lab/items), in its real shape.
const CATALOG = { data: [
  { id: 'event:product_detail_page_view', kind: 'event', key: 'product_detail_page_view', display_name: 'Product Page View', type: 'default', parameters: [
    { key: 'c_slug', display_name: 'Slug', type: 'custom', data_type: 'string' }, { key: 'c_unit_price_string', display_name: 'Unit Price String', type: 'custom', data_type: 'string' },
    { key: 'up', display_name: 'Unit Price', type: 'default', data_type: 'number' }, { key: 'usp', display_name: 'Unit Sales Price', type: 'default', data_type: 'number' },
    { key: 'ta', display_name: 'Taxonomy', type: 'default', data_type: 'array' }, { key: 'c_is_logged_in', display_name: 'Is Logged In', type: 'custom', data_type: 'boolean' },
    { key: 'c_site_code', display_name: 'Site Code', type: 'custom', data_type: 'string' },
    { key: 'c_adults', display_name: 'Adults', type: 'custom', data_type: 'number', failed_detail: { ios: { expected_type: 'number', observed_type: 'string', sdk_version: '14.1.0' } } }] },
  { kind: 'event', key: 'item_added_to_cart', display_name: 'Add to Cart', type: 'default', parameters: [] },
  { kind: 'event', key: 'add_to_cart', display_name: 'Add To Cart', type: 'custom', parameters: [] },
  { kind: 'attribute', key: 'ag', display_name: 'Age', data_type: 'number', type: 'default' }] };
const catalog = () => { const list = new TestLabCatalog(); list.add(CATALOG); return list; };
const param = (key, name, subtype, value, status = 'successful') => ({ key, name, type: 'Event Parameter', subtype, value, status });
// Product Page View as the grid lists it: receipt 4, parameter keys from its group column.
const PRODUCT = [param('c_slug', 'Slug', 'Custom', 'uat-vinwonders-ngatest-ticket-binh-giu-nhiet'), param('c_unit_price_string', 'Unit Price String', 'Custom', '1.149.999'),
  param('up', 'Unit Price', 'Default', '1149999'), param('usp', 'Unit Sales Price', 'Default', '1038888'), param('ta', 'Taxonomy', 'Default', 'attraction'),
  param('c_site_code', 'Site Code', 'Custom', '00123'), param('c_adults', 'Adults', 'Custom', 'two', 'failed')];
const product = (params, extra = {}) => ({ group: '4', name: 'Product Page View', type: 'Event', subtype: 'Default', value: '', status: 'in_progress', complete: true, params, ...extra });

test('Insider panel pages and its Test Lab catalogue call are recognised', () => {
  assert.equal(isInsiderPanel('https://mobile.useinsider.com/test_lab'), true);
  assert.equal(isInsiderPanel('https://inone.useinsider.com/test-lab'), true);
  for (const url of ['https://unification.useinsider.com/api/event/v1', 'https://vinpearl.api.useinsider.com/track', 'https://api.useinsider.com/x', 'https://useinsider.com.evil.test/', 'https://www.vinpearlota.com/', 'about:blank'])
    assert.equal(isInsiderPanel(url), false, url);
  assert.equal(isTestLabCatalog('https://mobile.useinsider.com/api/dashboard/v1/test-lab/items?page=1&per_page=100'), true);
  assert.equal(isTestLabCatalog('https://mobile.useinsider.com/api/dashboard/v1/test-lab/sessions'), false);
});

test('a Test Lab event keeps what Test Lab shows; its spec view takes keys and types from the catalogue', () => {
  const event = testLabEvent(product(PRODUCT), { catalog: catalog(), url: 'https://mobile.useinsider.com/test_lab', targetId: 'T1', at: '2026-11-12T15:00:00.000Z' });
  assert.equal(event.layer, 'TEST_LAB');
  assert.equal(event.event_name, 'product_detail_page_view');
  assert.deepEqual(event.aliases, ['Product Page View', 'product_page_view']);
  // The record: the NAME and VALUE columns as Test Lab shows them, Default / Custom as its TYPE says, nothing renamed or retyped.
  assert.deepEqual(event.payload, { event: 'Product Page View',
    default_parameters: { 'Unit Price': '1149999', 'Unit Sales Price': '1038888', Taxonomy: 'attraction' },
    custom_parameters: { Slug: 'uat-vinwonders-ngatest-ticket-binh-giu-nhiet', 'Unit Price String': '1.149.999', 'Site Code': '00123', Adults: 'two' } });
  assert.deepEqual(Object.keys(event.payload.default_parameters), ['Unit Price', 'Unit Sales Price', 'Taxonomy'], 'in the table\'s order');
  // The view a specification is checked on: usp is unit_sale_price (not the label's "unit_sales_price"); numbers, arrays and strings as Insider declares them.
  assert.deepEqual(testLabSpecView(event), { event: 'Product Page View',
    default_parameters: { unit_price: 1149999, unit_sale_price: 1038888, taxonomy: ['attraction'] },
    custom_parameters: { slug: 'uat-vinwonders-ngatest-ticket-binh-giu-nhiet', unit_price_string: '1.149.999', site_code: '00123', adults: 'two' } });
  const adults = event.testlab.params.find(item => item.key === 'c_adults');
  assert.deepEqual(adults, { name: 'Adults', key: 'c_adults', field: 'custom_parameters.adults', value: 'two', status: 'failed', data_type: 'number',
    failed_detail: { ios: { expected_type: 'number', observed_type: 'string', sdk_version: '14.1.0' } } });
  assert.equal(event.testlab.receipt, '4');
  assert.equal(event.testlab.catalog_key, 'product_detail_page_view');
  assert.equal(event.capture, undefined);
  // Labels differing only by case are different events.
  assert.equal(testLabEvent({ name: 'Add to Cart', type: 'Event', params: [] }, { catalog: catalog() }).event_name, 'item_added_to_cart');
  assert.equal(testLabEvent({ name: 'Add To Cart', type: 'Event', params: [] }, { catalog: catalog() }).event_name, 'add_to_cart');
  // No catalogue: names and values read as Insider's copied samples are.
  const home = testLabEvent({ name: 'Homepage View', type: 'Event', complete: true, params: [param(null, 'App Version', 'Custom', '1.0'), param(null, 'Is Logged In', 'Custom', 'true')] });
  assert.equal(home.event_name, 'homepage_view');
  assert.deepEqual(home.payload.custom_parameters, { 'App Version': '1.0', 'Is Logged In': 'true' });
  assert.deepEqual(testLabSpecView(home).custom_parameters, { app_version: '1.0', is_logged_in: true });
  const attribute = testLabEvent({ name: 'Age', type: 'Attribute', subtype: 'Default', value: '31', params: [] }, { catalog: catalog() });
  assert.deepEqual([attribute.event_name, attribute.event_kind, attribute.payload.value], ['insider_attribute_ag', 'observation', '31']);
  assert.deepEqual([testLabValue('x', '1,250,000', 'number'), testLabValue('x', '1.149.999', 'number'), testLabValue('x', 'false', 'boolean'), testLabValue('x', '["a","b"]', 'array')],
    [1250000, '1.149.999', false, ['a', 'b']]);
});

test('each receipt is one event that later readings complete', () => {
  const tracker = new TestLabTracker(), meta = at => ({ url: 'https://mobile.useinsider.com/test_lab', targetId: 'T1', at });
  const list = catalog();
  // The page opens: receipt 4 shows its first parameters only, receipt 1 (no parameters) is whole.
  const first = tracker.update({ reader: 'ag-grid', groups: [product(PRODUCT.slice(0, 2), { complete: false }), { group: '1', name: 'Mobile App Open', type: 'Event', status: 'successful', complete: true, params: [] }] }, meta('2026-11-12T15:00:00.000Z'), list);
  assert.deepEqual(first.map(op => [op.op, op.event.event_name, op.event.historical, op.event.capture?.reason ?? null]), [
    ['new', 'product_detail_page_view', true, 'testlab_partial'], ['new', 'mobile_app_open', true, null]]);
  const ref = first[0].ref;
  // Scrolled: receipt 4's event row is off screen; its next parameters still go to it.
  const scrolled = tracker.update({ reader: 'ag-grid', groups: [{ group: '4', name: null, params: PRODUCT.slice(2, 5), complete: false }] }, meta('2026-11-12T15:00:30.000Z'), list);
  assert.deepEqual(scrolled.map(op => [op.op, op.ref, Object.keys(op.event.payload.default_parameters).length, Boolean(op.event.capture)]), [['update', ref, 3, true]]);
  // The rest comes into view, whole, and Insider marks the event successful.
  const whole = tracker.update({ reader: 'ag-grid', groups: [product(PRODUCT.slice(4), { status: 'successful' })] }, meta('2026-11-12T15:00:40.000Z'), list);
  assert.equal(whole.length, 1);
  assert.equal(whole[0].ref, ref);
  assert.equal(whole[0].event.capture, undefined);
  assert.equal(whole[0].event.testlab.status, 'successful');
  assert.equal(whole[0].event.testlab.params.length, PRODUCT.length);
  assert.deepEqual(tracker.update({ reader: 'ag-grid', groups: [product(PRODUCT.slice(4), { status: 'successful' })] }, meta('2026-11-12T15:00:50.000Z'), list), [], 'nothing new, nothing to do');
  // A new receipt of the same event later on is another event, a live one.
  const again = tracker.update({ reader: 'ag-grid', groups: [product(PRODUCT, { group: '5' })] }, meta('2026-11-12T15:01:00.000Z'), list);
  assert.deepEqual(again.map(op => [op.op, op.event.historical, op.event.testlab.receipt]), [['new', false, '5']]);
  // The same number under another name: the panel started over, another receipt.
  assert.deepEqual(tracker.update({ reader: 'ag-grid', groups: [{ group: '1', name: 'Homepage View', type: 'Event', complete: true, params: [] }] }, meta('2026-11-12T15:02:00.000Z'), list).map(op => [op.op, op.event.event_name]), [['new', 'homepage_view']]);
  // Parameters seen before their event row wait for it.
  tracker.update({ reader: 'ag-grid', groups: [{ group: '7', name: null, params: [param('c_slug', 'Slug', 'Custom', 'a')], complete: false }] }, meta('2026-11-12T15:03:00.000Z'), list);
  const joined = tracker.update({ reader: 'ag-grid', groups: [{ group: '7', name: 'Product Page View', type: 'Event', complete: true, params: [param('up', 'Unit Price', 'Default', '5')] }] }, meta('2026-11-12T15:03:05.000Z'), list);
  assert.deepEqual(joined[0].event.payload, { event: 'Product Page View', default_parameters: { 'Unit Price': '5' }, custom_parameters: { Slug: 'a' } });
});

test('a table without receipt numbers is read by its rows', () => {
  const tracker = new TestLabTracker(), meta = at => ({ url: 'https://inone.useinsider.com/test-lab', targetId: 'T2', at });
  const rows = [{ name: 'Homepage View', type: 'Event', subtype: 'Default', value: '', status: 'in_progress' }, { name: 'Page Type', type: 'Event Parameter', subtype: 'Custom', value: 'homepage', status: 'successful' },
    { name: 'Mobile App Open', type: 'Event', subtype: 'Default', value: '', status: 'successful' }];
  const first = tracker.update({ rows }, meta('2026-11-12T10:00:00.000Z'));
  assert.deepEqual(first.map(op => [op.op, op.event.event_name, op.event.payload.custom_parameters['Page Type'] ?? null]), [['new', 'homepage_view', 'homepage'], ['new', 'mobile_app_open', null]]);
  assert.deepEqual(tracker.update({ rows: rows.map((row, i) => i === 0 ? { ...row, status: 'successful' } : row) }, meta('2026-11-12T10:00:30.000Z')).map(op => [op.op, op.ref]), [['update', first[0].ref]]);
  const changed = tracker.update({ rows: rows.map((row, i) => i === 1 ? { ...row, value: 'home' } : i === 0 ? { ...row, status: 'successful' } : row) }, meta('2026-11-12T10:01:00.000Z'));
  assert.deepEqual(changed.map(op => [op.op, op.event.historical, op.event.payload.custom_parameters['Page Type']]), [['new', false, 'home']]);
  assert.deepEqual(tracker.update({ rows: [] }, meta('2026-11-12T10:01:10.000Z')), []);
});

// An AppOTA_Insider row of R1511 as imported from a JSON sample (capture_platform APP_SDK).
const appCase = { id: 'R1511-PDP', name: 'All / product_detail_page_view', source: 'INSIDER', flow: 'All', needs_review: false,
  rules: [{ event_name: 'product_detail_page_view', source: 'INSIDER', layer: 'TRACKING_REQUEST', capture_platform: 'APP_SDK', event_aliases: ['Product Page View'], count: { min: 1, max: 1 }, sample_status: 'complete',
    fields: { 'default_parameters.unit_sale_price': { op: 'type', value: 'number' }, 'default_parameters.taxonomy': { op: 'subset', value: ['attraction'] }, 'custom_parameters.slug': { op: 'exists' } } }] };

test('a Test Lab event is judged against the AppOTA_Insider row once it is read whole', () => {
  const event = { ...testLabEvent(product(PRODUCT), { catalog: catalog() }), evidence_id: 'EV-1' };
  const match = matchTracked([appCase], event);
  assert.equal(match.case_id, 'R1511-PDP');
  assert.equal(match.verdict, 'PASS', JSON.stringify(match.issues));
  assert.equal(specCoverage([appCase], [event]).rows[0].status, 'MATCH');
  // Test Lab shows the sale price formatted as text: not the number the row expects.
  const wrong = { ...event, evidence_id: 'EV-2', testlab: { ...event.testlab, params: event.testlab.params.map(item => item.key === 'usp' ? { ...item, value: '1.038.888' } : item) } };
  assert.equal(matchTracked([appCase], wrong).verdict, 'FAIL');
  // Not read whole yet: the check waits.
  const partial = { ...testLabEvent(product(PRODUCT.slice(0, 2), { complete: false }), { catalog: catalog() }), evidence_id: 'EV-3' };
  assert.equal(matchTracked([appCase], partial).verdict, 'REVIEW');
  // A web Insider row of the same event is not what the app sent.
  assert.equal(matchTracked([{ ...appCase, id: 'WEB', rules: [{ ...appCase.rules[0], capture_platform: undefined }] }], event), null);
});

test('a revised record keeps its evidence id and place, and its step is checked again', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'eventqa-revise-'));
  const manager = new SessionManager({ runsDir, cases: [appCase] });
  try {
    manager.start({ environment: 'https://mobile.useinsider.com' });
    manager.startStep('R1511-PDP');
    const partial = manager.emit(testLabEvent(product(PRODUCT.slice(0, 2), { complete: false }), { catalog: catalog() }));
    const later = manager.emit({ source: 'INSIDER', layer: 'TEST_LAB', event_name: 'mobile_app_open', event_kind: 'business', payload: { event: 'Mobile App Open', default_parameters: {}, custom_parameters: {} } });
    assert.equal(manager.completeStep().verdict, 'REVIEW', 'waits while the event is incomplete');
    const revised = manager.revise(partial.evidence_id, testLabEvent(product(PRODUCT), { catalog: catalog() }));
    assert.equal(revised.evidence_id, partial.evidence_id);
    assert.equal(revised.step_id, partial.step_id);
    assert.equal(revised.captured_at, partial.captured_at);
    const events = manager.snapshot().events;
    assert.deepEqual(events.map(event => event.evidence_id), [partial.evidence_id, later.evidence_id]);
    assert.equal(events[0].payload.default_parameters['Unit Sales Price'], '1038888');
    assert.equal(manager.snapshot().results.find(result => result.test_case_id === 'R1511-PDP').verdict, 'PASS');
    assert.equal(manager.revise('EV-missing', {}), null);
  } finally { manager.abort(); rmSync(runsDir, { recursive: true, force: true }); }
});

// ---- the reader in a real browser ----------------------------------------------------------------
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
// Displayed rows of an ag-Grid Test Results table: receipt 4 open with 6 parameters, 3 open with 2, 2 closed, 1 without parameters.
const GRID_ROWS = [
  { id: '10', level: 0, path: ['4'], name: 'Product Page View', type: 'Event', sub: 'Default', value: '', status: 'In Progress', group: 'expanded' },
  ...PRODUCT.slice(0, 6).map((p, i) => ({ id: String(11 + i), level: 1, path: ['4', p.key], name: p.name, type: 'Event Parameter', sub: p.subtype, value: p.value, status: 'Success' })),
  { id: '6', level: 0, path: ['3'], name: 'Listing Page View', type: 'Event', sub: 'Default', value: '', status: 'In Progress', group: 'expanded' },
  { id: '7', level: 1, path: ['3', 'c_platform'], name: 'Platform', type: 'Event Parameter', sub: 'Custom', value: 'AppOTA', status: 'Success' },
  { id: '8', level: 1, path: ['3', 'c_app_version'], name: 'App Version', type: 'Event Parameter', sub: 'Custom', value: '1.0', status: 'Failed' },
  { id: '3', level: 0, path: ['2'], name: 'Homepage View', type: 'Event', sub: 'Default', value: '', status: 'In Progress', group: 'contracted' },
  { id: '0', level: 0, path: ['1'], name: 'Mobile App Open', type: 'Event', sub: 'Default', value: '', status: 'Success' },
];
// Homepage View's parameters: in the grid's model only, as its event is closed.
const HIDDEN = [{ id: '4', level: 1, path: ['2', 'c_page_type'], name: 'Page Type', type: 'Event Parameter', sub: 'Custom', value: 'homepage', status: 'Success' }];
const gridRow = (row, index) => `<div role="row" row-id="${row.id}" row-index="${index}" aria-rowindex="${index + 2}" class="ag-row ag-row-level-${row.level}${row.group ? ` ag-row-group ag-row-group-${row.group}` : ''}" style="height:64px;transform:translateY(${index * 64}px)">
<div role="gridcell" col-id="group"><span class="ag-cell-wrapper"><span class="ag-group-expanded${row.group === 'expanded' ? '' : ' ag-hidden'}">▾</span><span class="ag-group-contracted${row.group === 'contracted' ? '' : ' ag-hidden'}">▸</span><span class="ag-group-value">${esc(row.path.join(', '))}</span></span></div>
<div role="gridcell" col-id="status"><svg width="24" height="24" data-tooltip="${row.status}"><use href="/sprite.svg#x"></use></svg></div>
<div role="gridcell" col-id="display_name"><p data-tooltip="${esc(row.name)}"><span class="tooltip">${esc(row.name)}</span></p></div>
<div role="gridcell" col-id="type"><p><span>${row.type}</span></p> <p><span>${row.sub}</span></p></div>
<div role="gridcell" col-id="value"><p data-tooltip="${esc(row.value)}" style="width:90px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis"><span>${esc(row.value)}</span></p></div>
<div role="gridcell" col-id="actions"><span>ⓘ</span></div></div>`;
const gridRows = (from, to) => GRID_ROWS.slice(from, to).map((row, i) => gridRow(row, from + i)).join('');
// The model ag-Grid keeps behind the rows (reached from a row element), with the closed event's parameters.
const MODEL = `<script>
const all = [...${JSON.stringify(GRID_ROWS)}, ...${JSON.stringify(HIDDEN)}], root = { level: -1, childrenAfterGroup: [] }, nodes = new Map();
const api = { forEachNode: cb => [...nodes.values()].forEach(cb), getValue: (col, node) => node.data[col] };
for (const row of all) {
  const parent = row.level ? nodes.get('p' + row.path[0]) : root;
  const node = { id: row.id, key: row.path.at(-1), level: row.level, parent, expanded: row.group !== 'contracted', childrenAfterGroup: [], beans: { gridApi: api },
    data: { display_name: row.name, status: row.status.toLowerCase().replace(' ', '_'), type: row.sub.toLowerCase(), value: row.value } };
  parent.childrenAfterGroup.push(node); nodes.set(row.level ? row.id : 'p' + row.path[0], node);
}
const byId = new Map([...nodes.values()].map(node => [node.id, node]));
for (const element of document.querySelectorAll('[role=row][row-id]')) element['__AG_0.42'] = { renderedRow: { getRowNode: () => byId.get(element.getAttribute('row-id')) } };
</script>`;
const agGridPage = (rows, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><title>Test Lab</title></head><body><h3>Test Results</h3>
<div class="ag-root-wrapper"><div class="ag-root" role="treegrid" aria-rowcount="14"><div class="ag-header"><div class="ag-header-row" role="row">
<div class="ag-header-cell" role="columnheader" col-id="group"></div><div class="ag-header-cell" role="columnheader" col-id="status"><span class="ag-header-cell-text">Status</span></div>
<div class="ag-header-cell" role="columnheader" col-id="display_name"><span class="ag-header-cell-text">Name</span></div><div class="ag-header-cell" role="columnheader" col-id="type"><span class="ag-header-cell-text">Type</span></div>
<div class="ag-header-cell" role="columnheader" col-id="value"><span class="ag-header-cell-text">Value</span></div><div class="ag-header-cell" role="columnheader" col-id="actions"><span class="ag-header-cell-text">Actions</span></div></div></div>
<div class="ag-body-viewport"><div class="ag-center-cols-container" id="rows" style="height:${GRID_ROWS.length * 64}px">${rows}</div></div></div></div>${extra}</body></html>`;
// Any other table (a grid of divs), with the panel's own analytics, catalogue call and Console.
const icon = cls => `<span class="ic ${cls}"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 1h12v12H1z" fill="currentColor"/></svg></span>`;
const DIVS = `<!doctype html><html><head><title>Insider · Test Lab</title><style>body{font:14px Arial,sans-serif;margin:16px}.h{text-transform:uppercase}
.ic{display:inline-block;padding:3px;border-radius:4px}.ok{background:#e8f7ee;color:#16a34a}.prog{background:#fff1e6;color:#ea580c}.sub{display:block;font-size:12px}
.r{display:flex;align-items:center;width:1000px}.c{box-sizing:border-box;padding:8px}.c1{width:110px}.c2{width:300px}.c3{width:190px}.c4{width:120px;overflow:hidden;white-space:nowrap}</style></head><body>
<aside>Name of the test device</aside><h3>Test Results</h3>
<div class="r h"><div class="c c1">Status</div><div class="c c2">Name</div><div class="c c3">Type</div><div class="c c4">Value</div></div>
<div class="r"><div class="c c1">${icon('prog')}</div><div class="c c2">Homepage View</div><div class="c c3">Event<span class="sub">Default</span></div><div class="c c4"></div></div>
<div class="r"><div class="c c1">${icon('ok')}</div><div class="c c2">Page Type</div><div class="c c3">Event Parameter<span class="sub">Custom</span></div><div class="c c4">homepage-with-a-value-longer-than-its-cell</div></div>
<script>
window.dataLayer = [{ event: 'panel_page_view' }];
navigator.sendBeacon('https://www.google-analytics.com/g/collect?v=2&tid=G-PANEL&en=page_view', '');
fetch('/api/dashboard/v1/test-lab/items?page=1&per_page=100').then(r => r.json());
console.log('test lab ready', { tests: 2 });
</script></body></html>`;

test('the reader follows Insider\'s ag-Grid and other tables in a real browser, and keeps the panel out of the website events', { timeout: 60000 }, async t => {
  let executable;
  try { executable = findBrowser('chrome'); } catch { t.skip('Chrome is not installed'); return; }
  const site = http.createServer((req, res) => {
    if (req.url.startsWith('/api/dashboard/v1/test-lab/items')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ...CATALOG, owner: { email: 'qa@example.com' } })); }
    const body = req.url.startsWith('/grid-model') ? agGridPage(gridRows(0, 5), MODEL) : req.url.startsWith('/grid') ? agGridPage(gridRows(0, 5)) : req.url.startsWith('/divs') ? DIVS : '<!doctype html><title>blank</title>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const port = 19500 + Math.floor(Math.random() * 400), profile = mkdtempSync(join(tmpdir(), 'eventqa-testlab-'));
  // Every host goes to the local fixture server: nothing leaves the machine.
  const chrome = spawn(executable, ['--headless=new', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
    `--host-resolver-rules=MAP * 127.0.0.1:${site.address().port}`, '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  const records = [], events = [];
  const collector = new CDPCollector({ port, onEvent: event => events.push(event), onInsiderPanel: record => records.push(record) });
  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 100; i++) { const found = await predicate(); if (found) return found; await delay(100); }
    assert.fail(`timed out waiting for ${label}`);
  };
  const tables = path => records.filter(record => record.kind === 'table' && new URL(record.url).pathname === path);
  const summary = groups => groups.map(group => [group.group, group.name, group.status, group.complete, Boolean(group.collapsed), group.params.map(p => `${p.key}=${p.value}:${p.status}`)]);
  try {
    await waitFor(() => listTargets(port).then(list => list.length > 0, () => false), 'Chrome');
    await collector.start({ id: 'testlab' });
    const page = [...collector.connections.values()][0].connection;
    const { frameTree } = await page.send('Page.getFrameTree');
    const open = url => page.send('Page.navigate', { url, frameId: frameTree.frame.id });

    // ag-Grid draws only the top rows: receipt 4 is read in part, by cell names and keys from the group column.
    await open('http://mobile.useinsider.com/grid');
    const top = await waitFor(() => tables('/grid')[0], 'the grid');
    assert.equal(top.reader, 'ag-grid');
    assert.deepEqual(summary(top.groups), [['4', 'Product Page View', 'in_progress', false, false,
      ['c_slug=uat-vinwonders-ngatest-ticket-binh-giu-nhiet:successful', 'c_unit_price_string=1.149.999:successful', 'up=1149999:successful', 'usp=1038888:successful']]]);
    assert.match(top.html, /ag-group-value/);
    // Scrolled down: receipt 4's row is gone, its last parameters stay with it; 3 is whole, 2 closed, 1 has no parameters.
    await page.send('Runtime.evaluate', { expression: `document.getElementById('rows').innerHTML = ${JSON.stringify(gridRows(4, GRID_ROWS.length))}` });
    const down = await waitFor(() => tables('/grid')[1], 'the scrolled grid');
    assert.deepEqual(summary(down.groups), [
      ['3', 'Listing Page View', 'in_progress', true, false, ['c_platform=AppOTA:successful', 'c_app_version=1.0:failed']],
      ['2', 'Homepage View', 'in_progress', false, true, []],
      ['1', 'Mobile App Open', 'successful', true, false, []],
      ['4', null, undefined, false, false, ['usp=1038888:successful', 'ta=attraction:successful', 'c_site_code=00123:successful']]]);
    // The two readings make one Product Page View with all six parameters.
    const tracker = new TestLabTracker(), list = catalog(), meta = reading => ({ url: reading.url, targetId: reading.target_id, at: reading.at });
    const [opened] = tracker.update(top, meta(top), list);
    const completed = tracker.update(down, meta(down), list).find(op => op.ref === opened.ref);
    assert.equal(completed.op, 'update');
    assert.deepEqual(completed.event.payload, { event: 'Product Page View', default_parameters: { 'Unit Price': '1149999', 'Unit Sales Price': '1038888', Taxonomy: 'attraction' },
      custom_parameters: { Slug: 'uat-vinwonders-ngatest-ticket-binh-giu-nhiet', 'Unit Price String': '1.149.999', 'Site Code': '00123' } });

    // With the grid's row model reachable, every row is read, the closed event's parameters included.
    await open('http://mobile.useinsider.com/grid-model');
    const model = await waitFor(() => tables('/grid-model')[0], 'the grid model');
    assert.equal(model.reader, 'ag-grid-model');
    assert.equal(model.model.verified, true);
    assert.deepEqual(summary(model.groups).map(([group, name, , complete, , params]) => [group, name, complete, params.length]), [['4', 'Product Page View', true, 6], ['3', 'Listing Page View', true, 2], ['2', 'Homepage View', true, 1], ['1', 'Mobile App Open', true, 0]]);
    assert.deepEqual(model.groups.find(group => group.group === '2').params, [{ key: 'c_page_type', name: 'Page Type', type: 'Event Parameter', subtype: 'Custom', value: 'homepage', status: 'successful' }]);

    // Another table: read by its headers, a long value whole, the status by its icon colour.
    await open('http://mobile.useinsider.com/divs');
    const divs = await waitFor(() => tables('/divs')[0], 'the div table');
    assert.equal(divs.reader, 'table');
    assert.deepEqual(summary(divs.groups), [[null, 'Homepage View', 'in_progress', true, false, ['null=homepage-with-a-value-longer-than-its-cell:successful']]]);
    // The panel's own catalogue call and Console are recorded (personal data masked); its analytics are not website events.
    const call = await waitFor(() => records.find(record => record.kind === 'network' && isTestLabCatalog(record.url)), 'the catalogue call');
    assert.match(call.response_body, /product_detail_page_view/);
    assert.doesNotMatch(call.response_body, /qa@example\.com/);
    await waitFor(() => records.find(record => record.kind === 'console' && /test lab ready/.test(record.text)), 'the panel Console');
    assert.deepEqual(events, [], 'the panel analytics are not website events');
    // A website tab is untouched: no reader there.
    await open('http://www.vinpearlota.test/');
    await delay(800);
    const reader = await page.send('Runtime.evaluate', { expression: "Boolean(window[Symbol.for('eventqa.testlab.v1')])", returnByValue: true });
    assert.equal(reader.result.value, false);
  } finally {
    await collector.stop().catch(() => {});
    try { const [target] = await listTargets(port); if (target) { const closer = new CDPConnection(target.webSocketDebuggerUrl); await closer.connect(); await closer.send('Browser.close').catch(() => {}); closer.close(); } }
    catch { chrome.kill(); }
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(3000)]);
    site.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold a file briefly */ }
  }
});

// ---- the define file --------------------------------------------------------------------------------
const PDP = (overrides = {}) => testLabEvent(product([
  param('c_platform', 'Platform', 'Custom', overrides.platform ?? 'AppOTA'), param('cu', 'Currency', 'Default', 'VND'), param('up', 'Unit Price', 'Default', '1149999'),
  param('ta', 'Taxonomy', 'Default', 'attraction'), param('c_slug', 'Slug', 'Custom', 'tour-x'), param('c_site_code', 'Site Code', 'Custom', '00123'),
  ...(overrides.extra ?? [])], overrides.group), { catalog: (() => { const list = catalog(); list.add({ data: [{ kind: 'event', key: 'product_detail_page_view', display_name: 'Product Page View', parameters: [
    ...CATALOG.data[0].parameters, { key: 'c_platform', display_name: 'Platform', type: 'custom', data_type: 'string' }, { key: 'cu', display_name: 'Currency', type: 'default', data_type: 'string' }] }] }); return list; })() });

test('the define template is read as one parameter per row and compared with Test Lab parameter by parameter', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'eventqa-define-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'define.xlsx');
  writeFileSync(file, Buffer.from(await defineTemplate()));
  const define = await importDefine(file);
  assert.equal(define.format, 'table');
  assert.equal(define.sheet, 'Define');
  assert.deepEqual(define.cases.map(testCase => testCase.rules[0].event_name), ['product_detail_page_view', 'homepage_view']);
  const pdpCase = define.cases[0];
  assert.equal(pdpCase.provenance.define, true);
  assert.deepEqual(pdpCase.rules[0].fields['custom_parameters.Platform'], { op: 'eq', value: 'AppOTA' });
  assert.deepEqual(pdpCase.rules[0].fields['default_parameters.Unit Price'], { op: 'type', value: 'number' });
  assert.equal(pdpCase.rules[0].fields['custom_parameters.Promo Code'].optional, true);
  // Everything the define asks is there: fixed values equal, types as Insider declares them; a parameter the define does not list is "outside".
  const ok = defineComparison(PDP(), pdpCase);
  assert.deepEqual(ok.rows.map(row => [row.name, row.result]), [['Platform', 'MATCH'], ['Currency', 'MATCH'], ['Unit Price', 'MATCH'], ['Taxonomy', 'MATCH'], ['Slug', 'MATCH'], ['Site Code', 'EXTRA']]);
  assert.deepEqual(ok.summary, { MATCH: 5, MISMATCH: 0, MISSING: 0, EXTRA: 1, UNREAD: 0 });
  // A fixed value that differs, a type Insider failed, a required parameter missing (the optional one is not).
  const bad = defineComparison(PDP({ platform: 'Web', extra: [param('c_adults', 'Adults', 'Custom', 'two', 'failed')] }), { ...pdpCase, rules: [{ ...pdpCase.rules[0],
    fields: { ...pdpCase.rules[0].fields, 'custom_parameters.Adults': { op: 'type', value: 'number' }, 'custom_parameters.Rooms': { op: 'type', value: 'number' } } }] });
  const by = Object.fromEntries(bad.rows.map(row => [row.name, row]));
  assert.deepEqual([by.Platform.result, by.Platform.note, by.Platform.actual], ['MISMATCH', 'Mong đợi AppOTA', 'Web']);
  assert.equal(by.Adults.result, 'MISMATCH');
  assert.match(by.Adults.note, /Define cần kiểu number, app gửi string; Insider Test Lab báo thất bại \(Insider mong đợi number, app gửi string\)/);
  assert.deepEqual([by.Rooms.result, by.Rooms.actual], ['MISSING', null]);
  assert.equal(by['Promo Code'], undefined, 'an optional parameter missing is not an error');
  // Not read whole yet: what is not seen is "not read", not "missing".
  const partial = defineComparison({ ...PDP(), capture: { incomplete: true } }, { ...pdpCase, rules: [{ ...pdpCase.rules[0], fields: { ...pdpCase.rules[0].fields, 'custom_parameters.Rooms': { op: 'type', value: 'number' } } }] });
  assert.equal(partial.rows.find(row => row.name === 'Rooms').result, 'UNREAD');
});

test('an app specification sheet is read as a define too', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'eventqa-define-spec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'AppOTA_Insider.xlsx'), workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Ghi chú').addRow(['Không phải define']);
  const sheet = workbook.addWorksheet('R1511');
  sheet.addRow(['Luồng', 'Event Name', 'Mô tả', 'Chi tiết event']);
  sheet.addRow(['All', 'product_detail_page_view', 'Chi tiết', JSON.stringify({ event: 'Product Page View', default_parameters: { unit_price: 1, currency: 'VND' }, custom_parameters: { platform: 'AppOTA', slug: 'x' } })]);
  await workbook.xlsx.writeFile(file);
  const define = await importDefine(file);
  assert.deepEqual([define.format, define.sheet, define.cases.length], ['spec', 'R1511', 1]);
  const result = defineComparison(PDP(), define.cases[0]);
  assert.deepEqual(result.rows.filter(row => row.result !== 'EXTRA').map(row => [row.name, row.path, row.result]), [
    ['Platform', 'custom_parameters.platform', 'MATCH'], ['Currency', 'default_parameters.currency', 'MATCH'], ['Unit Price', 'default_parameters.unit_price', 'MATCH'], ['Slug', 'custom_parameters.slug', 'MATCH']]);
  await assert.rejects(importDefine(join(dir, 'x.csv')), /XLSX hoặc JSON/);
});

test('loading a define keeps the website specification and shows the comparison in the event detail', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'eventqa-define-app-'));
  const web = { id: 'WEB-1', name: 'web', source: 'GA4', rules: [{ event_name: 'view_item', layer: 'TRACKING_REQUEST', source: 'GA4', fields: {} }] };
  const app = await createApp({ mode: 'cdp', runsDir: dir, port: 0, initialCases: [web] });
  const base = await app.listen();
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const post = (route, body) => fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-eventqa-token': app.csrf }, body: JSON.stringify(body) });
  const template = await fetch(`${base}/api/define-template`);
  assert.equal(template.status, 200);
  const content = Buffer.from(await template.arrayBuffer()).toString('base64');
  for (let round = 0; round < 2; round++) {
    const uploaded = await (await post('spec-upload', { name: 'define.xlsx', content })).json();
    const loaded = await post('import-define', { path: uploaded.path });
    assert.equal(loaded.status, 200, await loaded.clone().text());
    assert.equal((await loaded.json()).define.events, 2);
  }
  assert.deepEqual(app.manager.cases.map(testCase => testCase.id).sort(), ['DEFINE-all-homepage_view', 'DEFINE-all-product_detail_page_view', 'WEB-1'], 'the website case stays; a second define replaces the first');
  app.manager.start({ environment: 'https://mobile.useinsider.com' });
  const stored = app.manager.emit(PDP());
  const detail = await (await fetch(`${base}/api/event?id=${encodeURIComponent(stored.evidence_id)}`)).json();
  assert.equal(detail.define.case_id, 'DEFINE-all-product_detail_page_view');
  assert.deepEqual(detail.define.summary, { MATCH: 5, MISMATCH: 0, MISSING: 0, EXTRA: 1, UNREAD: 0 });
  assert.deepEqual(detail.event.payload.custom_parameters, { Platform: 'AppOTA', Slug: 'tour-x', 'Site Code': '00123' }, 'the record stays as Test Lab shows it');
});
