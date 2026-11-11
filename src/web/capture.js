/* EventQA · Bản ghi từ F12
 * Dán toàn bộ đoạn này vào Console (F12) của trang cần kiểm (trình duyệt nào vào được trang là chạy
 * được, kể cả khi trang chặn theo IP mạng). Nó quan sát dataLayer / InsiderQueue và các request GA4 /
 * Insider / TP2 mà trang gửi đi, rồi cho tải ra một file JSON để nhập vào EventQA (nút "Nhập bản ghi
 * từ F12"). Chỉ đọc; không gửi dữ liệu đi đâu, không sửa gì trên trang. Bấm "Dừng & tải" khi xong.
 */
(() => {
  'use strict';
  const marker = Symbol.for('eventqa.capture.v1');
  if (window[marker]) { try { window[marker].panel(); } catch { /* ignore */ } return; }

  const pushes = [], requests = [];
  const MAX = 20000;
  const state = { enabled: true, arrays: new WeakMap(), ownedArrays: new Set(), properties: [], timer: null };
  Object.defineProperty(window, marker, { value: state, configurable: true });

  // The capture always keeps its record in sessionStorage (per tab + origin), so a reload does not lose
  // what was collected: re-pasting the snippet after F5 restores it and keeps appending. AUTO (set only
  // by the Tampermonkey userscript) re-runs on every load so no re-paste is needed.
  const AUTO = window.__eventqaCapturePersist === true, PERSIST = true, STORE = 'eventqa_capture_v1';
  let saveTimer, saveOff = false;
  if (PERSIST) try {
    const prior = JSON.parse(sessionStorage.getItem(STORE) || '{}');
    if (Array.isArray(prior.pushes)) for (const p of prior.pushes) if (pushes.length < MAX) pushes.push(p);
    if (Array.isArray(prior.requests)) for (const r of prior.requests) if (requests.length < MAX) requests.push(r);
  } catch { /* storage blocked */ }
  function flushNow() {
    if (!PERSIST || saveOff) return;
    clearTimeout(saveTimer);
    try { sessionStorage.setItem(STORE, JSON.stringify({ pushes, requests })); } catch { saveOff = true; }
  }
  function persist() {
    if (!PERSIST || saveOff) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushNow, 400);
  }
  // Write immediately when the tab is navigating away or hidden, so an event fired just before a reload
  // or page change is not lost in the debounce window.
  if (PERSIST) { addEventListener('pagehide', flushNow); addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); }); }

  // ---- queue pushes (same snapshot/hook approach EventQA uses, so imports decode identically) ----
  function snapshotItem(item) {
    const capture = { incomplete: false, reasons: [] };
    let nodes = 0, chars = 0;
    const ancestors = new WeakSet();
    const omit = reason => { capture.incomplete = true; if (!capture.reasons.includes(reason)) capture.reasons.push(reason); return '[Not captured]'; };
    const copy = (value, depth = 0) => {
      if (++nodes > 4096 || depth > 12) return omit('snapshot_limit');
      if (typeof value === 'bigint') return String(value);
      if (typeof value === 'string') { if (value.length > 50000 || chars + value.length > 200000) return omit('text_limit'); chars += value.length; return value; }
      if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) return undefined;
      if (value === null || typeof value !== 'object') return value;
      if (ancestors.has(value)) return '[Circular]';
      ancestors.add(value);
      try {
        if (Object.getPrototypeOf(value) === Date.prototype) return Date.prototype.toISOString.call(value);
        const length = Object.getOwnPropertyDescriptor(value, 'length');
        const isList = Array.isArray(value) || (!!Object.getOwnPropertyDescriptor(value, 'callee') && typeof length?.value === 'number');
        const result = isList ? [] : {};
        for (const key of Object.keys(value)) {
          if (nodes >= 4096 || chars >= 200000) { omit('snapshot_limit'); break; }
          chars += key.length;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) { result[key] = omit('accessor_omitted'); continue; }
          const child = copy(descriptor.value, depth + 1);
          if (child !== undefined) result[key] = child;
        }
        return result;
      } catch { return omit('unreadable_object'); }
      finally { ancestors.delete(value); }
    };
    return { item: copy(item), capture };
  }

  function emitPush(queue, item, historical, prepared, at, index) {
    if (!state.enabled) return;
    try {
      const safe = prepared || snapshotItem(item);
      const record = { queue, ...safe, historical, href: location.href, title: document.title, ts: at || Date.now() };
      if (Number.isInteger(index) && index >= 0) record.index = index;
      if (pushes.length < MAX) { pushes.push(record); persist(); refresh(); }
    } catch { /* evidence capture must never break the site */ }
  }

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
          const outermost = record.depth === 0, at = Date.now();
          record.depth++;
          try { return Reflect.apply(target, this, items); }
          finally {
            record.depth--;
            if (outermost) for (const item of items) emitPush(queue, item, false, undefined, at, Array.isArray(this) ? Array.prototype.lastIndexOf.call(this, item) : undefined);
          }
        };
        record.wrappers.set(target, wrapper);
      }
      return wrapper;
    };
    const get = () => typeof record.head === 'function' ? wrap(record.head) : record.head;
    try {
      Object.defineProperty(array, 'push', { get, set: value => { record.head = value; }, enumerable: false, configurable: true });
      Object.assign(record, { head, get });
      state.arrays.set(array, record);
      state.ownedArrays.add(array);
      if (first) array.forEach((item, index) => emitPush(queue, item, historical, undefined, Date.now(), index));
    } catch { /* frozen queues */ }
  }

  for (const name of ['dataLayer', 'InsiderQueue']) {
    const descriptor = Object.getOwnPropertyDescriptor(window, name);
    let current;
    try { current = window[name]; hook(name, current, true); } catch { continue; }
    if (!descriptor || (descriptor.configurable && !descriptor.get && !descriptor.set && descriptor.writable)) {
      try {
        const getter = () => current;
        Object.defineProperty(window, name, { configurable: true, enumerable: descriptor?.enumerable ?? true, get: getter, set(value) { current = value; hook(name, value, false); } });
        state.properties.push({ name, descriptor, getter, current: () => current });
      } catch { /* polling fallback */ }
    }
  }
  function hookDispatch() {
    try {
      const manager = window.Insider && window.Insider.eventManager;
      if (!manager || typeof manager.dispatch !== 'function' || manager.dispatch === state.dispatchWrapper) return;
      const original = manager.dispatch;
      const wrapper = function (...args) {
        if (!state.dispatching && typeof args[0] === 'string' && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(args[0])) {
          state.dispatching = true;
          try { emitPush('InsiderDispatch', { name: args[0], data: args[1] }, false); } finally { state.dispatching = false; }
        }
        return Reflect.apply(original, this, args);
      };
      manager.dispatch = wrapper;
      Object.assign(state, { dispatchWrapper: wrapper, dispatchOriginal: original, dispatchManager: manager });
    } catch { /* Insider not ready */ }
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
      emitPush('insider_object', value, false, safe);
    } catch { /* unserializable */ }
  }
  let ticks = 0;
  state.timer = setInterval(() => {
    for (const name of ['dataLayer', 'InsiderQueue']) { try { hook(name, window[name], true); } catch { /* hostile getter */ } }
    hookDispatch();
    if (++ticks % 2 === 0) watchInsiderObject();
  }, 500);

  // ---- tracking requests (GA4 /collect, Insider event/hit, VinPearl TP2) ----
  const ENDPOINT = /(?:^|\.)(?:google-analytics|analytics\.google)\.com\/(?:g\/)?(?:s\/)?collect|(?:^|\.)unification\.useinsider\.com\/api\/event\/|(?:^|\.)hit\.api\.useinsider\.com\/hit$|\/tp2\//i;
  const STATIC = /\.(?:js|mjs|css|png|jpe?g|webp|svg|ico|woff2?|ttf|map)(?:$|\?)/i;
  function wanted(url) { try { const u = new URL(url, location.href); return !STATIC.test(u.pathname) && ENDPOINT.test(u.hostname + u.pathname); } catch { return false; } }
  function record(url, method, body, contentType) {
    if (!state.enabled || requests.length >= MAX) return;
    let abs; try { abs = new URL(url, location.href).href; } catch { abs = String(url); }
    if (!wanted(abs)) return;
    const add = text => { requests.push({ url: abs, method: (method || 'POST').toUpperCase(), body: typeof text === 'string' ? text.slice(0, 200000) : '', content_type: contentType || '', ts: Date.now(), page_url: location.href }); persist(); refresh(); };
    if (body == null || body === '') return add('');
    if (typeof body === 'string') return add(body);
    try {
      if (body instanceof URLSearchParams) return add(body.toString());
      if (typeof Blob !== 'undefined' && body instanceof Blob) { body.text().then(add).catch(() => add('')); return; }
      if (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) { try { return add(new TextDecoder().decode(body)); } catch { return add(''); } }
      if (typeof FormData !== 'undefined' && body instanceof FormData) { const p = new URLSearchParams(); for (const [k, v] of body.entries()) if (typeof v === 'string') p.append(k, v); return add(p.toString()); }
    } catch { /* fall through */ }
    add('');
  }

  const beacon = navigator.sendBeacon?.bind(navigator);
  if (beacon) navigator.sendBeacon = function (url, data) { try { record(url, 'POST', data, typeof data === 'object' && data?.type ? data.type : ''); } catch { /* ignore */ } return beacon(url, data); };
  const fetchOrig = window.fetch;
  if (typeof fetchOrig === 'function') window.fetch = function (input, init = {}) {
    try {
      const url = typeof input === 'string' ? input : input?.url;
      const method = init.method || (typeof input === 'object' && input?.method) || 'GET';
      if (url && wanted(url)) record(url, method, init.body, init.headers && new Headers(init.headers).get('content-type') || '');
    } catch { /* ignore */ }
    return fetchOrig.apply(this, arguments);
  };
  const xhrOpen = XMLHttpRequest.prototype.open, xhrSend = XMLHttpRequest.prototype.send, xhrHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) { this.__eqa = { method, url, ct: '' }; return xhrOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) { if (this.__eqa && /content-type/i.test(name)) this.__eqa.ct = value; return xhrHeader.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) { try { if (this.__eqa) record(this.__eqa.url, this.__eqa.method, body, this.__eqa.ct); } catch { /* ignore */ } return xhrSend.apply(this, arguments); };

  // ---- data + stop ----
  function data() {
    return { app: 'eventqa-capture', version: 1, started_at: state.startedAt, exported_at: new Date().toISOString(),
      page: { url: location.href, title: document.title }, user_agent: navigator.userAgent, pushes, requests };
  }
  function download() {
    const blob = new Blob([JSON.stringify(data())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `eventqa-capture-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  async function copy() { try { await navigator.clipboard.writeText(JSON.stringify(data())); return true; } catch { return false; } }
  function reset() { pushes.length = 0; requests.length = 0; try { sessionStorage.removeItem(STORE); } catch { /* ignore */ } refresh(); }
  state.startedAt = new Date().toISOString();
  state.stop = () => {
    state.enabled = false; clearInterval(state.timer);
    try { if (beacon) navigator.sendBeacon = beacon; } catch { /* ignore */ }
    try { if (typeof fetchOrig === 'function') window.fetch = fetchOrig; } catch { /* ignore */ }
    try { XMLHttpRequest.prototype.open = xhrOpen; XMLHttpRequest.prototype.send = xhrSend; XMLHttpRequest.prototype.setRequestHeader = xhrHeader; } catch { /* ignore */ }
    try { if (state.dispatchManager && state.dispatchManager.dispatch === state.dispatchWrapper) state.dispatchManager.dispatch = state.dispatchOriginal; } catch { /* ignore */ }
    for (const array of state.ownedArrays) {
      const rec = state.arrays.get(array);
      if (Object.getOwnPropertyDescriptor(array, 'push')?.get !== rec.get) continue;
      try { if (!rec.descriptor && rec.head === Array.prototype.push) delete array.push; else Object.defineProperty(array, 'push', { value: rec.head, writable: true, enumerable: false, configurable: true }); } catch { /* ignore */ }
    }
    for (const property of state.properties) {
      if (Object.getOwnPropertyDescriptor(window, property.name)?.get !== property.getter) continue;
      try { Object.defineProperty(window, property.name, { ...(property.descriptor || { writable: true, enumerable: true, configurable: true }), value: property.current() }); } catch { /* ignore */ }
    }
    try { delete window[marker]; } catch { /* ignore */ }
  };

  // ---- small floating panel ----
  let box;
  function panel() {
    if (box) { box.style.display = 'block'; return; }
    box = document.createElement('div');
    box.setAttribute('style', 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;width:230px;font:13px/1.4 system-ui,Arial,sans-serif;color:#fff;background:#4b3fa8;border-radius:12px;padding:12px 14px;box-shadow:0 8px 28px rgba(0,0,0,.35)');
    box.innerHTML = '<div style="font-weight:700;margin-bottom:6px">✦ EventQA · bản ghi</div>'
      + '<div id="eqa-cap-count" style="margin-bottom:8px">0 push · 0 request</div>'
      + '<button id="eqa-cap-dl" style="all:unset;cursor:pointer;display:block;width:100%;box-sizing:border-box;text-align:center;background:#fff;color:#4b3fa8;font-weight:700;border-radius:8px;padding:8px;margin-bottom:6px">Dừng &amp; tải JSON</button>'
      + '<button id="eqa-cap-copy" style="all:unset;cursor:pointer;display:block;width:100%;box-sizing:border-box;text-align:center;border:1px solid #fff;border-radius:8px;padding:6px;margin-bottom:6px">Chép JSON</button>'
      + `<div style="font-size:11px;opacity:.85;margin-bottom:4px">${AUTO ? 'Tự chạy mỗi lần tải trang, gộp bản ghi.' : 'Giữ bản ghi khi tải lại trang. Sau mỗi lần F5, dán lại đoạn mã để ghi tiếp.'}</div><button id="eqa-cap-reset" style="all:unset;cursor:pointer;font-size:11px;text-decoration:underline;opacity:.85">Xóa &amp; ghi lại từ đầu</button>`
      + '<div id="eqa-cap-msg" style="font-size:11px;opacity:.85;margin-top:4px"></div>';
    (document.body || document.documentElement).appendChild(box);
    box.querySelector('#eqa-cap-dl').onclick = () => { download(); state.stop(); box.querySelector('#eqa-cap-msg').textContent = 'Đã tải file. Đã dừng ghi.'; box.querySelector('#eqa-cap-dl').textContent = 'Đã tải ✓'; };
    box.querySelector('#eqa-cap-copy').onclick = async () => { box.querySelector('#eqa-cap-msg').textContent = await copy() ? 'Đã chép JSON vào clipboard.' : 'Không chép được; dùng nút tải.'; };
    box.querySelector('#eqa-cap-reset')?.addEventListener('click', () => { reset(); box.querySelector('#eqa-cap-msg').textContent = 'Đã xóa bản ghi. Bắt đầu lại.'; });
  }
  function refresh() { const el = box?.querySelector('#eqa-cap-count'); if (el) el.textContent = `${pushes.length} push · ${requests.length} request`; }

  Object.assign(state, { data, download, copy, stop: state.stop, panel });
  window.__eventqaCapture = { data, download, copy, stop: () => state.stop(), get pushes() { return pushes; }, get requests() { return requests; } };
  panel();
  console.log('%c✦ EventQA đang ghi', 'color:#6d4fd8;font-weight:700', '— thao tác trên trang, rồi bấm “Dừng & tải JSON”. Lệnh: __eventqaCapture.download() / .copy() / .stop()');
})();
