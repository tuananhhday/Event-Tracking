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

  function emit(queue, item, historical, prepared) {
    if (!state.enabled) return;
    try {
      const safe = prepared || snapshotItem(item);
      const snapshot = JSON.stringify({ queue, ...safe, historical, href: location.href, title: document.title, ts: Date.now() });
      if (typeof window.__eventqa_emit === 'function') window.__eventqa_emit(snapshot);
    } catch (_) { /* Evidence capture must never break the site. */ }
  }

  function hook(queue, array, historical) {
    if (!Array.isArray(array)) return;
    let record = state.arrays.get(array);
    if (record?.wrapper === array.push) return;
    const original = array.push;
    const originalDescriptor = Object.getOwnPropertyDescriptor(array, 'push');
    if (typeof original !== 'function') return;
    const first = !record;
    record = record || { depth: 0 };
    const wrapper = function (...items) {
      // Vendors often wrap an earlier push. Every generation shares this guard,
      // so their call through an older collector wrapper cannot duplicate evidence.
      const outermost = record.depth === 0;
      record.depth++;
      try {
        if (outermost) for (const item of items) emit(queue, item, false);
        return Reflect.apply(original, this, items);
      } finally { record.depth--; }
    };
    try {
      Object.defineProperty(array, 'push', { value: wrapper, writable: true,
        enumerable: Object.prototype.propertyIsEnumerable.call(array, 'push'), configurable: true });
      Object.assign(record, { wrapper, original, descriptor: originalDescriptor });
      state.arrays.set(array, record);
      state.ownedArrays.add(array);
      if (first) for (const item of array) emit(queue, item, historical);
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
        // Lifecycle chatter is not a business event. Keep the beforeSend envelope
        // because it contains actual named events; never exhaust a global quota on
        // SDK internals before the user reaches checkout.
        const name = typeof args[0] === 'string' ? args[0] : '';
        const internal = name.includes(':');
        if (!state.dispatching && name && (!internal || /^ucd:event:beforeSend$/i.test(name))) {
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
  state.readQueues = () => {
    const queues = {};
    for (const name of ['dataLayer', 'InsiderQueue']) {
      const descriptor = Object.getOwnPropertyDescriptor(window, name);
      const owned = state.properties.find(p => p.name === name && descriptor?.get === p.getter);
      if (!descriptor) { queues[name] = { status: 'ABSENT', items: [] }; continue; }
      if (!owned && !Object.hasOwn(descriptor, 'value')) { queues[name] = { status: 'ACCESSOR_UNAVAILABLE', items: [] }; continue; }
      const array = owned ? owned.current() : descriptor.value;
      queues[name] = Array.isArray(array) ? { status: 'CAPTURED', length: array.length, ...snapshotItem(array) }
        : { status: 'NOT_ARRAY', items: [] };
    }
    return { read_at: new Date().toISOString(), url: location.href, title: document.title, queues };
  };
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
    for (const array of state.ownedArrays) {
      const record = state.arrays.get(array);
      if (array.push === record.wrapper) {
        try {
          if (record.descriptor) Object.defineProperty(array, 'push', record.descriptor);
          else delete array.push;
        } catch (_) {}
      }
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
