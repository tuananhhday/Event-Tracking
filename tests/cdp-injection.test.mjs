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

test('Insider SDK replacing push without chaining loses no push before the next poll', () => {
  const f = fixture('InsiderQueue=[{type:"currency",value:"VND"}];');
  // The production SDK assigns this push; it never calls the push it replaced.
  f.run('InsiderQueue.push=function(e){processedBySdk=(typeof processedBySdk==="number"?processedBySdk:0)+1;e.processed=true;return Array.prototype.push.call(this,e)}');
  assert.equal(f.run('InsiderQueue.push({type:"init"})'), 2);
  assert.equal(f.run('processedBySdk'), 1);
  assert.deepEqual(f.events.map(event => event.item.type), ['currency', 'init']);
  // Recorded after the SDK handled it, as F12 shows the queue, with its position in the array.
  assert.equal(f.events[1].item.processed, true);
  assert.deepEqual(f.events.map(event => event.index), [0, 1]);
  [...f.timers.values()].forEach(fn => fn());
  f.run('InsiderQueue.push({type:"home"})');
  assert.deepEqual(f.events.map(event => event.item.type), ['currency', 'init', 'home']);
  assert.equal(f.run('processedBySdk'), 2);
  f.run("window[Symbol.for('eventqa.collector.v1')].stop()");
  f.run('InsiderQueue.push({type:"after_stop"})');
  assert.equal(f.run('processedBySdk'), 3);
  assert.equal(f.events.length, 3);
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

test('Insider SDK signals sent through dispatch are not recorded, website dispatches are', () => {
  const f = fixture('Insider={eventManager:{dispatch(){ return true; }}};');
  [...f.timers.values()].forEach(fn => fn());
  f.run('Insider.eventManager.dispatch("userLocationSet",{});Insider.eventManager.dispatch("web-sdk:log",{});Insider.eventManager.dispatch("other_page_view",{taxonomy:"News"})');
  assert.deepEqual(f.events.map(event => event.item.name), ['other_page_view']);
});

test('frozen queues and read-only window properties do not break page execution', () => {
  const f = fixture('Object.defineProperty(window,"dataLayer",{value:Object.freeze([]),writable:false,configurable:false});');
  assert.equal(f.events.length, 0);
  assert.equal(f.run('Array.isArray(dataLayer)'), true);
});

test('SDK dispatch notifications cannot exhaust later business event capture or change dispatch semantics', () => {
  const f = fixture('dispatchCalls=0; dispatchReceiver=null; Insider={eventManager:{dispatch:function(name,data){dispatchCalls++;dispatchReceiver=this;if(name==="broken")throw new Error("original dispatch error");return data;}}};originalDispatch=Insider.eventManager.dispatch;');
  [...f.timers.values()].forEach(fn => fn());
  f.run('for(let i=0;i<350;i++)Insider.eventManager.dispatch("sdk:ready",{index:i})');
  assert.equal(f.run('Insider.eventManager.dispatch("other_page_view",{taxonomy:"News"}).taxonomy'), 'News');
  // SDK lifecycle signals (names with ':') are not tracking events.
  assert.equal(f.events.length, 1);
  assert.equal(f.events.at(-1).queue, 'InsiderDispatch');
  assert.equal(f.events.at(-1).item.name, 'other_page_view');
  assert.deepEqual(f.events.at(-1).item.data, { taxonomy: 'News' });
  assert.equal(f.run('dispatchReceiver===Insider.eventManager'), true);
  assert.equal(f.run('dispatchCalls'), 351);
  assert.throws(() => f.run('Insider.eventManager.dispatch("broken",{})'), /original dispatch error/);
  assert.equal(f.run('dispatchCalls'), 352);
  f.run("window[Symbol.for('eventqa.collector.v1')].stop()");
  assert.equal(f.run('Insider.eventManager.dispatch===originalDispatch'), true);
});

test('browser launcher rejects unsafe inputs without starting any browser', async () => {
  await assert.rejects(launchBrowser({ port: 2 }), /port/);
  await assert.rejects(launchBrowser({ url: 'javascript:alert(1)' }), /HTTP/);
  assert.throws(() => findBrowser('unknown'), /chrome or edge/);
});
