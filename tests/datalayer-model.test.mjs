import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { DataLayerModel } from '../src/core/datalayer-model.mjs';
import { queueEvents } from '../src/collectors/cdp.mjs';

const push = (item, queue_sequence, extra = {}) => ({ item, queue_sequence, queue_instance_id: 'queue-1', queue_history_complete: true, ...extra });

test('observed model preserves inherited fields without adding them to the raw event', () => {
  const model = new DataLayerModel({ historyComplete: true });
  model.apply(push({ ecommerce: { currency: 'VND', items: [{ item_id: 'G1', price: 100 }, { item_id: 'G2' }] } }, 1));
  const raw = push({ event: 'begin_checkout', ecommerce: { items: [{ quantity: 2 }] } }, 2);
  const state = model.apply(raw);
  const [event] = queueEvents(raw);
  assert.deepEqual(event.payload, { event: 'begin_checkout', ecommerce: { items: [{ quantity: 2 }] } });
  assert.equal(event.payload.ecommerce.currency, undefined, 'a prior push must not fill missing actual params');
  assert.deepEqual(state.values.ecommerce, { currency: 'VND', items: [{ item_id: 'G1', price: 100, quantity: 2 }, { item_id: 'G2' }] });
  assert.ok(state.inherited_paths.includes('ecommerce.currency'));
  assert.ok(state.current_message_paths.includes('ecommerce.items.0.quantity'));
  assert.equal(state.origins['ecommerce.items.0.item_id'].queue_sequence, 1);
  assert.equal(state.origins['ecommerce.items.0.quantity'].queue_sequence, 2);
  assert.equal(state.complete, true);
  assert.equal(state.is_gtm_private_state, false);
  state.values.ecommerce.currency = 'changed';
  assert.equal(model.apply(push({ event: 'next' }, 3)).values.ecommerce.currency, 'VND', 'a consumer cannot mutate retained state');
});

test('null, type changes, dotted keys and clear flags remove stale values and origins', () => {
  const model = new DataLayerModel({ historyComplete: true });
  model.apply(push({ ecommerce: { currency: 'VND', items: [{ item_id: 'old', price: 100 }] }, user: { old: true, details: { old: 1 } } }, 1));
  let state = model.apply(push({ 'user.name': 'QC', ecommerce: null }, 2));
  assert.deepEqual(state.values.user, { old: true, details: { old: 1 }, name: 'QC' });
  assert.equal(state.values.ecommerce, null);
  assert.ok(!Object.keys(state.origins).some(path => path.startsWith('ecommerce.')));
  state = model.apply(push({ ecommerce: { items: [{ item_id: 'new' }] }, user: { _clear: true, name: 'new', details: { new: 2 } } }, 3));
  assert.deepEqual(state.values.ecommerce, { items: [{ item_id: 'new' }] });
  assert.deepEqual(state.values.user, { old: true, name: 'new', details: { new: 2 } });
  state = model.apply(push({ _clear: true, ecommerce: { currency: 'USD' } }, 4));
  assert.deepEqual(state.values.ecommerce, { currency: 'USD' });
  assert.equal(state.values.user.name, 'new', 'clear only replaces the keys present in that message');
});

test('unobserved history, commands, gaps and snapshot omissions remain explicit caveats', () => {
  const model = new DataLayerModel();
  let state = model.apply(push({ event: 'start' }, 2, { queue_history_complete: false }));
  assert.equal(state.complete, false);
  assert.ok(state.warnings.includes('history_before_observation_unknown'));
  assert.ok(state.warnings.includes('observed_sequence_gap'));
  state = model.apply(push(['event', 'purchase', { value: 100 }], 3));
  assert.equal(state.values.event, 'start', 'a gtag command is not a declarative GTM state update');
  assert.ok(state.warnings.includes('command_or_gtag_message_not_reconstructed'));
  state = model.apply(push(undefined, 4, { message_type: 'function' }));
  assert.ok(state.warnings.includes('unsupported_message'));
  state = model.apply(push({ event: 'new' }, 5, { capture: { incomplete: true }, model_limitations: ['accessor_not_read'] }));
  assert.ok(state.warnings.includes('partial_message_capture'));
  assert.ok(state.warnings.includes('accessor_not_read'));
  assert.equal(state.complete, false, 'later plain events cannot erase unknown state history');
});

test('model is bounded, refuses prototype pollution and never calls getters', () => {
  const model = new DataLayerModel({ historyComplete: true, maxNodes: 30, maxArrayItems: 3, maxCharacters: 200 });
  let getterReads = 0;
  const item = {};
  Object.defineProperty(item, '__proto__', { value: { polluted: true }, enumerable: true });
  Object.defineProperty(item, 'secret', { get() { getterReads++; throw Error('must not execute'); }, enumerable: true });
  Object.assign(item, { event: 'safe', items: Array.from({ length: 8 }, (_, i) => ({ id: i })), text: 'x'.repeat(300) });
  const state = model.apply(push(item, 1));
  assert.equal(getterReads, 0);
  assert.equal({}.polluted, undefined);
  assert.equal(state.complete, false);
  assert.ok(state.warnings.includes('accessor_not_read'));
  assert.ok(state.warnings.includes('unsupported_property'));
  assert.ok(state.warnings.includes('model_limit'));
  assert.ok(state.values.items.length <= 3);
  assert.ok(JSON.stringify(state.values).length < 400);
});

test('injection sequences raw messages and distinguishes replacement arrays without replaying vendor wrappers', () => {
  const events = [], timers = [];
  const context = vm.createContext({ location: { href: 'https://example.test/golf' }, document: { title: 'Golf' },
    setInterval(fn) { timers.push(fn); return 1; }, clearInterval() {}, __eventqa_emit(value) { events.push(JSON.parse(value)); } });
  vm.runInContext('window=globalThis;dataLayer=[{ecommerce:{currency:"VND"}}]', context);
  vm.runInContext(readFileSync(new URL('../src/collectors/inject.js', import.meta.url), 'utf8'), context);
  vm.runInContext('dataLayer.push({event:"checkout"});prev=dataLayer.push;dataLayer.push=function(...args){return prev.apply(this,args)};', context);
  timers.forEach(fn => fn());
  vm.runInContext('dataLayer.push(function(){throw Error("must not execute")});dataLayer=[{event:"fresh"}]', context);
  assert.equal(events.length, 4);
  assert.deepEqual(events.slice(0, 3).map(event => event.queue_sequence), [1, 2, 3]);
  assert.equal(events[0].queue_instance_id, events[2].queue_instance_id);
  assert.notEqual(events[2].queue_instance_id, events[3].queue_instance_id);
  assert.equal(events[3].queue_sequence, 1);
  assert.equal(events[2].message_type, 'function');
  assert.equal(events[0].queue_history_complete, false);
  const model = new DataLayerModel();
  model.apply(events[0]);
  const state = model.apply(events[1]);
  assert.equal(state.values.ecommerce.currency, 'VND');
  assert.deepEqual(queueEvents(events[1])[0].payload, { event: 'checkout' });
  assert.equal(state.complete, false, 'retained queue history is not proof of complete GTM history');
});
