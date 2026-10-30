import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { importSpec, specSheets } from '../src/spec/import.mjs';
import { specCoverage } from '../src/core/catalog.mjs';
import { validateCase } from '../src/core/rules.mjs';
import { decodeRequest } from '../src/core/decoder.mjs';
import { createApp } from '../src/server.mjs';
import { createHub } from '../src/hub.mjs';

async function workbook(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-contract-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'AppOTA_Insider.xlsx');
  const w = new ExcelJS.Workbook();
  w.addWorksheet('Overview').addRow(['Guide']);
  const s = w.addWorksheet('R1511');
  const payload = { event: 'Listing Page View', default_parameters: { taxonomy: ['golf'] }, custom_parameters: { platform: 'AppOTA', app_version: '1.0' } };
  s.addRow(['Luồng', 'Event Name', 'Mô tả', 'Chi tiết event']);
  s.addRow(['Golf', 'listing_page_view', 'Trigger documented in workbook', JSON.stringify(payload, null, 2)]);
  s.addRow(['Golf', 'remove from cart', 'Keep spelling from specification', JSON.stringify({ event: 'Item Removed from Cart', default_parameters: { product_id: 'sample' }, custom_parameters: { quantity: 1 } })]);
  await w.xlsx.writeFile(file);
  return { dir, file, payload };
}
const event = payload => decodeRequest({ url: 'https://unification.useinsider.com/api/event/', body: JSON.stringify(payload), contentType: 'application/json' })[0];

test('Chi tiết event preserves the AppOTA payload display name and exact Event Name independently', async t => {
  const { file, payload } = await workbook(t);
  assert.deepEqual((await specSheets(file)).map(s => s.name), ['Overview', 'R1511']);
  const { cases } = await importSpec(file, { sheet: 'R1511' });
  assert.equal(cases.length, 2);
  const c = cases[0];
  assert.equal(c.description, 'Trigger documented in workbook');
  assert.equal(c.rules[0].event_name, 'listing_page_view');
  assert.equal(cases[1].rules[0].event_name, 'remove from cart');
  assert.deepEqual(c.sample, payload);
  assert.equal(c.rules[0].fields.event.value, 'Listing Page View');
  assert.equal(c.rules[0].layer, 'TRACKING_REQUEST');
  const actual = { ...event(payload), evidence_id: 'EV-1' };
  assert.equal(actual.event_name, 'Listing Page View', 'raw evidence name must not be rewritten');
  let coverage = specCoverage(cases, [actual]);
  assert.equal(coverage.rows[0].status, 'REVIEW', 'a draft contract is not an accepted match');
  for (const candidate of cases) { candidate.needs_review = false; for (const rule of candidate.rules) rule.needs_review = false; }
  coverage = specCoverage(cases, [actual]);
  assert.equal(coverage.rows[0].status, 'MATCH');
  assert.equal(coverage.rows[1].status, 'NOT_SEEN');
  const broken = structuredClone(payload);
  delete broken.custom_parameters.platform;
  coverage = specCoverage(cases, [{ ...event(broken), evidence_id: 'EV-2' }]);
  assert.equal(coverage.rows[0].status, 'MISMATCH');
  assert.equal(coverage.rows[0].issues[0].path, 'custom_parameters.platform');
  const otherFlow = structuredClone(payload); otherFlow.default_parameters.taxonomy = ['hotel'];
  assert.equal(specCoverage(cases, [{ ...event(otherFlow), evidence_id: 'EV-FLOW', page: { url: 'https://test.example/vi/golf/checkout' } }]).rows[0].status, 'MISMATCH', 'a different product family on the Golf page must not pass by array type alone');
  const unrelated = { ...actual, evidence_id: 'EV-3', event_name: 'Unrelated' };
  assert.equal(specCoverage(cases, [unrelated]).unmatched[0].event_name, 'Unrelated');
  const queue = { ...actual, evidence_id: 'EV-4', layer: 'JS_QUEUE', event_name: 'listing_page_view', payload: { type: 'category' } };
  assert.equal(specCoverage(cases, [queue]).rows[0].status, 'NOT_SEEN', 'queue shape must not masquerade as AppOTA request');
  const reviewed = structuredClone(c); reviewed.needs_review = false; reviewed.rules[0].needs_review = false;
  const step = { id: 'STEP', status: 'COMPLETED', started_at: '2026-01-01', completed_at: '2027-01-01', observed_layers: ['TRACKING_REQUEST'] };
  assert.equal(validateCase(reviewed, [{ ...actual, step_id: 'STEP', test_case_id: c.id }], step).verdict, 'PASS', 'step validation accepts the explicit workbook display alias too');
});

test('an imported event with no payload details cannot claim a field match', async t => {
  const { file } = await workbook(t);
  const w = new ExcelJS.Workbook();
  const s = w.addWorksheet('R1511');
  s.addRow(['Event Name']); s.addRow(['unknown']);
  await w.xlsx.writeFile(file);
  const { cases } = await importSpec(file, { sheet: 'R1511' });
  const result = specCoverage(cases, [{ layer: 'JS_QUEUE', source: 'INSIDER', event_name: 'unknown', payload: {}, evidence_id: 'EV' }]);
  assert.equal(result.rows[0].status, 'REVIEW');
  assert.equal(result.rows[0].issues[0].code, 'NO_EXPECTED_FIELDS');
});

test('browser upload lists sheets, imports R1511 and exposes missing fields and provenance through the API', async t => {
  const { file, payload, dir } = await workbook(t);
  const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-upload-runs-'));
  const app = await createApp({ port: 0, runsDir, initialCases: [] });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(runsDir, { recursive: true, force: true }); });
  const post = (route, data, token = app.csrf) => fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EventQA-Token': token }, body: JSON.stringify(data) });
  const content = (await fs.readFile(file)).toString('base64');
  assert.equal((await post('spec-upload', { name: 'file.xlsx', content }, 'bad')).status, 403);
  const upload = await (await post('spec-upload', { name: 'AppOTA_Insider.xlsx', content })).json();
  t.after(() => fs.rm(upload.path, { force: true }));
  assert.deepEqual(upload.sheets.map(s => s.name), ['Overview', 'R1511']);
  const imported = await (await post('import', { path: upload.path, sheet: 'R1511' })).json();
  assert.equal(imported.cases.length, 2);
  assert.equal(imported.cases[0].source, 'INSIDER', 'uploaded filename retains source hint');
  app.manager.start({ environment: 'CONTRACT_TEST' });
  const e = app.manager.emit(event({ ...payload, custom_parameters: {} }));
  const detail = await (await fetch(`${base}/api/event?id=${e.evidence_id}`)).json();
  assert.equal(detail.spec.event_name, 'listing_page_view');
  assert.equal(detail.spec.provenance.sheet, 'R1511');
  assert.equal(detail.spec.provenance.row, 2);
  assert.equal(detail.spec.sample.event, 'Listing Page View');
  assert.equal(detail.spec.verdict, 'REVIEW', 'draft requirements retain field differences without becoming acceptance failures');
  assert.ok(detail.spec.issues.some(i => i.path === 'custom_parameters.platform'));
});

test('launcher opens the simple guided workflow and retains three diagnostic apps under advanced', async t => {
  const { dir } = await workbook(t);
  const hub = await createHub({ port: 0, modePorts: [0, 0, 0], runsDir: dir });
  const base = await hub.listen();
  t.after(() => hub.close());
  const response = await fetch(base);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.redirected, true);
  assert.ok(response.url.endsWith('/guided'));
  assert.ok(html.includes('id="requirement-file"'));
  const advanced = await (await fetch(base + '/advanced')).text();
  assert.ok(!advanced.includes('__MODE_'));
  assert.equal(advanced.match(/const token='([a-f0-9]{48})'/)?.[1], hub.csrf);
  const { modes } = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(modes.map(m => m.mode), ['cdp', 'cdp-ai', 'proxy']);
  for (const mode of modes) {
    const page = await (await fetch(mode.url)).text();
    assert.ok(page.includes(`data-mode="${mode.mode}"`));
    assert.ok(page.includes('id="spec-file"') && page.includes('id="spec-detail-dialog"'));
  }
  assert.equal((await fetch(base + '/api/shutdown', { method: 'POST' })).status, 403);
  await hub.close();
  for (const { url } of modes) await assert.rejects(fetch(url));
});
