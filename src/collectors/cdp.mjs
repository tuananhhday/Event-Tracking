import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { decodeRequest, DEFAULT_ENDPOINT_PATTERNS, matchesEndpoint, looksLikeTracking } from '../core/decoder.mjs';

const INJECT_JS = readFileSync(new URL('./inject.js', import.meta.url), 'utf8');

function localWebSocket(url) {
  const parsed = new URL(url);
  if (!['ws:', 'wss:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error('CDP connections are restricted to localhost.');
  }
  return url;
}

export async function listTargets(port = 9222, { signal } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid CDP port.');
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const targets = await response.json();
    if (!Array.isArray(targets)) throw new Error('Invalid target list');
    return targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl).map(target => ({ ...target, webSocketDebuggerUrl: localWebSocket(target.webSocketDebuggerUrl) }));
  } catch (error) {
    throw new Error(`Cannot read browser targets on localhost:${port}. Start a dedicated debug browser first. ${error.message}`);
  }
}

/** Multiplex commands without awaiting handlers in the WebSocket receive loop. */
export class CDPConnection extends EventEmitter {
  constructor(url, { timeoutMs = 8000 } = {}) {
    super();
    this.url = localWebSocket(url);
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.pending = new Map();
    this.closed = false;
  }
  async connect() {
    if (this.closed) throw new Error('CDP connection is closed.');
    if (this.connectPromise) return this.connectPromise;
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener('message', ({ data }) => {
      if (this.closed) return;
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result || {});
      } else if (message.method) this.emit('event', message);
    });
    this.socket.addEventListener('close', () => this.#closed());
    this.socket.addEventListener('error', () => { /* close or per-command timeout reports failures. */ });
    this.connectPromise = new Promise((resolve, reject) => {
      this.connectReject = reject;
      this.connectTimer = setTimeout(() => {
        this.connectReject?.(new Error('CDP WebSocket connection timed out.'));
        this.connectReject = null; this.close();
      }, this.timeoutMs);
      this.socket.addEventListener('open', () => {
        if (this.closed) return;
        clearTimeout(this.connectTimer); this.connectReject = null; resolve();
      }, { once: true });
      this.socket.addEventListener('error', () => {
        this.connectReject?.(new Error('CDP WebSocket connection failed.'));
        this.connectReject = null; this.close();
      }, { once: true });
    });
    return this.connectPromise;
  }
  send(method, params = {}, sessionId) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.closed) return Promise.reject(new Error('CDP connection is closed.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: CDP command timed out.`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  #closed() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectTimer);
    this.connectReject?.(new Error('CDP connection closed before it was ready.'));
    this.connectReject = null;
    for (const { reject, timer, method } of this.pending.values()) { clearTimeout(timer); reject(new Error(`CDP connection closed during ${method}.`)); }
    this.pending.clear();
    this.emit('closed');
  }
  close() { this.#closed(); try { this.socket?.close(); } catch { /* A connecting/already-closed socket may reject close. */ } }
}

// InsiderQueue page types carry Insider's event names, as used in tracking specifications.
export const INSIDER_PAGE_EVENTS = { home: 'homepage_view', category: 'listing_page_view', product: 'product_detail_page_view', cart: 'cart_page_view', purchase: 'confirmation_page_view', other: 'other_page_view', add_to_cart: 'add_to_cart', remove_from_cart: 'remove_from_cart' };

// insider_object.page.type values (legacy Insider page object) and the matching page events.
const INSIDER_OBJECT_PAGES = { home: 'homepage_view', main: 'homepage_view', listing: 'listing_page_view', category: 'listing_page_view', product: 'product_detail_page_view', basket: 'cart_page_view', cart: 'cart_page_view', confirmation: 'confirmation_page_view', purchase: 'confirmation_page_view' };

/** One queue push becomes one event, except an Insider custom_event push, which can carry several. */
export function queueEvents(record) {
  const base = { schema_version: '1.0', source: record.queue === 'dataLayer' ? 'GA4' : 'INSIDER', layer: 'JS_QUEUE', queue_name: record.queue,
    historical: Boolean(record.historical), ...(record.capture?.incomplete ? { capture: record.capture } : {}), captured_at: new Date(Number(record.ts) || Date.now()).toISOString(), page: { url: record.href || '', title: record.title || '' } };
  let payload = record.item;
  let eventName;
  if (record.queue === 'InsiderDispatch') {
    const name = String(payload?.name || 'insider_dispatch');
    const data = payload?.data;
    if (/^ucd:event:beforeSend$/i.test(name) && Array.isArray(data?.events)) {
      return data.events.flatMap((item, index) => typeof item?.event_name === 'string' ? [{
        ...base, event_name: item.event_name, queue_type: 'sdk_before_send', sdk_event: name,
        payload: item, original_payload: data, original_event_index: index,
      }] : []);
    }
    return [{ ...base, event_name: name, queue_type: 'dispatch', ...( name.includes(':') ? { diagnostic: true } : {}), payload: payload?.data && typeof payload.data === 'object' ? payload.data : { value: payload?.data ?? null } }];
  }
  if (record.queue === 'insider_object') {
    const pageType = String(payload?.page?.type ?? '').toLowerCase();
    const name = payload?.transaction ? 'confirmation_page_view' : INSIDER_OBJECT_PAGES[pageType] || (pageType ? 'other_page_view' : 'insider_object');
    return [{ ...base, event_name: name, queue_type: 'insider_object', payload }];
  }
  if (record.queue === 'InsiderQueue' && payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.type === 'string') {
    if (payload.type === 'custom_event' && Array.isArray(payload.value) && payload.value.length) {
      return payload.value.map((item, index) => ({ ...base, event_name: String(item?.event_name || 'custom_event'), queue_type: 'custom_event',
        payload: { ...payload, value: [item] }, original_payload: payload, original_event_index: index }));
    }
    // init/user/currency/... configure the SDK; they are kept as evidence under a distinct name.
    return [{ ...base, event_name: INSIDER_PAGE_EVENTS[payload.type] || `insider_${payload.type}`, queue_type: payload.type, payload }];
  }
  if (Array.isArray(payload)) {
    if (payload[0] === 'event' || payload[0] === 'track') { eventName = payload[1]; payload = { ...(payload[2] || {}), event: eventName }; }
    else { eventName = payload.find(item => typeof item === 'string') || 'QUEUE_ITEM'; payload = { items: payload }; }
  } else if (payload && typeof payload === 'object') {
    // GTM clears the previous ecommerce object with {ecommerce: null} before each ecommerce event.
    eventName = payload.event || payload.event_name || payload.name || payload.type || (Object.keys(payload).length === 1 && payload.ecommerce === null ? 'ecommerce_reset' : 'QUEUE_ITEM');
  } else { eventName = 'QUEUE_ITEM'; payload = { value: payload }; }
  return [{ ...base, event_name: String(eventName), payload }];
}

export class CDPCollector {
  constructor({ port = 9222, targetId, urlFilter, onEvent, onStatus = () => {}, endpointPatterns = DEFAULT_ENDPOINT_PATTERNS, captureQueues = true } = {}) {
    if (typeof onEvent !== 'function') throw new Error('CDPCollector requires onEvent.');
    this.port = Number(port); this.targetId = targetId; this.urlFilter = urlFilter;
    this.onEvent = onEvent; this.onStatus = onStatus;
    this.captureQueues = captureQueues;
    this.patterns = endpointPatterns; this.discovered = new Map();
    this.connections = new Map(); this.attaching = new Map(); this.activeConnections = new Set(); this.jobs = new Set(); this.running = false; this.generation = 0;
  }
  #status(message) { try { this.onStatus(message); } catch { /* UI callbacks do not break capture. */ } }
  // Endpoint suggestions keep host + path and a count only; payloads stay out of evidence.
  #suggest(request, resourceType) {
    if (!looksLikeTracking({ url: request.url, method: request.method, resourceType })) return;
    let key;
    try { const u = new URL(request.url); key = (u.hostname + u.pathname).slice(0, 160); } catch { return; }
    const entry = this.discovered.get(key);
    if (entry) { entry.count++; entry.last_at = new Date().toISOString(); return; }
    if (this.discovered.size >= 60) return;
    this.discovered.set(key, { endpoint: key, method: request.method, resource_type: resourceType || null, count: 1, last_at: new Date().toISOString() });
  }
  /** Replaces the allowlist for requests sent from now on. */
  setPatterns(patterns) {
    for (const pattern of patterns) new RegExp(pattern, 'i');
    this.patterns = [...patterns];
    for (const key of this.discovered.keys()) if (matchesEndpoint(`https://${key}`, this.patterns)) this.discovered.delete(key);
  }
  async readQueues() {
    if (!this.running || !this.captureQueues) throw new Error('Đọc queue cần phiên CDP có bật thu thập JS queue.');
    const jobs = [];
    for (const state of this.connections.values()) for (const context of state.contexts.values()) {
      if (jobs.length >= 12) break;
      jobs.push((async () => {
        const result = await state.connection.send('Runtime.evaluate', {
          expression: "JSON.stringify(window[Symbol.for('eventqa.collector.v1')]?.readQueues?.() ?? null)", contextId: context.id, returnByValue: true,
        }, context.sessionId);
        if (result.exceptionDetails) throw new Error('Frame không cho đọc queue.');
        const snapshot = JSON.parse(result.result?.value || 'null');
        return snapshot ? { target_id: state.target.id, frame_id: context.frameId, ...snapshot } : null;
      })());
    }
    const results = await Promise.allSettled(jobs);
    return { snapshots: results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value), failed_frames: results.filter(r => r.status === 'rejected').length };
  }
  #job(promise) { const generation = this.generation; this.jobs.add(promise); promise.catch(error => { if (this.running && generation === this.generation) this.#status(`CDP: ${error.message}`); }).finally(() => this.jobs.delete(promise)); }
  async #emit(event, generation) { if (this.running && generation === this.generation) await this.onEvent(event); }
  #matches(target) {
    return (!this.targetId || this.targetId === target.id) && (!this.urlFilter || String(target.url).includes(this.urlFilter));
  }
  async start(session) {
    if (this.running) throw new Error('CDP collector is already running.');
    if (this.stopPromise) throw new Error('CDP collector is still stopping.');
    const generation = ++this.generation;
    this.runController = new AbortController();
    this.session = session; this.running = true;
    try {
      const targets = (await listTargets(this.port, { signal: this.runController.signal })).filter(target => this.#matches(target));
      if (!this.running || generation !== this.generation) throw new Error('CDP collector stopped during startup.');
      if (!targets.length) throw new Error('No page target matches the selected tab or URL. Open the test website first.');
      const results = await Promise.allSettled(targets.map(target => this.#attach(target, generation)));
      if (!this.running || generation !== this.generation) throw new Error('CDP collector stopped during startup.');
      if (!results.some(result => result.status === 'fulfilled')) throw new Error(results[0].reason.message);
      this.timer = setInterval(() => this.#job(this.#discover(generation)), 750);
      this.#status(`CDP connected: ${this.connections.size} tab(s) on localhost:${this.port}.`);
    } catch (error) { if (generation === this.generation) await this.stop(); throw error; }
  }
  async #discover(generation) {
    if (!this.running || generation !== this.generation || this.discovering) return;
    this.discovering = true;
    try {
      const targets = await listTargets(this.port, { signal: this.runController.signal });
      if (!this.running || generation !== this.generation) return;
      for (const target of targets) if (this.#matches(target) && !this.connections.has(target.id) && !this.attaching.has(target.id)) this.#job(this.#attach(target, generation));
    } finally { if (generation === this.generation) this.discovering = false; }
  }
  async #attach(target, generation) {
    if (this.attaching.has(target.id) || this.connections.has(target.id) || !this.running || generation !== this.generation) return;
    this.attaching.set(target.id, generation);
    const connection = new CDPConnection(target.webSocketDebuggerUrl);
    this.activeConnections.add(connection);
    connection.on('closed', () => this.activeConnections.delete(connection));
    const state = { connection, target, requests: new Map(), contexts: new Map(), scripts: new Map(), childSessions: new Set() };
    try {
      await connection.connect();
      if (!this.running || generation !== this.generation) { connection.close(); return; }
      this.connections.set(target.id, state);
      connection.on('event', message => this.#job(this.#event(state, message, generation)));
      connection.on('closed', () => { if (this.connections.get(target.id) === state) this.connections.delete(target.id); });
      await this.#instrument(state, undefined, generation);
      if (!this.running || generation !== this.generation) return;
      this.#status(`Capturing tab: ${target.title || target.id}`);
    } catch (error) { connection.close(); if (this.connections.get(target.id) === state) this.connections.delete(target.id); throw error; }
    finally { if (this.attaching.get(target.id) === generation) this.attaching.delete(target.id); }
  }
  async #instrument(state, sessionId, generation) {
    const send = (method, params) => this.running && generation === this.generation ? state.connection.send(method, params, sessionId) : Promise.reject(new Error('CDP collector stopped.'));
    if (!this.captureQueues) {
      await send('Network.enable', { maxPostDataSize: 1048576 });
      await send('Page.enable');
      await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      return;
    }
    await send('Runtime.addBinding', { name: '__eventqa_emit' });
    await send('Runtime.enable');
    await send('Network.enable', { maxPostDataSize: 1048576 });
    await send('Page.enable');
    let script;
    try { script = await send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT_JS, runImmediately: true }); }
    catch { script = await send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT_JS }); }
    state.scripts.set(sessionId || '', script.identifier);
    // This is also needed when attaching after the document has already loaded.
    await send('Runtime.evaluate', { expression: INJECT_JS });
    // Child frames/workers are never paused: a paused frame can stall the page under test while
    // instrumentation commands wait on it. Pushes made before the hook lands are still captured
    // from the existing queue as historical evidence.
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(error => this.#status(`Child targets: ${error.message}`));
  }
  async #event(state, { method, params = {}, sessionId }, generation) {
    // A target that is somehow waiting must be released even after this run stopped.
    if (method === 'Target.attachedToTarget' && params.waitingForDebugger && (!this.running || generation !== this.generation)) {
      await state.connection.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
      return;
    }
    if (!this.running || generation !== this.generation) return;
    const send = (name, values) => state.connection.send(name, values, sessionId);
    if (method === 'Target.attachedToTarget') {
      const childId = params.sessionId;
      // Release first, then instrument: the frame never waits on EventQA.
      if (params.waitingForDebugger) await state.connection.send('Runtime.runIfWaitingForDebugger', {}, childId).catch(() => {});
      if (params.targetInfo?.type === 'iframe') {
        state.childSessions.add(childId);
        await this.#instrument(state, childId, generation);
      }
    } else if (method === 'Runtime.executionContextCreated') {
      const context = params.context;
      if (this.captureQueues && context?.auxData?.isDefault) {
        state.contexts.set(`${sessionId || ''}:${context.id}`, { id: context.id, sessionId, frameId: context.auxData.frameId });
        await send('Runtime.evaluate', { expression: INJECT_JS, contextId: context.id }).catch(() => {});
      }
    } else if (method === 'Runtime.executionContextDestroyed') {
      state.contexts.delete(`${sessionId || ''}:${params.executionContextId}`);
    } else if (method === 'Runtime.executionContextsCleared') {
      for (const [key, context] of state.contexts) if (context.sessionId === sessionId) state.contexts.delete(key);
    } else if (method === 'Runtime.bindingCalled' && params.name === '__eventqa_emit') {
      if (!this.captureQueues) return;
      let record;
      try { record = JSON.parse(params.payload); } catch { return; }
      if (!['dataLayer', 'InsiderQueue', 'InsiderDispatch', 'insider_object'].includes(record.queue)) return;
      const frameId = state.contexts.get(`${sessionId || ''}:${params.executionContextId}`)?.frameId;
      for (const event of queueEvents(record)) {
        event.page = { ...event.page, frame_id: frameId, target_id: state.target.id };
        await this.#emit(event, generation);
      }
    } else if (method === 'Page.frameNavigated' && !params.frame?.parentId && !sessionId) {
      state.target.url = params.frame.url;
    } else if (method === 'Network.requestWillBeSent') {
      const request = params.request || {};
      // CORS preflight asks permission to send an event; it is not the event itself.
      if (request.method?.toUpperCase() === 'OPTIONS') return;
      if (!matchesEndpoint(request.url || '', this.patterns)) { this.#suggest(request, params.type); return; }
      const key = `${sessionId || ''}:${params.requestId}`;
      const capturedAt = new Date((params.wallTime || Date.now() / 1000) * 1000).toISOString();
      const pending = { requestId: params.requestId, capturedAt, url: request.url, method: request.method,
        page: { url: params.documentURL || state.target.url, frame_id: params.frameId, target_id: state.target.id }, events: [], ready: null };
      state.requests.set(key, pending);
      pending.ready = (async () => {
        let body = request.postData || '';
        let bodyUnavailable = false;
        if (!body && request.hasPostData) {
          try { body = (await send('Network.getRequestPostData', { requestId: params.requestId })).postData || ''; bodyUnavailable = !body; }
          catch { bodyUnavailable = true; }
          if (bodyUnavailable) this.#status('A tracking request body was unavailable; evidence is retained with the URL and marked incomplete.');
        }
        const contentType = Object.entries(request.headers || {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1] || '';
        pending.events = decodeRequest({ url: request.url, body, bodyUnavailable, contentType, method: request.method, requestId: params.requestId });
        for (const event of pending.events) await this.#emit({ ...event, captured_at: capturedAt, page: pending.page,
          network: { ...event.network, request_id: params.requestId, url: request.url, method: request.method, phase: 'request' } }, generation);
      })();
      await pending.ready;
    } else if (['Network.responseReceived', 'Network.loadingFailed', 'Network.loadingFinished'].includes(method)) {
      const key = `${sessionId || ''}:${params.requestId}`;
      const pending = state.requests.get(key);
      if (!pending) return;
      await pending.ready;
      // Chrome 156+ cancels the loader of a body-less response (GA4 204) after
      // delivering it: the request reached the server, so it is not a failure.
      const canceledAfterResponse = method === 'Network.loadingFailed' && pending.responded && params.canceled === true;
      if (method === 'Network.responseReceived') pending.responded = true;
      if (method !== 'Network.loadingFinished' && !canceledAfterResponse) {
        const failed = method === 'Network.loadingFailed';
        for (const event of pending.events) await this.#emit({ ...event, captured_at: pending.capturedAt, page: pending.page,
          network: { ...event.network, request_id: pending.requestId, url: pending.url, method: pending.method,
            phase: failed ? 'failed' : 'response', ...(failed ? { error: params.errorText || 'Network request failed' } : { status: params.response?.status }) } }, generation);
      }
      if (method !== 'Network.responseReceived') state.requests.delete(key);
    }
  }
  #deactivate() {
    this.running = false;
    this.generation++;
    this.runController?.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  #disconnect() {
    this.#deactivate();
    for (const connection of this.activeConnections) connection.close();
    for (const state of this.connections.values()) state.connection.close();
    this.activeConnections.clear(); this.connections.clear(); this.attaching.clear(); this.jobs.clear(); this.discovering = false;
  }
  forceStop() {
    this.stopWasForced = true;
    this.#disconnect();
  }
  stop({ timeoutMs = 3000 } = {}) {
    if (this.stopPromise) return this.stopPromise;
    this.#deactivate();
    this.stopWasForced = false;
    const states = [...this.connections.values()];
    this.stopPromise = (async () => {
      let deadline;
      const budget = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(timeoutMs, 3000)) : 3000;
      // All context/session cleanup runs concurrently. Stale frames must not multiply
      // the shutdown delay by their count or by the per-command timeout.
      const cleanup = [];
      for (const state of states) {
      for (const context of state.contexts.values()) {
          cleanup.push(state.connection.send('Runtime.evaluate', { expression: "window[Symbol.for('eventqa.collector.v1')]?.stop?.()", contextId: context.id }, context.sessionId));
      }
        for (const sessionId of state.childSessions) cleanup.push(state.connection.send('Runtime.runIfWaitingForDebugger', {}, sessionId));
        for (const sessionId of new Set(['', ...state.scripts.keys(), ...state.childSessions])) {
          const identifier = state.scripts.get(sessionId);
          if (identifier) cleanup.push(state.connection.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId || undefined));
          if (this.captureQueues) cleanup.push(state.connection.send('Runtime.removeBinding', { name: '__eventqa_emit' }, sessionId || undefined));
          cleanup.push(state.connection.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, sessionId || undefined));
        }
      }
      try {
        const completed = await Promise.race([Promise.allSettled(cleanup).then(() => true), new Promise(resolve => { deadline = setTimeout(() => resolve(false), budget); })]);
        return { forced: !completed || this.stopWasForced };
      } finally { clearTimeout(deadline); this.#disconnect(); }
    })().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }
}
