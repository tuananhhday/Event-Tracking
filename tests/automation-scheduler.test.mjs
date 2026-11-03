import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DailyScheduler } from '../src/automation/scheduler.mjs';
import { WorkflowStore } from '../src/automation/store.mjs';

const schedule = (id, overrides = {}) => ({ id, schedule: { enabled: true, time: '07:00', timezone: 'Asia/Ho_Chi_Minh', days: [2], ...overrides } });
const at = value => new Date(value);

test('daily schedules use Vietnam time, selected weekdays and explicit enablement', async () => {
  const calls = [];
  const scheduler = new DailyScheduler({ getWorkflows: () => [schedule('due'), schedule('off', { enabled: false }), schedule('truthy', { enabled: 1 }), schedule('other-day', { days: [3] }), schedule('later', { time: '09:00' })], enqueue: async (ids, meta) => { calls.push({ ids, meta }); } });
  assert.deepEqual(await scheduler.tick(at('2026-11-02T23:59:00Z')), []);
  assert.deepEqual(await scheduler.tick(at('2026-11-03T00:00:00Z')), ['due']);
  assert.deepEqual(calls[0], { ids: ['due'], meta: { trigger: 'schedule', scheduled_date: '2026-11-03', timezone: 'Asia/Ho_Chi_Minh', browser: 'chrome' } });
  assert.deepEqual(await scheduler.tick(at('2026-11-03T00:30:00Z')), []);
  assert.deepEqual(await scheduler.tick(at('2026-11-03T02:00:00Z')), ['later']);
});

test('busy or failed enqueue is retried and concurrent ticks cannot duplicate a job', async () => {
  let attempts = 0, release;
  const scheduler = new DailyScheduler({ getWorkflows: async () => [schedule('W')], enqueue: async () => {
    attempts++;
    if (attempts === 1) return { accepted: false };
    if (attempts === 2) throw new Error('Temporarily unavailable');
    await new Promise(resolve => { release = resolve; });
    return { accepted: true };
  } });
  const date = at('2026-11-03T00:00:00Z');
  assert.deepEqual(await scheduler.tick(date), []);
  await assert.rejects(scheduler.tick(date), /Temporarily/);
  const first = scheduler.tick(date), second = scheduler.tick(date);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 3);
  release();
  assert.deepEqual(await first, ['W']);
  assert.deepEqual(await second, ['W']);
  assert.deepEqual(await scheduler.tick(date), []);
});

test('persisted dedupe prevents a second daily run after scheduler restart', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-schedule-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let store = await new WorkflowStore(dir).load(), count = 0;
  const config = { ...schedule('W'), name: 'Scheduled', url: 'https://example.test', steps: [{ name: 'Observe', actions: [] }] };
  await store.save(config);
  const create = () => new DailyScheduler({ getWorkflows: () => store.list(), enqueue: async () => { count++; return { accepted: true }; }, getLastScheduledDate: id => store.getLastScheduledDate(id), recordScheduledDate: (id, date) => store.recordScheduledDate(id, date) });
  assert.deepEqual(await create().tick(at('2026-11-03T01:00:00Z')), ['W']);
  store = await new WorkflowStore(dir).load();
  assert.deepEqual(await create().tick(at('2026-11-03T02:00:00Z')), []);
  assert.deepEqual(await create().tick(at('2026-11-10T01:00:00Z')), ['W']);
  assert.equal(count, 2);
});

test('midnight schedule uses the Vietnam calendar date across UTC date boundary', async () => {
  const scheduler = new DailyScheduler({ getWorkflows: () => [schedule('W', { time: '00:00' })], enqueue: async () => ({ accepted: true }) });
  assert.deepEqual(await scheduler.tick(at('2026-11-02T16:59:59Z')), []);
  assert.deepEqual(await scheduler.tick(at('2026-11-02T17:00:00Z')), ['W']);
});

test('start checks immediately, is idempotent and stop releases its timer', async () => {
  let calls = 0;
  const scheduler = new DailyScheduler({ getWorkflows: () => [schedule('W')], now: () => at('2026-11-03T00:00:00Z'), intervalMs: 60000, enqueue: async () => { calls++; } });
  scheduler.start();
  const timer = scheduler.timer;
  scheduler.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduler.timer, timer);
  assert.equal(calls, 1);
  scheduler.stop();
  assert.equal(scheduler.timer, null);
});

test('mixed browsers enqueue separate stable groups and retry only declined groups', async () => {
  const calls = [], persisted = [];
  let busy = false;
  const scheduler = new DailyScheduler({
    getWorkflows: () => [{ ...schedule('C1'), browser: 'chrome' }, { ...schedule('E1'), browser: 'edge' }, { ...schedule('C2'), browser: 'chrome' }],
    enqueue: async (ids, meta) => {
      calls.push({ ids, browser: meta.browser });
      if (busy) return { accepted: false };
      busy = true; return { accepted: true };
    },
    recordScheduledDate: async (id, date) => { persisted.push([id, date]); },
  });
  const date = at('2026-11-03T00:00:00Z');
  assert.deepEqual(await scheduler.tick(date), ['C1', 'C2']);
  assert.deepEqual(calls, [{ ids: ['C1', 'C2'], browser: 'chrome' }, { ids: ['E1'], browser: 'edge' }]);
  assert.deepEqual(persisted.map(([id]) => id), ['C1', 'C2']);
  busy = false;
  assert.deepEqual(await scheduler.tick(date), ['E1']);
  assert.deepEqual(persisted.map(([id]) => id), ['C1', 'C2', 'E1']);
  assert.deepEqual(await scheduler.tick(date), []);
});

test('stop cancels a tick still waiting for workflows before it can enqueue', async () => {
  let release, queued = false;
  const scheduler = new DailyScheduler({ getWorkflows: () => new Promise(resolve => { release = resolve; }), enqueue: async () => { queued = true; } });
  const pending = scheduler.tick(at('2026-11-03T00:00:00Z'));
  scheduler.stop();
  release([schedule('W')]);
  assert.deepEqual(await pending, []);
  assert.equal(queued, false);
});

test('more than 50 scheduled workflows run in bounded batches without losing declined jobs', async () => {
  const workflows = Array.from({ length: 105 }, (_, index) => schedule(`W-${index}`));
  const calls = [], persisted = [];
  let busy = false;
  const scheduler = new DailyScheduler({
    getWorkflows: () => workflows,
    enqueue: async ids => {
      assert.ok(ids.length > 0 && ids.length <= 50);
      calls.push([...ids]);
      if (busy) return { accepted: false };
      busy = true;
      return { accepted: true };
    },
    recordScheduledDate: async id => { persisted.push(id); },
  });
  const date = at('2026-11-03T00:00:00Z'), ids = workflows.map(workflow => workflow.id);
  assert.deepEqual(await scheduler.tick(date), ids.slice(0, 50));
  assert.deepEqual(calls.map(batch => batch.length), [50, 50, 5]);
  assert.deepEqual(persisted, ids.slice(0, 50));
  busy = false;
  assert.deepEqual(await scheduler.tick(date), ids.slice(50, 100));
  busy = false;
  assert.deepEqual(await scheduler.tick(date), ids.slice(100));
  assert.deepEqual(persisted, ids);
  assert.equal(new Set(persisted).size, 105);
  assert.deepEqual(await scheduler.tick(date), []);
});
