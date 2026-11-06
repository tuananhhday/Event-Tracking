(() => {
  'use strict';
  const marker = Symbol.for('eventqa.collector.v1');
  if (window[marker]) return;
  const state = { arrays: new WeakMap(), ownedArrays: new Set(), properties: [], timer: null, enabled: true };
  Object.defineProperty(window, marker, { value: state, configurable: true });

  // Snapshot data properties only. JSON.stringify on the website's object would
  // execute getters/toJSON inside its own click handler and can stall checkout.
  function snapshotItem(item) {
    const capture = { incomplete: false, reasons: [] };
    let nodes = 0, chars = 0;
    const ancestors = new WeakSet();
    const omit = reason => { capture.incomplete = true; if (!capture.reasons.includes(reason)) capture.reasons.push(reason); return '[Not captured]'; };
    const copy = (value, depth = 0) => {
      if (++nodes > 4096 || depth > 12) return omit('snapshot_limit');
      if (typeof value === 'bigint') return String(value);
      if (typeof value === 'string') {
        if (value.length > 50000 || chars + value.length > 200000) return omit('text_limit');
        chars += value.length; return value;
      }
      if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) return undefined;
      if (value === null || typeof value !== 'object') return value;
      if (ancestors.has(value)) return '[Circular]';
      ancestors.add(value);
      try {
        if (Object.getPrototypeOf(value) === Date.prototype) return Date.prototype.toISOString.call(value);
        const length = Object.getOwnPropertyDescriptor(value, 'length');
        const isList = Array.isArray(value) || (!!Object.getOwnPropertyDescriptor(value, 'callee') && typeof length?.value === 'number');
        const result = isList ? [] : Object.create(null);
        if (isList) Object.defineProperty(result, 'toJSON', { value: undefined });
        for (const key of Object.keys(value)) {
          if (nodes >= 4096 || chars >= 200000) { omit('snapshot_limit'); break; }
          chars += key.length;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) { result[key] = omit('accessor_omitted'); continue; }
          const child = copy(descriptor.value, depth + 1);
          if (child !== undefined) Object.defineProperty(result, key, { value: child, enumerable: true, writable: true, configurable: true });
        }
        return result;
      } catch (_) { return omit('unreadable_object'); }
      finally { ancestors.delete(value); }
    };
    return { item: copy(item), capture };
  }

  function emit(queue, item, historical, prepared, at = Date.now(), index) {
    if (!state.enabled) return;
    try {
      const safe = prepared || snapshotItem(item);
      const snapshot = JSON.stringify({ queue, ...safe, historical, href: location.href, title: document.title, ts: at, ...(Number.isInteger(index) && index >= 0 ? { index } : {}) });
      if (typeof window.__eventqa_emit === 'function') window.__eventqa_emit(snapshot);
    } catch (_) { /* Evidence capture must never break the site. */ }
  }

  // `push` becomes a getter/setter. Vendors replace it after the page creates the queue:
  // Insider's SDK assigns a push that calls Array.prototype.push directly, and GTM assigns one
  // that calls the previous push. The setter keeps their function and the getter returns it
  // wrapped, so no push is missed between their assignment and the next poll.
  function hook(queue, array, historical) {
    if (!Array.isArray(array)) return;
    let record = state.arrays.get(array);
    const descriptor = Object.getOwnPropertyDescriptor(array, 'push');
    if (record && descriptor?.get === record.get) return;
    const head = array.push;
    if (typeof head !== 'function') return;
    const first = !record;
    record = record || { depth: 0, wrappers: new WeakMap(), descriptor };
    const wrap = target => {
      let wrapper = record.wrappers.get(target);
      if (!wrapper) {
        wrapper = function (...items) {
          // A vendor push calls the push it read earlier, i.e. another wrapper. Every wrapper
          // shares this guard, so only the outermost call records the items.
          const outermost = record.depth === 0, at = Date.now();
          record.depth++;
          try { return Reflect.apply(target, this, items); }
          finally {
            record.depth--;
            // Recorded once GTM / the Insider SDK have handled the push, as F12 then shows it
            // (gtm.uniqueEventId, processed: true), with its position in the queue.
            if (outermost) for (const item of items) emit(queue, item, false, undefined, at, Array.isArray(this) ? Array.prototype.lastIndexOf.call(this, item) : undefined);
          }
        };
        record.wrappers.set(target, wrapper);
      }
      return wrapper;
    };
    const get = () => typeof record.head === 'function' ? wrap(record.head) : record.head;
    const set = value => { record.head = value; };
    try {
      Object.defineProperty(array, 'push', { get, set, enumerable: false, configurable: true });
      Object.assign(record, { head, get });
      state.arrays.set(array, record);
      state.ownedArrays.add(array);
      if (first) array.forEach((item, index) => emit(queue, item, historical, undefined, Date.now(), index));
    } catch (_) { /* Frozen/non-configurable queues cannot be instrumented safely. */ }
  }

  for (const name of ['dataLayer', 'InsiderQueue']) {
    const descriptor = Object.getOwnPropertyDescriptor(window, name);
    let current;
    try { current = window[name]; hook(name, current, true); } catch (_) { continue; }
    // Capture late/replacement arrays synchronously. Keep existing accessor semantics intact.
    if (!descriptor || (descriptor.configurable && !descriptor.get && !descriptor.set && descriptor.writable)) {
      try {
        const getter = () => current;
        Object.defineProperty(window, name, { configurable: true,
          enumerable: descriptor?.enumerable ?? true,
          get: getter,
          set(value) { current = value; hook(name, value, false); }
        });
        state.properties.push({ name, descriptor, getter, current: () => current });
      } catch (_) { /* A polling fallback covers host properties. */ }
    }
  }
  // Insider also takes events through Insider.eventManager.dispatch(name, data) and reads the
  // legacy window.insider_object; neither goes through InsiderQueue.
  function hookDispatch() {
    try {
      const manager = window.Insider && window.Insider.eventManager;
      if (!manager || typeof manager.dispatch !== 'function' || manager.dispatch === state.dispatchWrapper) return;
      const original = manager.dispatch;
      const wrapper = function (...args) {
        // The SDK also dispatches its own signals here (`web-sdk:log`, `hit:userEvent:sent`,
        // `userLocationSet`...). Tracking events dispatched by the website are snake_case
        // (other_page_view); nothing else is recorded.
        if (!state.dispatching && typeof args[0] === 'string' && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(args[0])) {
          state.dispatching = true;
          try { emit('InsiderDispatch', { name: args[0], data: args[1] }, false); } finally { state.dispatching = false; }
        }
        return Reflect.apply(original, this, args);
      };
      manager.dispatch = wrapper;
      Object.assign(state, { dispatchWrapper: wrapper, dispatchOriginal: original, dispatchManager: manager });
    } catch (_) { /* Insider not ready or frozen. */ }
  }
  let lastInsiderObject;
  function watchInsiderObject() {
    try {
      const value = window.insider_object;
      if (!value || typeof value !== 'object') return;
      const safe = snapshotItem(value);
      const snapshot = JSON.stringify(safe);
      if (snapshot === lastInsiderObject) return;
      lastInsiderObject = snapshot;
      emit('insider_object', value, false, safe);
    } catch (_) { /* Unserializable object. */ }
  }
  let ticks = 0;
  state.timer = setInterval(() => {
    for (const name of ['dataLayer', 'InsiderQueue']) {
      try { hook(name, window[name], true); } catch (_) { /* Isolate hostile getters. */ }
    }
    hookDispatch();
    if (++ticks % 2 === 0) watchInsiderObject();
  }, 500);
  state.stop = () => {
    state.enabled = false;
    clearInterval(state.timer);
    try { if (state.dispatchManager && state.dispatchManager.dispatch === state.dispatchWrapper) state.dispatchManager.dispatch = state.dispatchOriginal; } catch (_) {}
    // Hand the queue back with the vendor's current push, so the site keeps working.
    for (const array of state.ownedArrays) {
      const record = state.arrays.get(array);
      if (Object.getOwnPropertyDescriptor(array, 'push')?.get !== record.get) continue;
      try {
        if (!record.descriptor && record.head === Array.prototype.push) delete array.push;
        else Object.defineProperty(array, 'push', { value: record.head, writable: true, enumerable: false, configurable: true });
      } catch (_) {}
    }
    for (const property of state.properties) {
      if (Object.getOwnPropertyDescriptor(window, property.name)?.get !== property.getter) continue;
      try {
        const descriptor = property.descriptor || { writable: true, enumerable: true, configurable: true };
        Object.defineProperty(window, property.name, { ...descriptor, value: property.current() });
      } catch (_) {}
    }
    try { delete window[marker]; } catch (_) {}
  };
})();
