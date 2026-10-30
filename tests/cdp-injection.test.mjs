import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { findBrowser, launchBrowser } from '../src/browser/launcher.mjs';

const source = readFileSync(new URL('../src/collectors/inject.js', import.meta.url), 'utf8');
function fixture(setup = '') {
  const events = [], timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({ location: { href: 'https://example.test/hotel' }, document: { title: 'Hotel' },
    setInterval(fn) { timers.set(++nextTimer, fn); return nextTimer; }, clearInterval(id) { timers.delete(id); },
    __eventqa_emit(payload) { events.push(JSON.parse(payload)); } });
  vm.runInContext('window = globalThis', context);
  vm.runInContext(setup, context);
  vm.runInContext(source, context);
  return { context, events, timers, run(code) { return vm.runInContext(code, context); } };
}

test('queue hook preserves push return and payload and snapshots initial backlog once', () => {
  const f = fixture('dataLayer = [{event:"initial"}]; payload = {event:"search_submit",nested:{term:"snack"}}; originalPayload = JSON.stringify(payload);');
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].historical, true);
  assert.equal(f.run('dataLayer.push(payload)'), 2);
  assert.equal(f.run('JSON.stringify(payload) === originalPayload'), true);
  assert.equal(f.events[1].historical, false);
  assert.equal(f.events[1].item.nested.term, 'snack');
  f.run(source);
  f.run('dataLayer.push({event:"once"})');
  assert.equal(f.events.filter(event => event.item.event === 'once').length, 1);
});

test('late queues, replacement arrays and vendor replacement of push remain observable', () => {
  const f = fixture();
  f.run('dataLayer = []; dataLayer.push({event:"late"}); InsiderQueue=[]; InsiderQueue.push({event:"product_detail_page_view"})');
  f.run('dataLayer = [{event:"replacement"}]; dataLayer.push({event:"new"})');
  assert.deepEqual(f.events.map(event => event.item.event), ['late', 'product_detail_page_view', 'replacement', 'new']);
  assert.ok(f.events.every(event => !event.historical));
  f.run('dataLayer.push = function(...items) { Array.prototype.push.apply(this, items); return 777; }');
  [...f.timers.values()].forEach(fn => fn());
  assert.equal(f.run('dataLayer.push({event:"vendor"})'), 777);
  assert.equal(f.events.at(-1).item.event, 'vendor');
});

test('stop restores queue properties and allows a clean collector restart', () => {
  const f = fixture('dataLayer=[]; originalPush=dataLayer.push;');
  f.run("window[Symbol.for('eventqa.collector.v1')].stop()");
  assert.equal(f.run('dataLayer.push === originalPush'), true);
  assert.equal(f.run('Object.hasOwn(dataLayer,"push")'), false);
  assert.equal(f.timers.size, 0);
  f.run('dataLayer.push({event:"stopped"})');
  assert.equal(f.events.length, 0);
  f.run(source);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].historical, true);
  f.run('dataLayer.push({event:"resumed"})');
  assert.equal(f.events.length, 2);
});

test('vendor wrappers that call a previously hooked push do not duplicate evidence', () => {
  const f = fixture('dataLayer=[];');
  f.run('previous=dataLayer.push; dataLayer.push=function(...items){return previous.apply(this,items)}');
  [...f.timers.values()].forEach(fn => fn());
  f.run('dataLayer.push({event:"once"})');
  assert.equal(f.events.filter(event => event.item.event === 'once').length, 1);
  f.run('previous2=dataLayer.push; dataLayer.push=function(...items){return previous2.apply(this,items)}');
  [...f.timers.values()].forEach(fn => fn());
  assert.equal(f.run('dataLayer.push({event:"twice"})'), 2);
  assert.equal(f.events.filter(event => event.item.event === 'twice').length, 1);
});

test('gtag Arguments and circular objects are safely snapshotted', () => {
  const f = fixture('dataLayer=[]');
  f.run('(function(){dataLayer.push(arguments)})("event","purchase",{amount:4}); a={event:"circular",num:3n};a.self=a;dataLayer.push(a)');
  assert.deepEqual(f.events[0].item, ['event', 'purchase', { amount: 4 }]);
  assert.equal(f.events[1].item.self, '[Circular]');
  assert.equal(f.events[1].item.num, '3');
  assert.equal(f.run('a.self === a'), true);
  f.run('shared={amount:4};dataLayer.push({event:"shared",first:shared,second:shared})');
  assert.deepEqual(f.events[2].item.first, { amount: 4 });
  assert.deepEqual(f.events[2].item.second, { amount: 4 });
});

test('frozen queues and read-only window properties do not break page execution', () => {
  const f = fixture('Object.defineProperty(window,"dataLayer",{value:Object.freeze([]),writable:false,configurable:false});');
  assert.equal(f.events.length, 0);
  assert.equal(f.run('Array.isArray(dataLayer)'), true);
});

test('capture does not execute website getters or toJSON inside a checkout queue push', () => {
  const f = fixture('dataLayer=[]; getterReads=0; jsonCalls=0; vendorCalls=0; dataLayer.push=function(item){vendorCalls++;return 777};');
  assert.equal(f.run('dataLayer.push({event:"begin_checkout",get total(){getterReads++;throw Error("site getter")},toJSON(){jsonCalls++;return {event:"wrong"}}})'), 777);
  assert.equal(f.run('vendorCalls'), 1);
  assert.equal(f.run('getterReads'), 0);
  assert.equal(f.run('jsonCalls'), 0, 'capturing must not run a website serialization hook before its own handler');
  assert.equal(f.events[0].item.event, 'begin_checkout');
  assert.equal(f.events[0].capture.incomplete, true);
});

test('large queue items yield a marked partial snapshot while the original push still completes', () => {
  const f = fixture('dataLayer=[]; large={event:"purchase"}; for(let i=0;i<10000;i++)large["p"+i]="x".repeat(500);');
  assert.equal(f.run('dataLayer.push(large)'), 1);
  assert.equal(f.run('dataLayer[0]===large'), true);
  assert.equal(f.events[0].item.event, 'purchase');
  assert.equal(f.events[0].capture.incomplete, true);
  assert.ok(JSON.stringify(f.events[0]).length < 300000);
});

test('browser launcher rejects unsafe inputs without starting any browser', async () => {
  await assert.rejects(launchBrowser({ port: 2 }), /port/);
  await assert.rejects(launchBrowser({ url: 'javascript:alert(1)' }), /HTTP/);
  await assert.rejects(launchBrowser({ proxyServer: 'remote.example:8080' }), /localhost/);
  assert.throws(() => findBrowser('unknown'), /chrome or edge/);
});
