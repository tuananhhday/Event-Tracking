// Independent diagnostic reconstruction of observed declarative dataLayer messages.
// Semantics reference: google/data-layer-helper (Apache-2.0), README merge table.
// This is neither the GTM private runtime nor a replacement for the raw push.
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (object, key) => Object.getOwnPropertyDescriptor(object, key);
const pathKey = (base, key) => /^[A-Za-z_$][\w$]*$|^\d+$/.test(key)
  ? base ? `${base}.${key}` : key : `${base}[${JSON.stringify(key)}]`;
const nested = (path, parent) => path === parent || path.startsWith(parent + '.') || path.startsWith(parent + '[');

export class DataLayerModel {
  constructor({ historyComplete = false, maxNodes = 4096, maxDepth = 12, maxArrayItems = 500, maxCharacters = 200000 } = {}) {
    this.limits = { maxNodes, maxDepth, maxArrayItems, maxCharacters };
    this.values = {}; this.origins = new Map(); this.index = 0; this.lastSequence = 0;
    this.warnings = new Set(historyComplete ? [] : ['history_before_observation_unknown']);
  }
  warn(reason) { if (this.warnings.size < 24) this.warnings.add(reason); }
  copy(value) {
    let visited = 0, characters = 0; const ancestors = new WeakSet();
    const walk = (node, depth = 0) => {
      if (++visited > this.limits.maxNodes || depth > this.limits.maxDepth) { this.warn('model_limit'); return undefined; }
      if (node === undefined) { this.warn('undefined_value_not_serializable'); return undefined; }
      if (typeof node === 'string') { characters += node.length; if (characters > this.limits.maxCharacters) { this.warn('model_limit'); return undefined; } return node; }
      if (node === null || typeof node === 'boolean' || typeof node === 'number' && Number.isFinite(node)) return node;
      if (typeof node !== 'object') { this.warn('unsupported_value'); return undefined; }
      if (ancestors.has(node)) { this.warn('circular_value'); return undefined; }
      if (!Array.isArray(node) && !plain(node)) { this.warn('non_plain_object'); return undefined; }
      ancestors.add(node);
      const result = Array.isArray(node) ? [] : {};
      try {
        for (const key of Object.keys(node)) {
          characters += key.length;
          if (visited >= this.limits.maxNodes || characters > this.limits.maxCharacters) { this.warn('model_limit'); break; }
          if (dangerous.has(key) || key.length > 256) { this.warn('unsupported_property'); continue; }
          if (Array.isArray(node) && key !== '_clear' && (!/^\d+$/.test(key) || Number(key) >= this.limits.maxArrayItems)) { this.warn('array_limit_or_property'); continue; }
          const descriptor = own(node, key);
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) { this.warn('accessor_not_read'); continue; }
          Object.defineProperty(result, key, { value: walk(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
        }
      } finally { ancestors.delete(node); }
      return result;
    };
    try { return walk(value); } catch { this.warn('unreadable_value'); return undefined; }
  }
  removeOrigins(prefix) { for (const path of this.origins.keys()) if (nested(path, prefix)) this.origins.delete(path); }
  apply(record = {}) {
    this.index++;
    const sequence = Number(record.queue_sequence);
    if (Number.isInteger(sequence) && sequence > 0) {
      if (sequence !== this.lastSequence + 1) this.warn('observed_sequence_gap');
      this.lastSequence = sequence;
    }
    if (record.queue_history_complete === false) this.warn('history_before_observation_unknown');
    if (record.capture?.incomplete) this.warn('partial_message_capture');
    for (const reason of record.model_limitations || []) this.warn(reason);
    const kind = record.message_type || typeof record.item;
    const currentPaths = new Set();
    if (kind === 'function' || kind === 'symbol' || kind === 'undefined') this.warn('unsupported_message');
    else if (Array.isArray(record.item)) this.warn('command_or_gtag_message_not_reconstructed');
    else if (!plain(record.item)) this.warn('unsupported_message');
    else {
      const item = this.copy(record.item);
      const mark = (path, payloadPath) => {
        this.origins.set(path, { message_index: this.index, queue_instance_id: record.queue_instance_id || null,
          queue_sequence: Number.isInteger(sequence) ? sequence : null, payload_path: payloadPath });
        currentPaths.add(path);
      };
      const merge = (previous, incoming, path, rawPath, replace = false) => {
        const list = Array.isArray(incoming), object = plain(incoming);
        if (!list && !object) { this.removeOrigins(path); mark(path, rawPath); return incoming; }
        let target = previous;
        if (replace || (list ? !Array.isArray(previous) : !plain(previous))) {
          this.removeOrigins(path); target = list ? [] : {};
        }
        const keys = Object.keys(incoming).filter(key => key !== '_clear');
        if (!keys.length && !Object.keys(target).length) mark(path, rawPath);
        for (const key of keys) {
          const nextPath = pathKey(path, key);
          target[key] = merge(target[key], incoming[key], nextPath, `${rawPath}[${JSON.stringify(key)}]`, !!incoming._clear);
        }
        return target;
      };
      for (const [key, value] of Object.entries(item || {})) {
        if (key === '_clear') continue;
        const parts = key.split('.');
        if (parts.some(part => !part || dangerous.has(part)) || parts.length > this.limits.maxDepth) { this.warn('unsupported_dotted_path'); continue; }
        let target = this.values, prefix = '';
        for (const part of parts.slice(0, -1)) {
          prefix = pathKey(prefix, part);
          if (!plain(target[part])) { this.removeOrigins(prefix); target[part] = {}; }
          target = target[part];
        }
        const leaf = parts.at(-1), path = pathKey(prefix, leaf);
        target[leaf] = merge(target[leaf], value, path, `record.item[${JSON.stringify(key)}]`, !!item._clear);
      }
    }
    // Bounding the retained model is independent of website execution. Once a
    // limit/unknown command was encountered, later pushes do not erase the caveat.
    this.values = this.copy(this.values) || {};
    const snapshot = this.copy(this.values) || {};
    const livePaths = new Set();
    const collect = (value, path = '') => {
      if (value && typeof value === 'object' && Object.keys(value).length) for (const [key, child] of Object.entries(value)) collect(child, pathKey(path, key));
      else if (path) livePaths.add(path);
    };
    collect(snapshot);
    for (const path of this.origins.keys()) if (!livePaths.has(path)) this.origins.delete(path);
    return { source: 'observed_declarative_dataLayer_messages', is_gtm_private_state: false, complete: this.warnings.size === 0,
      stage: 'before_original_push', message_index: this.index, queue_instance_id: record.queue_instance_id || null,
      values: snapshot, origins: Object.fromEntries(this.origins), current_message_paths: [...currentPaths].filter(path => livePaths.has(path)),
      inherited_paths: [...livePaths].filter(path => !currentPaths.has(path)), warnings: [...this.warnings] };
  }
}
