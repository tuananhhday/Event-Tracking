(() => {
  'use strict';
  const marker = Symbol.for('eventqa.collector.v1');
  if (window[marker]) return;
  const state = { arrays: new WeakMap(), ownedArrays: new Set(), properties: [], timer: null, enabled: true };
  Object.defineProperty(window, marker, { value: state, configurable: true });

  function emit(queue, item, historical) {
    if (!state.enabled) return;
    try {
      const ancestors = [];
      const snapshot = JSON.stringify({ queue, item, historical, href: location.href,
        title: document.title, ts: Date.now() }, function (_key, value) {
        if (typeof value === 'bigint') return String(value);
        if (typeof value === 'object' && value !== null) {
          while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop();
          if (ancestors.includes(value)) return '[Circular]';
          if (Object.prototype.toString.call(value) === '[object Arguments]') value = Array.from(value);
          ancestors.push(value);
        }
        return value;
      });
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
        // Internal SDK notifications share this dispatcher with business events.
        // A cumulative cap lets those notifications silently exhaust capture
        // before the user performs the action under test.
        if (!state.dispatching && typeof args[0] === 'string') {
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
      const snapshot = JSON.stringify(value);
      if (snapshot === lastInsiderObject || snapshot.length > 200000) return;
      lastInsiderObject = snapshot;
      emit('insider_object', value, false);
    } catch (_) { /* Unserializable object. */ }
  }
  let ticks = 0;
  state.timer = setInterval(() => {
    for (const name of ['dataLayer', 'InsiderQueue']) {
      try { hook(name, window[name], true); } catch (_) { /* Isolate hostile getters. */ }
    }
    hookDispatch();
    if (++ticks % 5 === 0) watchInsiderObject();
  }, 100);
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
