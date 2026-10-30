import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { exportGuidedReports } from '../src/report/guided.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-guided-report-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const cases = [{ id: 'ADD', name: 'Add', source: 'INSIDER', flow: 'Golf', sample: { type: 'custom_event', value: [{ event_name: 'add_to_cart' }] },
  rules: [{ event_name: 'add_to_cart', layer: 'TRACKING_REQUEST', count: { min: 1, max: 1 }, fields: { 'event_params.c_quantity': { op: 'ref', value: 'context.quantity' } } }] }];

test('guided report shows names, param differences and raw evidence while unexecuted steps stay pending', async t => {
  const output = await fixture(t);
  const input = { session: { id: 'S-GUIDED', target_url: 'https://test.example/vi/golf', guided: {
    plan: { title: 'Chọn Golf', flow: 'Golf', steps: [
      { id: 'ADD-STEP', title: 'Chọn số người', instruction: 'Chọn 2 người chơi', case_ids: ['ADD'] },
      { id: 'PAY-STEP', title: 'Thanh toán', instruction: 'Bấm Thanh toán', expected: [{ case_id: 'PAY', event_name: 'golf_checkout', source: 'INSIDER' }] },
    ] },
    results: [{ step_id: 'ADD-STEP', title: 'Chọn số người', status: 'mismatch', acceptance_status: 'review', context: { quantity: 2 },
      comparisons: [{ case_id: 'ADD', event_name: 'add_to_cart', source: 'INSIDER', layer: 'TRACKING_REQUEST', status: 'mismatch', needs_review: true,
        expected_count: { min: 1, max: 1 }, actual_count: 1, expected_payload_sample: cases[0].sample,
        expected_rules: cases[0].rules[0].fields, actual_events: [{ evidence_id: 'EV-1', event_name: 'item_added_to_cart', source: 'INSIDER', payload: { event_params: { c_quantity: 1 } } }],
        parameters: [
          { path: 'event_params.c_quantity', op: 'ref', expected: 2, actual: 1, status: 'mismatch', code: 'DYNAMIC_VALUE_MISMATCH', evidence_id: 'EV-1' },
          { path: 'event_params.c_currency', expected: 'VND', actual: null, status: 'missing', code: 'MISSING_FIELD', evidence_id: 'EV-1' },
          { path: 'event_params.c_slug', actual: 'sample', status: 'extra', code: 'ADDITIONAL_PARAMETER', severity: 'info', evidence_id: 'EV-1' },
        ], issues: [] }],
      observations: [{ evidence_id: 'QUEUE-1', event_name: 'add_to_cart', source: 'INSIDER', layer: 'JS_QUEUE' }],
    }],
  } }, cases, events: [{ evidence_id: 'EV-1', event_name: 'item_added_to_cart', source: 'INSIDER', layer: 'TRACKING_REQUEST', payload: { event_params: { c_quantity: 1 } } }] };
  const paths = await exportGuidedReports(input, output);
  assert.ok(Object.values(paths).every(file => path.isAbsolute(file)));
  const data = JSON.parse(await fs.readFile(paths.json, 'utf8'));
  assert.equal(data.steps[1].status, 'not_executed');
  assert.equal(data.steps[1].acceptance_status, 'NOT_EXECUTED');
  assert.equal(data.comparisons[1].actual_count, null, 'unexecuted does not become missing or zero sends');
  assert.equal(data.comparisons[0].event_name, 'add_to_cart');
  assert.deepEqual(data.comparisons[0].actual_event_names, ['item_added_to_cart']);
  assert.equal(data.comparisons[0].status, 'mismatch');
  assert.equal(data.comparisons[0].acceptance_status, 'REVIEW');
  assert.equal(data.comparisons.length, 2, 'supplementary queue evidence does not become an extra event');
  assert.equal(data.parameters.find(parameter => parameter.code === 'ADDITIONAL_PARAMETER').status, 'extra');
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(paths.xlsx);
  assert.ok(workbook.getWorksheet('Đối chiếu event'));
  assert.ok(workbook.getWorksheet('Đối chiếu params'));
  assert.equal(workbook.getWorksheet('Đối chiếu event').getCell('F2').value, 1, 'fixed expected count is readable without JSON');
  assert.equal(workbook.getWorksheet('Đối chiếu event').getCell('I2').value, 'Cần xác nhận');
  const rows = workbook.getWorksheet('Tổng quan').getSheetValues();
  assert.equal(rows.find(row => row?.[1] === 'Bước nghiệm thu FAIL')[2], 0);
  const text = await fs.readFile(paths.bugs, 'utf8');
  assert.ok(text.includes('Phát hiện cần xác nhận') && text.includes('event_params.c_quantity'));
  assert.ok(!text.includes('Lỗi đã xác nhận'));
});

test('guided exports redact personal payloads, preserve type syntax, escape HTML and neutralize spreadsheet formulas', async t => {
  const output = await fixture(t);
  const key = 'sk-or-v1-fake-secret-credential-123456';
  const title = '=HYPERLINK("https://unrelated.example")';
  const payload = { email: 'person@example.com', c_user_id: 'private-user-reference', c_device_id: 'private-device-reference', api_key: key, url: 'https://example.test/pay?secureHash=private-payment-hash' };
  const input = { session: { id: 'S-PRIVATE', guided: { plan: { title, flow: 'Golf', steps: [{ id: 'ONE', title, instruction: '<script>alert(1)</script>' }] },
    results: [{ step_id: 'ONE', status: 'match', acceptance_status: 'match', context: { email: 'person@example.com' },
      expected: [{ event_name: 'test', source: 'INSIDER', status: 'match', acceptance_status: 'match', actual_count: 1,
        expected_rules: { email: { op: 'type', value: 'string' } }, expected_payload: payload,
        actual_events: [{ evidence_id: 'EV-SAFE', event_name: 'test', payload }],
        parameters: [{ path: 'email', op: 'type', expected: 'string', actual: 'person@example.com', status: 'match', evidence_id: 'EV-SAFE' }], issues: [] }],
    }],
  } }, events: [{ evidence_id: 'EV-SAFE', event_name: 'test', source: 'INSIDER', payload }], cases: [] };
  const paths = await exportGuidedReports(input, output);
  const json = await fs.readFile(paths.json, 'utf8');
  const html = await fs.readFile(paths.html, 'utf8');
  const markdown = await fs.readFile(paths.bugs, 'utf8');
  for (const text of [json, html, markdown]) {
    assert.ok(!text.includes('person@example.com') && !text.includes(key) && !text.includes('private-payment-hash'));
    assert.ok(!text.includes('private-user-reference') && !text.includes('private-device-reference'));
  }
  const data = JSON.parse(json);
  assert.equal(data.parameters[0].expected, 'string', 'type syntax is not private data');
  assert.equal(data.parameters[0].actual, '[REDACTED]');
  assert.equal(data.comparisons[0].expected_rules.email.value, 'string');
  assert.equal(data.comparisons[0].acceptance_status, 'PASS');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(paths.xlsx);
  const titleCell = workbook.getWorksheet('Các bước').getCell('A2');
  assert.equal(titleCell.type, ExcelJS.ValueType.String);
  assert.equal(titleCell.value, "'" + title);
  const cells = [];
  workbook.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => cells.push(String(cell.value)))));
  assert.ok(!cells.join('\n').includes('person@example.com') && !cells.join('\n').includes(key));
});

test('extra parameters remain informational and extra events are listed once without claiming confirmed defects', async t => {
  const output = await fixture(t);
  const session = { guided: { plan: { steps: [{ id: 'S', title: 'Tìm kiếm' }] }, results: [{ step_id: 'S', status: 'extra', acceptance_status: 'review',
    expected: [{ event_name: 'search_submit', source: 'GA4', layer: 'JS_QUEUE', status: 'match', actual_count: 1, needs_review: true,
      actual_events: [{ event_name: 'search_submit', evidence_id: 'E1', payload: { event: 'search_submit', extra: true } }],
      parameters: [{ path: 'extra', actual: true, expected: null, status: 'extra', code: 'ADDITIONAL_PARAMETER' }] }],
    extra_events: [{ event_name: 'unexpected', source: 'GA4', layer: 'JS_QUEUE', evidence_id: 'E2', payload: { event: 'unexpected' }, code: 'UNEXPECTED_EVENT_FOR_STEP' }],
  }] } };
  const files = await exportGuidedReports({ session }, output);
  const data = JSON.parse(await fs.readFile(files.json, 'utf8'));
  assert.equal(data.comparisons.length, 2);
  assert.equal(data.comparisons.filter(row => row.kind === 'extra_event').length, 1);
  assert.equal(data.comparisons[1].acceptance_status, 'REVIEW');
  const markdown = await fs.readFile(files.bugs, 'utf8');
  assert.ok(markdown.includes('Event ngoài danh sách mong muốn'));
  assert.ok(!markdown.includes('Lỗi đã xác nhận'));
  assert.ok(!markdown.includes('ADDITIONAL_PARAMETER'), 'an allowed extra parameter is not a defect note');
});
