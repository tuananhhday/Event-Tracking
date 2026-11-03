import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WORKFLOW_SCHEMA, validateWorkflow, resolveWorkflow } from '../src/automation/schema.mjs';
import { WorkflowStore } from '../src/automation/store.mjs';

const workflow = () => ({ name: 'Tìm khách sạn', url: 'https://example.test/hotel/', steps: [{ name: 'Tìm kiếm', actions: [{ type: 'fill', locator: { by: 'label', value: 'Điểm đến' }, value: '{{destination}}' }] }], variables: { destination: 'Hà Nội' } });
const directory = async t => {
  const result = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-automation-'));
  t.after(() => fs.rm(result, { recursive: true, force: true }));
  return result;
};

test('workflow normalization adds safe defaults and does not mutate its input', () => {
  const input = workflow(), before = structuredClone(input), normalized = validateWorkflow(input);
  assert.equal(WORKFLOW_SCHEMA.properties.schema_version.const, '1.0');
  assert.equal(normalized.schema_version, '1.0');
  assert.equal(normalized.browser, 'chrome');
  assert.deepEqual(normalized.schedule, { enabled: false, time: '07:00', timezone: 'Asia/Ho_Chi_Minh', days: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(normalized.steps[0].id, 'step-1');
  assert.deepEqual(normalized.steps[0].context, {});
  assert.deepEqual(input, before);
  normalized.variables.destination = 'Đà Nẵng';
  assert.equal(input.variables.destination, 'Hà Nội');
});

test('only supported actions, locators, URLs, schedules and bounded timeouts are accepted', () => {
  const rejects = [
    { ...workflow(), url: 'javascript:alert(1)' },
    { ...workflow(), steps: [] },
    { ...workflow(), browser: 'firefox' },
    { ...workflow(), schema_version: null },
    { ...workflow(), script: 'process.exit()' },
    { ...workflow(), steps: [{ name: 'JS', actions: [{ type: 'evaluate', code: 'alert(1)' }] }] },
    { ...workflow(), steps: [{ name: 'Role thiếu', actions: [{ type: 'click', locator: { by: 'role', value: 'Tìm' } }] }] },
    { ...workflow(), steps: [{ name: 'XPath', actions: [{ type: 'click', locator: { by: 'xpath', value: '//button' } }] }] },
    { ...workflow(), steps: [{ name: 'Timeout', timeout_ms: 120001, actions: [] }] },
    { ...workflow(), steps: [{ name: 'Timeout', actions: [{ type: 'goto', url: 'https://example.test', timeout_ms: 60001 }] }] },
    { ...workflow(), schedule: { enabled: 'true' } },
    { ...workflow(), schedule: { time: '24:00' } },
    { ...workflow(), schedule: { timezone: 'UTC' } },
    { ...workflow(), schedule: { days: [1, 1] } },
    { ...workflow(), schedule: { days: [7] } },
  ];
  for (const input of rejects) assert.throws(() => validateWorkflow(input), Error, JSON.stringify(input));
  assert.throws(() => validateWorkflow({ ...workflow(), variables: { run: () => 'not JSON' } }), /JSON/);
  assert.throws(() => validateWorkflow({ ...workflow(), steps: [{ id: 'same', name: 'A', actions: [] }, { id: 'same', name: 'B', actions: [] }] }), /trùng/);
  assert.equal(validateWorkflow({ ...workflow(), steps: [{ name: 'Click', actions: [{ type: 'click', locator: { by: 'role', role: 'button', value: 'Tìm', exact: true, nth: 0 }, timeout_ms: 60000 }] }] }).steps[0].actions[0].locator.role, 'button');
  const wrongFill = workflow(); wrongFill.steps[0].actions[0].timeout_ms = 60001;
  assert.throws(() => validateWorkflow(wrongFill), /timeout_ms.*60000/);
});

test('templates resolve nested values without losing JSON types and calculate dates in Vietnam', () => {
  const input = workflow();
  input.variables = { destination: 'Hà Nội', guests: 2, room: { code: 'DLX', breakfast: true }, products: ['A', 'B'], empty: null, report_day: '{{date:-1}}' };
  input.steps[0].context = { guests: '{{guests}}', room: '{{room}}', products: '{{products}}', empty: '{{empty}}', room_code: '{{room.code}}', report_day: '{{report_day}}', future: '{{date:+3}}', today: '{{date}}' };
  input.steps[0].actions[0].value = 'Điểm đến: {{destination}} / {{room.code}}';
  const result = resolveWorkflow(input, { now: new Date('2026-11-02T17:30:00Z'), variables: { destination: 'Huế' } });
  assert.deepEqual(result.steps[0].context, { guests: 2, room: { code: 'DLX', breakfast: true }, products: ['A', 'B'], empty: null, room_code: 'DLX', report_day: '2026-11-02', future: '2026-11-06', today: '2026-11-03' });
  assert.equal(result.steps[0].actions[0].value, 'Điểm đến: Huế / DLX');
  assert.equal(input.variables.destination, 'Hà Nội');
});

test('missing variables, circular templates and non-http resolved URLs fail before execution', () => {
  assert.throws(() => resolveWorkflow(workflow(), { variables: { destination: '{{missing}}' } }), /Chưa có giá trị.*missing/);
  assert.throws(() => resolveWorkflow(workflow(), { variables: { destination: '{{other}}', other: '{{destination}}' } }), /tham chiếu vòng/);
  assert.throws(() => resolveWorkflow(workflow(), { variables: { destination: '{{constructor.name}}' } }), /Chưa có giá trị/);
  assert.throws(() => resolveWorkflow({ ...workflow(), url: '{{site}}', variables: { destination: 'Huế', site: 'file:///private' } }), /http hoặc https/);
  assert.throws(() => resolveWorkflow(workflow(), { now: new Date('invalid') }), /Thời điểm/);
});

test('workflow store persists configuration, history and scheduler dedupe with isolated clones', async t => {
  const dir = await directory(t), store = await new WorkflowStore(dir).load();
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.history(), []);
  const saved = await store.save(workflow());
  assert.match(saved.id, /^WF-/);
  assert.equal(saved.schedule.enabled, false);
  saved.name = 'Changed clone';
  assert.equal(store.get(saved.id).name, 'Tìm khách sạn');
  const list = store.list(); list[0].variables.destination = 'Changed clone';
  assert.equal(store.get(saved.id).variables.destination, 'Hà Nội');
  await Promise.all([store.recordRun({ id: 'RUN-1', workflow_id: saved.id, status: 'PASS' }), store.recordScheduledDate(saved.id, '2026-11-03'), store.recordRun({ id: 'RUN-2', workflow_id: saved.id, status: 'FAIL' })]);
  const reloaded = await new WorkflowStore(dir).load();
  assert.equal(reloaded.getLastScheduledDate(saved.id), '2026-11-03');
  assert.deepEqual(reloaded.history(1).map(run => run.id), ['RUN-2']);
  assert.deepEqual(reloaded.history().map(run => run.id), ['RUN-2', 'RUN-1']);
  reloaded.history()[0].status = 'Changed';
  assert.equal(reloaded.history()[0].status, 'FAIL');
  assert.equal(await reloaded.delete(saved.id), true);
  assert.equal(await reloaded.delete(saved.id), false);
  assert.equal((await new WorkflowStore(dir).load()).get(saved.id), undefined);
});

test('store serializes concurrent saves and does not overwrite malformed configuration', async t => {
  const dir = await directory(t), store = await new WorkflowStore(dir).load();
  await Promise.all(Array.from({ length: 5 }, (_, index) => store.save({ ...workflow(), id: `W-${index}` })));
  assert.equal(store.list().length, 5);
  assert.equal((await new WorkflowStore(dir).load()).list().length, 5);
  const file = path.join(dir, 'workflows.json');
  await fs.writeFile(file, '{broken JSON');
  await assert.rejects(new WorkflowStore(dir).load(), /Không đọc được/);
  assert.equal(await fs.readFile(file, 'utf8'), '{broken JSON');
});

test('scheduler dedupe validates real calendar dates and stable workflow IDs before saving', async t => {
  const dir = await directory(t), store = await new WorkflowStore(dir).load();
  for (const date of ['2026-02-30', '2026-13-01', '2026-11-03T00:00:00Z', 20261103]) await assert.rejects(store.recordScheduledDate('W', date), /Ngày chạy lịch/);
  for (const id of ['', '../W', undefined]) await assert.rejects(store.recordScheduledDate(id, '2026-11-03'), /Mã luồng/);
  await store.recordScheduledDate('W', '2028-02-29');
  assert.equal((await new WorkflowStore(dir).load()).getLastScheduledDate('W'), '2028-02-29');
  await fs.writeFile(path.join(dir, 'history.json'), JSON.stringify({ runs: [], scheduled_dates: { W: '2026-02-30' } }));
  await assert.rejects(new WorkflowStore(dir).load(), /chống chạy trùng/);
});
