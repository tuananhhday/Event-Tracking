import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '../src/automation/runner.mjs';

const workflow = steps => ({ id: 'WF-DEMO', name: 'Local demo', url: 'http://127.0.0.1/demo', steps });
const step = (id, actions, extra = {}) => ({ id, name: id, actions, ...extra });

test('runner starts evidence scope before navigation and executes steps in order', async () => {
  const sequence = [], progress = [];
  const flow = workflow([
    step('search', [{ type: 'fill', locator: { by: 'label', value: 'Điểm đến' }, value: 'Đà Nẵng' }, { type: 'click', locator: { by: 'role', role: 'button', value: 'Tìm' } }]),
    step('verify', [{ type: 'assert_url', url: 'http://127.0.0.1/results' }]),
  ]);
  const result = await runWorkflow(flow, {
    driver: { async execute(action, { signal }) { assert.ok(signal instanceof AbortSignal); assert.ok(action.timeout_ms > 0); sequence.push(action.type); } },
    onStepStart: async (current, context) => { assert.equal(context.workflow, flow); sequence.push(`start:${current.id}`); },
    onStepComplete: async (current, outcome) => { assert.equal(outcome.status, 'COMPLETED'); sequence.push(`complete:${current.id}`); },
    onProgress: event => progress.push(event.type),
  });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(sequence, ['start:search', 'goto', 'fill', 'click', 'complete:search', 'start:verify', 'assert_url', 'complete:verify']);
  assert.equal(result.steps[0].actions[0].initial, true);
  assert.ok(result.started_at && result.completed_at);
  assert.deepEqual([progress[0], progress.at(-1)], ['workflow-start', 'workflow-complete']);
});

test('an explicit first navigation to the entry URL is not duplicated', async () => {
  const actions = [];
  const result = await runWorkflow(workflow([step('entry', [{ type: 'goto', url: 'http://127.0.0.1/demo' }])]), {
    driver: { async execute(action) { actions.push(action.type); } },
  });
  assert.equal(result.status, 'COMPLETED'); assert.deepEqual(actions, ['goto']);
});

test('the first action failure stops the workflow and preserves its step error', async () => {
  const actions = [], errors = [], completed = [];
  const result = await runWorkflow(workflow([step('first', [{ type: 'click' }, { type: 'fill' }]), step('later', [{ type: 'click' }])]), {
    driver: { async execute(action) { actions.push(action.type); if (action.type === 'click') throw new Error('Control missing'); } },
    onStepComplete: current => completed.push(current.id),
    onStepError: (current, error, context) => errors.push({ id: current.id, message: error.message, status: context.result.status }),
  });
  assert.equal(result.status, 'FAILED'); assert.match(result.error, /Control missing/);
  assert.equal(result.steps.length, 1); assert.equal(result.steps[0].actions.at(-1).status, 'FAILED');
  assert.deepEqual(actions, ['goto', 'click']); assert.deepEqual(completed, []);
  assert.deepEqual(errors, [{ id: 'first', message: 'Control missing', status: 'FAILED' }]);
});

test('expected events are awaited before completing the evidence scope', async () => {
  const order = [], expected = [{ event_name: 'search_submit', source: 'GA4', layer: 'TRACKING_REQUEST' }];
  const result = await runWorkflow(workflow([step('search', [{ type: 'click' }], { expected_events: expected })]), {
    driver: { async execute(action) { order.push(action.type); } },
    waitForEvents: async (events, context) => { assert.equal(events, expected); assert.equal(context.step.id, 'search'); assert.ok(context.timeoutMs > 0); order.push('events'); },
    onStepComplete: () => order.push('complete'),
  });
  assert.equal(result.status, 'COMPLETED'); assert.deepEqual(order, ['goto', 'click', 'events', 'complete']);
  const missing = await runWorkflow(workflow([step('search', [], { expected_events: expected })]), { driver: { async execute() {} } });
  assert.equal(missing.status, 'FAILED'); assert.match(missing.error, /event mong muốn/);
});

test('external cancellation interrupts a pending action and never runs later actions', async () => {
  const controller = new AbortController(), actions = [];
  let actionAborted = false;
  const result = await runWorkflow(workflow([step('cancel', [{ type: 'click' }, { type: 'fill' }])]), {
    signal: controller.signal,
    driver: { async execute(action, { signal }) {
      actions.push(action.type);
      if (action.type === 'click') return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { actionAborted = true; reject(signal.reason); }, { once: true });
        controller.abort(new Error('User stopped'));
      });
    } },
  });
  assert.equal(result.status, 'CANCELLED'); assert.equal(actionAborted, true);
  assert.deepEqual(actions, ['goto', 'click']); assert.equal(result.steps[0].status, 'CANCELLED');
});

test('step and action timeouts fail and propagate cancellation to the driver', async () => {
  for (const actionTimeout of [false, true]) {
    let stopped = false;
    const result = await runWorkflow(workflow([step('timeout', [{ type: 'click', ...(actionTimeout ? { timeout_ms: 15 } : {}) }], { timeout_ms: actionTimeout ? 500 : 15 })]), {
      driver: { async execute(action, { signal }) {
        if (action.type === 'goto') return;
        return new Promise((resolve, reject) => { signal.addEventListener('abort', () => { stopped = true; reject(signal.reason); }, { once: true }); });
      } },
    });
    assert.equal(result.status, 'FAILED'); assert.equal(stopped, true); assert.match(result.error, /thời gian chờ/);
    assert.equal(result.steps[0].actions.at(-1).error_code, 'AUTOMATION_ACTION_TIMEOUT');
  }
});

test('a cancelled workflow starts no actions and progress failures do not fail valid actions', async () => {
  const controller = new AbortController(); controller.abort(); let called = false;
  const cancelled = await runWorkflow(workflow([step('noop', [])]), { signal: controller.signal, driver: { async execute() { called = true; } } });
  assert.equal(cancelled.status, 'CANCELLED'); assert.equal(called, false); assert.deepEqual(cancelled.steps, []);
  const completed = await runWorkflow(workflow([step('noop', [])]), { driver: { async execute() {} }, onProgress: () => { throw new Error('UI disconnected'); } });
  assert.equal(completed.status, 'COMPLETED');
});

test('locator ambiguity identifies the failed action in Vietnamese without logging filled values', async () => {
  const result = await runWorkflow(workflow([step('search', [{ type: 'fill', locator: { by: 'label', value: 'Điểm đến' }, value: 'PRIVATE_VALUE' }])]), {
    driver: { async execute(action) { if (action.type === 'fill') throw new Error('strict mode violation: locator resolved to 2 elements'); } },
  });
  assert.equal(result.status, 'FAILED'); assert.match(result.error, /Điểm đến.*nhiều thành phần/);
  assert.equal(result.steps[0].actions.at(-1).error_code, 'AUTOMATION_AMBIGUOUS_CONTROL');
  assert.equal(JSON.stringify(result).includes('PRIVATE_VALUE'), false);
});
