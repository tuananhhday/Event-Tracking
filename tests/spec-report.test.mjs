import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { importSpec, parseSample, validateTestCase } from '../src/spec/import.mjs';
import { exportReports } from '../src/report/export.mjs';

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-core-'));
test('JSON5 wrapped sample parses as data and dotted GTM key is preserved', () => {
  assert.deepEqual(parseSample(`dataLayer.push({event:'search_submit',service:'hotel',gtm.uniqueEventId:17});`), { event: 'search_submit', service: 'hotel', 'gtm.uniqueEventId': 17 });
  assert.throws(() => parseSample('dataLayer.push({event:(()=>{throw Error("run")})()})'));
  assert.throws(() => parseSample('process.exit()'));
});
test('schema rejects unknown ops, invalid regex, min/max mismatch and invalid refs', () => {
  const valid = { id: 'TC', name: 'Search', rules: [{ event_name: 'search', layer: 'JS_QUEUE', fields: { term: { op: 'ref', value: 'context.search.term' } } }] };
  assert.equal(validateTestCase(valid), valid);
  for (const field of [{ op: 'execute' }, { op: 'regex', value: '[' }, { op: 'ref', value: 'window.term' }, { op: 'eq' }]) assert.throws(() => validateTestCase({ ...valid, rules: [{ ...valid.rules[0], fields: { term: field } }] }));
  assert.throws(() => validateTestCase({ ...valid, rules: [{ ...valid.rules[0], count: { min: 2, max: 1 } }] }));
});
test('XLSX parser finds shifted Vietnamese headers, keeps provenance and dynamic refs', async t => {
  const directory = await temp();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'spec.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Tổng hợp Event tracking');
  sheet.addRow(['Latest update: 20/10/2026']);
  sheet.addRow(['STT', 'Nền tảng', 'Luồng', 'Event Name', 'Event Description', 'DataLayer Sample', 'Note']);
  sheet.addRow([1, 'GA4', 'Merchandise', 'search_submit', 'Search', `dataLayer.push({event:'search_submit',service:'merchandise',search_term:'keychain',search_source:'listing_searchbox'})`, '']);
  await workbook.xlsx.writeFile(file);
  const imported = await importSpec(file);
  assert.equal(imported.cases.length, 1);
  const actual = imported.cases[0];
  assert.deepEqual(actual.provenance, { file, sheet: 'Tổng hợp Event tracking', row: 3 });
  assert.deepEqual(actual.rules[0].fields.search_term, { op: 'ref', value: 'context.search.term' });
  assert.deepEqual(actual.rules[0].fields.service, { op: 'eq', value: 'merchandise' });
  assert.equal(actual.needs_review, true);
  assert.ok(imported.warnings.length);
});
test('explicit JSON duplicates are rejected', async t => {
  const directory = await temp();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'spec.json');
  await fs.writeFile(file, JSON.stringify({ cases: [{ id: 'TC', name: 'A', rules: [] }, { id: 'TC', name: 'B', rules: [] }] }));
  await assert.rejects(importSpec(file), /Duplicate/);
});
test('report has the spec coverage and six styled sheets, escaped HTML and safe spreadsheet strings', async t => {
  const directory = await temp();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const caseData = { id: '=HYPERLINK("bad")', name: '<script>alert(1)</script>', source: 'GA4', rules: [] };
  const paths = await exportReports({ session: { id: 'S', mode: 'cdp' }, cases: [caseData], results: [{ test_case_id: caseData.id, step_id: 'STEP', verdict: 'FAIL', results: [{ event_name: '<script>x</script>', layer: 'JS_QUEUE', source: 'GA4', verdict: 'FAIL', checks: [{ path: 'id', expected: 'exists', actual: null, verdict: 'FAIL', code: 'MISSING_FIELD', evidence_id: 'EV-1' }], issues: [{ path: 'id', expected: 'exists', actual: null, code: 'MISSING_FIELD', evidence_id: 'EV-1' }] }] }] }, directory);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(paths.xlsx);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['Run Summary', 'Spec Coverage', 'Firing Checks', 'Test Cases', 'Expected Events', 'Actual Events', 'Comparison', 'Bug Reports']);
  assert.equal(workbook.getWorksheet('Test Cases').getCell('A2').value, `'${caseData.id}`);
  const html = await fs.readFile(paths.html, 'utf8');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.match(await fs.readFile(paths.bugs, 'utf8'), /Evidence: EV-1/);
});
test('report boundary masks sensitive rules and diffs without changing QA IDs or schema', async t => {
  const directory = await temp();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const token = 'rawOpaqueSensitiveString';
  const snapshot = {
    session: { id: 'S-QA-001', session_id: 'S-QA-001', metadata: { api_key: token } },
    cases: [{ id: 'TC', name: 'Sensitive', rules: [{ event_name: 'search', layer: 'JS_QUEUE', fields: { 'user.email': { op: 'eq', value: token }, 'auth.access_token': { op: 'eq', value: token } } }], sample: { email: token } }],
    events: [{ evidence_id: 'EV', session_id: 'S-QA-001', payload: { session_id: token, access_token: token }, page: { url: `https://example.test/?access_token=${token}` } }],
    steps: [{ id: 'STEP', context: { email: token } }],
    results: [{ test_case_id: 'TC', step_id: 'STEP', verdict: 'FAIL', results: [{ event_name: 'search', layer: 'JS_QUEUE', verdict: 'FAIL', checks: [{ path: 'user.email', op: 'eq', expected: token, actual: token, verdict: 'FAIL', evidence_id: 'EV' }], issues: [{ path: 'auth.access_token', expected: token, actual: token, evidence_id: 'EV', code: 'VALUE_MISMATCH', verdict: 'FAIL' }] }] }],
  };
  const paths = await exportReports(snapshot, directory);
  const result = JSON.parse(await fs.readFile(paths.json, 'utf8'));
  assert.equal(result.session.session_id, 'S-QA-001');
  assert.equal(result.events[0].session_id, 'S-QA-001');
  assert.equal(result.events[0].payload.session_id, '[REDACTED]');
  assert.deepEqual(result.cases[0].rules[0].fields['user.email'], { op: 'eq', value: '[REDACTED]' });
  assert.equal(result.results[0].results[0].checks[0].path, 'user.email');
  assert.equal(result.results[0].results[0].checks[0].op, 'eq');
  assert.equal(result.results[0].results[0].checks[0].actual, '[REDACTED]');
  assert.equal(snapshot.cases[0].rules[0].fields['user.email'].value, token);
  for (const file of [paths.json, paths.html, paths.bugs]) assert.ok(!(await fs.readFile(file, 'utf8')).includes(token));
});
test('long evidence remains complete in JSON and fits Excel cell/row limits with a visible full-record note', async t => {
  const directory = await temp();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const payload = { large: 'x'.repeat(50000) };
  const paths = await exportReports({ session: { id: 'S' }, events: [{ evidence_id: 'EV-LONG', payload }] }, directory);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(paths.xlsx);
  const sheet = workbook.getWorksheet('Actual Events');
  const actual = sheet.getCell('I2').value;
  assert.match(actual, /^\[TRUNCATED: full record in comparison\.json\]/);
  assert.ok(actual.length <= 32000);
  assert.ok(sheet.getRow(2).height > 45 && sheet.getRow(2).height <= 409);
  const full = JSON.parse(await fs.readFile(paths.json, 'utf8'));
  assert.equal(full.events[0].payload.large, payload.large);
});
