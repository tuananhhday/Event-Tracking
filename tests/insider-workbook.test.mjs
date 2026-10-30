import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { importSpec } from '../src/spec/import.mjs';
import { matchEvent, specCoverage } from '../src/core/catalog.mjs';
import { validateCase } from '../src/core/rules.mjs';
import { createApp } from '../src/server.mjs';

test('Insider source worksheets preserve full structures, labels, variants and provenance, excluding execution sheets', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-workbook-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const book = new ExcelJS.Workbook();
  const json = book.addWorksheet('Release A');
  json.addRow(['Luồng', 'Event Name', 'Mô tả', 'Chi tiết event']);
  const payload = { event: 'Product Page View', default_parameters: { product_id: 'P1', taxonomy: ['golf'], quantity: 1 }, custom_parameters: { platform: 'AppOTA', subtotal: 100 } };
  json.addRow(['Golf', 'product_detail_page_view', 'Open product', JSON.stringify(payload)]);
  const sdk = book.addWorksheet('Release B');
  sdk.addRow(['STT', 'Luồng', 'Event Name', 'Trigger point trên App', 'Sample Payload (App)', 'Cách fire (Insider Mobile SDK)', 'Diễn giải param']);
  sdk.addRow([1, 'Hotel', 'search_hotel', 'Submit search', 'let event = Insider.tagEvent("search_hotel"); event?.addParameterWithInt()("quantity", 2); event?.build();', 'tagEvent', 'Integer rooms']);
  sdk.addRow([2, 'Hotel', 'remove_from_cart', 'Remove', 'Param: Y hệt add_to_cart']);
  for (const name of ['Adjust Event', 'Test_app']) {
    const sheet = book.addWorksheet(name); sheet.addRow(['Event Name', 'Chi tiết event']); sheet.addRow(['wrong_event', '{event:"wrong_event"}']);
  }
  const file = path.join(dir, 'Insider.xlsx'); await book.xlsx.writeFile(file);
  const imported = await importSpec(file);
  assert.equal(imported.cases.length, 3);
  const [detail, search, reference] = imported.cases;
  assert.deepEqual(detail.sample, payload);
  assert.equal(detail.rules[0].event_name, 'product_detail_page_view');
  assert.equal(detail.rules[0].fields.event.value, 'Product Page View', 'UI label is not overwritten with canonical name');
  assert.equal(detail.capture_platform, 'APP_SDK');
  assert.equal(detail.sample_import.status, 'complete');
  assert.equal(detail.provenance.row, 2);
  assert.equal(search.trigger, 'Submit search');
  assert.equal(search.parameter_notes, 'Integer rooms');
  assert.equal(search.sample.custom_parameters.quantity, 2);
  assert.equal(reference.sample_import.status, 'unparsed');
  assert.equal(reference.sample, null);
  assert.equal(imported.warnings.filter(w => /skipped/.test(w)).length, 2);
  await fs.writeFile(path.join(dir, 'catalogue.json'), JSON.stringify(imported));
  assert.equal((await importSpec(path.join(dir, 'catalogue.json'))).cases.length, 3);
});

const makeCase = (id, fields = { event: { op: 'eq', value: 'search_hotel' } }) => ({ id, name: id, source: 'INSIDER', flow: id, rules: [{ event_name: 'search_hotel', source: 'INSIDER', layer: 'JS_QUEUE', fields }] });
const event = { evidence_id: 'EV-1', source: 'INSIDER', layer: 'JS_QUEUE', event_name: 'search_hotel', captured_at: new Date().toISOString(), payload: { event: 'search_hotel' } };

test('tied specification matches do not arbitrarily assign a flow', () => {
  const cases = [makeCase('A'), makeCase('B')];
  const match = matchEvent(cases, event);
  assert.equal(match.case_id, null); assert.equal(match.verdict, 'REVIEW');
  assert.deepEqual(match.candidate_case_ids, ['A', 'B']);
  const coverage = specCoverage(cases, [event]);
  assert.ok(coverage.rows.every(r => r.seen === 0));
  assert.equal(coverage.unmatched[0].ambiguous, true);
});

test('empty/partial contracts and native SDK examples cannot silently pass browser validation', () => {
  assert.equal(matchEvent([makeCase('empty', {})], event).verdict, 'REVIEW');
  const native = makeCase('native'); native.rules[0].capture_platform = 'APP_SDK';
  assert.equal(matchEvent([native], event).verdict, 'REVIEW');
  const step = { id: 'STEP-1', status: 'COMPLETED' };
  assert.equal(validateCase(native, [], step).results[0].issues[0].code, 'SPEC_PLATFORM_MISMATCH');
  const partial = makeCase('partial'); partial.rules[0].sample_status = 'partial';
  assert.equal(validateCase(partial, [], step).verdict, 'REVIEW');
  const observation = { ...event, event_kind: 'observation' };
  assert.equal(matchEvent([makeCase('any')], observation), null);
});

test('catalogue export includes unseen full expected objects and redacts sensitive examples', async t => {
  const definition = makeCase('export');
  definition.sample = { event: 'search_hotel', custom_parameters: { quantity: 2, email: 'private@example.test' } };
  const app = await createApp({ port: 0, initialCases: [definition] });
  t.after(() => app.close());
  const base = await app.listen();
  const response = await fetch(`${base}/api/spec/export`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /attachment/);
  const out = await response.json();
  assert.equal(out.kind, 'specification');
  assert.equal(out.cases[0].sample.custom_parameters.quantity, 2);
  assert.equal(out.cases[0].sample.custom_parameters.email, '[REDACTED]');
});
