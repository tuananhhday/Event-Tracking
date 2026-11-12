// Insider Test Lab (panel → Test Lab → Test Results): the events Insider received from a test device,
// read from the panel's own table in the EventQA test browser (src/collectors/testlab.js). Each event
// the table lists becomes one EventQA event in the form the AppOTA_Insider rows (R1511…) describe:
// { event, default_parameters, custom_parameters }, checked against the specification like any event.
//
// The event keeps what Test Lab shows, as it shows it: each parameter under the name in its NAME column
// with the text of its VALUE column, Default and Custom as its TYPE says, in the table's order. Nothing
// is renamed or retyped. Comparing it with a specification or a define file is done on a separate view
// (testLabSpecView: Insider's keys, typed by Insider's catalogue), never on the record itself.
//
// Insider numbers each received event in the table (1, 2, 3… newest first). The table only shows part
// of its rows at a time (a closed event shows none of its parameters, a long list only what is near the
// screen), so an event is read as one record that later readings complete: parameters scrolled into
// view are added, a status that turns green is updated. Until every parameter has been seen, the
// event is marked incomplete and its specification check waits (REVIEW).
//
// The panel's catalogue (GET …/test-lab/items, recorded from the panel's own calls) gives each event's
// key (Product Page View → product_detail_page_view), each parameter's key and data type, and why a
// parameter failed; without it the names and values are read as Insider's copied samples are.
import { insiderDisplayValue, insiderKey } from '../spec/insider-sample.mjs';
import { insiderEventName, insiderParameterName } from './insider-hit.mjs';

export const TESTLAB_LAYER = 'TEST_LAB';
export const TESTLAB_STATUSES = ['successful', 'failed', 'in_progress', 'not_tested', 'unknown'];
// Events already in the table when a Test Lab page is first read (earlier tests) are marked historical,
// as queue items pushed before capture started are.
const HISTORY_MS = 5000;

/** A page of Insider's panel (not its tracking API hosts). */
export function isInsiderPanel(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return /^https?:$/.test(protocol) && /(?:^|\.)useinsider\.com$/i.test(hostname) && !/(?:^|\.)(?:api|unification)\.useinsider\.com$|\.api\.useinsider\.com$/i.test(hostname);
  } catch { return false; }
}
/** The panel's Test Lab catalogue call. */
export const isTestLabCatalog = url => /\/test-lab\/items(?:[?#]|$)/.test(String(url ?? ''));

/** Insider's Test Lab catalogue: every event and attribute the app may send, with its parameters. */
export class TestLabCatalog {
  constructor() { this.items = new Map(); this.labels = null; }
  get size() { return this.items.size; }
  /** Adds one page of GET …/test-lab/items ({ data: [{ kind, key, display_name, parameters: [...] }] }). */
  add(json) {
    let added = 0;
    for (const item of Array.isArray(json?.data) ? json.data : []) {
      if (!item || typeof item.key !== 'string' || typeof item.kind !== 'string') continue;
      this.items.set(`${item.kind}:${item.key}`, item); added++;
    }
    if (added) this.labels = null;
    return added;
  }
  /** The item the panel shows under a label: the exact label first ("Add to Cart" is not "Add To Cart"), then one unique without case. */
  find(label, kind = 'event') {
    if (!this.labels) {
      this.labels = { exact: new Map(), loose: new Map() };
      for (const item of this.items.values()) {
        const name = String(item.display_name ?? '');
        for (const [map, key] of [[this.labels.exact, `${item.kind}|${name}`], [this.labels.loose, `${item.kind}|${name.toLowerCase()}`]]) map.set(key, [...(map.get(key) ?? []), item]);
      }
    }
    const exact = this.labels.exact.get(`${kind}|${label}`);
    if (exact?.length === 1) return exact[0];
    const loose = this.labels.loose.get(`${kind}|${String(label ?? '').toLowerCase()}`);
    return loose?.length === 1 ? loose[0] : null;
  }
}
const parameterOf = (item, { key, name }) => item?.parameters?.find(parameter => key ? parameter.key === key : parameter.display_name === name) ?? null;

const text = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 4000) : '';
const status = value => TESTLAB_STATUSES.includes(value) ? value : 'unknown';

/** A displayed value typed by the catalogue's data type; without it, typed as Insider's copied samples are. */
export function testLabValue(key, value, dataType) {
  const raw = String(value ?? '').trim();
  switch (dataType) {
    case 'string': case 'datetime': case 'date': return raw;
    case 'number': { const plain = raw.replace(/,/g, ''); return /^-?\d+(?:\.\d+)?$/.test(plain) ? Number(plain) : raw; }
    case 'boolean': return raw === 'true' ? true : raw === 'false' ? false : raw;
    case 'array': {
      if (/^\[.*\]$/s.test(raw)) { try { const list = insiderDisplayValue(key, raw); if (Array.isArray(list)) return list; } catch { /* listed as text below */ } }
      return raw ? raw.split(/\s*,\s*/) : [];
    }
    default: try { return insiderDisplayValue(key, raw); } catch { return raw; }
  }
}

// Where a parameter goes: custom parameters (key c_slug, or "Custom" in TYPE) under their name without
// c_, default ones under their full name (usp → unit_sale_price).
function fieldOf(param, known) {
  const key = param.key ?? known?.key ?? null;
  const custom = /custom/i.test(param.subtype ?? '') || (!/default/i.test(param.subtype ?? '') && (known?.type === 'custom' || /^c_/.test(key ?? '')));
  const name = key ? (custom ? key.replace(/^c_/, '') : insiderParameterName(key)) : insiderKey(param.name);
  return { group: custom ? 'custom' : 'default', name, key };
}

/** One Test Lab event (an event row with its parameter rows) as an EventQA event, without evidence ids. */
export function testLabEvent(group, { url = '', title = '', targetId, at, catalog, reader } = {}) {
  const kind = /attribute/i.test(group.type ?? '') ? 'attribute' : 'event';
  const item = catalog?.find(group.name, kind) ?? null;
  const page = { url, title, ...(targetId ? { target_id: targetId } : {}) };
  const params = [], default_parameters = {}, custom_parameters = {};
  for (const param of group.params ?? []) {
    const known = parameterOf(item, param), field = fieldOf(param, known);
    params.push({ name: param.name, key: field.key, field: `${field.group}_parameters.${field.name}`, value: param.value, status: status(param.status),
      ...(param.status_text ? { status_text: param.status_text } : {}), ...(known?.data_type ? { data_type: known.data_type } : {}),
      ...(known?.failed_detail ? { failed_detail: known.failed_detail } : {}) });
    // As Test Lab shows it: the NAME column, the VALUE text; a name listed twice keeps both.
    const target = /custom/i.test(param.subtype ?? '') || (!/default/i.test(param.subtype ?? '') && field.group === 'custom') ? custom_parameters : default_parameters;
    let label = param.name;
    for (let n = 2; Object.hasOwn(target, label); n++) label = `${param.name} (${n})`;
    target[label] = param.value;
  }
  const testlab = { receipt: group.group ?? null, status: status(group.status), ...(group.status_text ? { status_text: group.status_text } : {}), type: group.type ?? '', subtype: group.subtype ?? '',
    ...(reader ? { reader } : {}), complete: Boolean(group.complete), ...(group.collapsed ? { collapsed: true } : {}), ...(item ? { catalog_key: item.key } : {}), params };
  const base = { schema_version: '1.0', source: 'INSIDER', layer: TESTLAB_LAYER, captured_at: at || new Date().toISOString(), page, testlab,
    // Until every parameter has been read, the specification check of this event waits.
    ...(group.complete ? {} : { capture: { incomplete: true, reason: group.collapsed ? 'testlab_collapsed' : 'testlab_partial' } }) };
  if (kind === 'event') {
    const eventName = item?.key ?? insiderEventName(group.name) ?? (insiderKey(group.name) || 'testlab_event');
    const aliases = [...new Set([group.name, insiderKey(group.name)])].filter(alias => alias && alias !== eventName);
    return { ...base, event_name: eventName, ...(aliases.length ? { aliases } : {}), event_kind: 'business', payload: { event: group.name, default_parameters, custom_parameters } };
  }
  // A user attribute is what the device reported, not an action.
  const key = item?.key ?? (insiderKey(group.name) || 'item');
  return { ...base, event_name: `insider_attribute_${key}`, event_kind: 'observation', payload: { attribute: group.name, value: group.value ?? '' } };
}

/**
 * The view a specification is checked on: each parameter under Insider's key (custom without c_, short
 * default keys in full: usp → unit_sale_price), its text typed by Insider's catalogue (number, boolean,
 * array). Derived from the record, which keeps what Test Lab shows.
 */
export function testLabSpecView(event) {
  const view = { event: event?.payload?.event ?? '', default_parameters: {}, custom_parameters: {} };
  for (const param of event?.testlab?.params ?? []) {
    const [group, name] = String(param.field ?? '').split(/\.(.+)/);
    if (!name || !Object.hasOwn(view, group)) continue;
    view[group][name] = testLabValue(name, param.value, param.data_type);
  }
  return view;
}

// ---- Test Lab against a define file ---------------------------------------------------------------
const normal = text => String(text ?? '').trim().replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
// Every name a parameter goes by: as shown, its key, the key without c_, the short key in full.
function aliases(...names) {
  const out = new Set();
  for (const name of names) {
    if (!name) continue;
    const key = normal(name);
    if (!key) continue;
    out.add(key); out.add(key.replace(/^c_/, '')); out.add(normal(insiderParameterName(key))); out.add(normal(insiderParameterName(key.replace(/^c_/, ''))));
  }
  return out;
}
const isNumber = text => /^-?\d+(?:\.\d+)?$/.test(String(text).trim());
const listOf = text => { const raw = String(text ?? '').trim(); if (/^\[.*\]$/s.test(raw)) { try { const list = JSON.parse(raw); if (Array.isArray(list)) return list.map(String); } catch { /* text list */ } }
  return raw.replace(/^\[|\]$/g, '').split(/\s*,\s*/).map(item => item.replace(/^["']|["']$/g, '')).filter(Boolean); };
const shown = value => value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
// A define value against the text Test Lab shows: same text, the same number, or the same list.
function sameValue(expected, text) {
  const actual = String(text ?? '').trim();
  if (typeof expected === 'string') return expected.trim() === actual;
  if (typeof expected === 'number') return isNumber(actual) && Number(actual) === expected;
  if (typeof expected === 'boolean') return actual === String(expected);
  if (Array.isArray(expected)) { const list = listOf(actual); return list.length === expected.length && expected.every((item, index) => String(item) === list[index]); }
  return expected === null ? actual === '' : shown(expected) === actual;
}
// The type the app sent: what Insider observed when it failed the parameter, else the type its catalogue
// declares (Test Lab accepted it), else what the text looks like.
function sentType(param) {
  const observed = Object.values(param.failed_detail ?? {}).find(detail => detail?.observed_type)?.observed_type;
  const type = observed ?? param.data_type;
  if (type) return type === 'datetime' || type === 'date' ? 'string' : type === 'integer' ? 'number' : type;
  const text = String(param.value ?? '').trim();
  return isNumber(text) ? 'number' : text === 'true' || text === 'false' ? 'boolean' : 'string';
}
const typeFits = (wanted, param) => [].concat(wanted).some(type => type === 'null' ? param.value === '' : ['object', 'array'].includes(type) ? true
  : (type === 'integer' ? 'number' : type) === sentType(param) || (type === 'string' && !param.data_type && !param.failed_detail));
const RULE_TEXT = { eq: value => `= ${shown(value)}`, one_of: value => `một trong ${shown(value)}`, subset: value => `gồm ${shown(value)}`, type: value => `kiểu ${[].concat(value).join(' / ')}`,
  regex: value => `khớp mẫu ${value}`, exists: () => 'có mặt', ref: () => 'có giá trị (thay đổi theo thao tác)', not_exists: () => 'không được có', ignore: () => 'bỏ qua' };

/**
 * Test Lab against the define (specification) row of its event, parameter by parameter: what the define
 * expects, what Test Lab shows, and MATCH / MISMATCH / MISSING (in the define, not in Test Lab) / EXTRA
 * (in Test Lab, not in the define) / UNREAD (not read yet from the table). Fixed values are compared as
 * text; types as the app sent them (Insider's observation or catalogue).
 */
export function defineComparison(event, testCase) {
  if (!event?.testlab || !testCase) return null;
  const rule = testCase.rules?.[0] ?? {}, fields = rule.fields ?? {}, sample = testCase.sample && typeof testCase.sample === 'object' ? testCase.sample : {};
  const expected = new Map();
  const add = (group, key) => {
    const path = `${group}_parameters.${key}`;
    if (!expected.has(path)) expected.set(path, { path, group, key, sample: sample[`${group}_parameters`]?.[key], rule: fields[path], aliases: aliases(key) });
  };
  for (const group of ['default', 'custom']) for (const key of Object.keys(sample[`${group}_parameters`] ?? {})) add(group, key);
  for (const path of Object.keys(fields)) { const match = path.match(/^(default|custom)_parameters\.([^.]+)$/); if (match) add(match[1], match[2]); }
  const rows = [], used = new Set();
  for (const param of event.testlab.params ?? []) {
    const own = aliases(param.name, param.key, String(param.field ?? '').split('.').at(-1));
    const entry = [...expected.values()].find(candidate => !used.has(candidate.path) && [...candidate.aliases].some(alias => own.has(alias)));
    const base = { name: param.name, key: param.key ?? null, actual: param.value, testlab_status: param.status };
    if (!entry) { rows.push({ ...base, path: null, expected: '', rule: '', result: 'EXTRA', note: 'Không có trong define' }); continue; }
    used.add(entry.path);
    const op = entry.rule?.op, value = entry.rule?.value;
    let result = 'MATCH', note = '';
    if (op === 'ignore') note = 'Define bỏ qua tham số này';
    else if (op === 'not_exists') { result = 'MISMATCH'; note = 'Define không cho phép tham số này'; }
    else if (op === 'eq' && !sameValue(value, param.value)) { result = 'MISMATCH'; note = `Mong đợi ${shown(value)}`; }
    else if (op === 'one_of' && !(Array.isArray(value) && value.some(item => sameValue(item, param.value)))) { result = 'MISMATCH'; note = `Mong đợi một trong ${shown(value)}`; }
    else if (op === 'subset') { const list = listOf(param.value); if (![].concat(value).every(item => list.includes(String(item)))) { result = 'MISMATCH'; note = `Phải gồm ${shown(value)}`; } }
    else if (op === 'type' && !typeFits(value, param)) { result = 'MISMATCH'; note = `Define cần kiểu ${[].concat(value).join(' / ')}, app gửi ${sentType(param)}`; }
    else if (op === 'regex') { try { if (!new RegExp(value).test(String(param.value))) { result = 'MISMATCH'; note = `Không khớp mẫu ${value}`; } } catch { /* an unusable pattern is not the app's fault */ } }
    else if ((!op || ['exists', 'ref'].includes(op)) && param.value === '') { result = 'MISMATCH'; note = 'Không có giá trị'; }
    if (param.status === 'failed') {
      const detail = Object.values(param.failed_detail ?? {}).find(item => item?.expected_type);
      result = 'MISMATCH'; note = [note, `Insider Test Lab báo thất bại${detail ? ` (Insider mong đợi ${detail.expected_type}, app gửi ${detail.observed_type ?? '?'})` : ''}`].filter(Boolean).join('; ');
    }
    rows.push({ ...base, path: entry.path, expected: shown(entry.sample), rule: op && RULE_TEXT[op] ? RULE_TEXT[op](value) : '', result, note });
  }
  for (const entry of expected.values()) {
    if (used.has(entry.path) || entry.rule?.op === 'ignore' || entry.rule?.op === 'not_exists' || entry.rule?.optional) continue;
    const unread = Boolean(event.capture?.incomplete);
    rows.push({ name: entry.key, key: null, actual: null, testlab_status: null, path: entry.path, expected: shown(entry.sample), rule: entry.rule?.op && RULE_TEXT[entry.rule.op] ? RULE_TEXT[entry.rule.op](entry.rule.value) : '',
      result: unread ? 'UNREAD' : 'MISSING', note: unread ? 'Chưa đọc tới trong bảng Test Lab' : 'Define có, Test Lab không có' });
  }
  const summary = Object.fromEntries(['MATCH', 'MISMATCH', 'MISSING', 'EXTRA', 'UNREAD'].map(result => [result, rows.filter(row => row.result === result).length]));
  return { case_id: testCase.id, event_name: rule.event_name ?? testCase.name, file: testCase.provenance?.file ?? null, sheet: testCase.provenance?.sheet ?? null, row: testCase.provenance?.row ?? null, rows, summary };
}

// A reading of the reader ({ groups }), or rows of a plain table ({ rows }: an event row then its parameter rows).
function groupsOf(reading) {
  if (Array.isArray(reading?.groups)) return reading.groups.slice(0, 2000).filter(group => group && typeof group === 'object');
  const groups = [];
  for (const row of Array.isArray(reading?.rows) ? reading.rows.slice(0, 2000) : []) {
    if (!row || typeof row !== 'object' || !text(row.name) || !text(row.type)) continue;
    if (/param/i.test(row.type)) groups.at(-1)?.params.push({ ...row, key: null });
    else groups.push({ ...row, group: null, complete: true, params: [] });
  }
  return groups;
}
const cleanParam = param => ({ key: typeof param.key === 'string' && param.key ? param.key.slice(0, 200) : null, name: text(param.name), type: text(param.type), subtype: text(param.subtype),
  value: text(param.value), status: status(param.status), ...(text(param.status_text) ? { status_text: text(param.status_text).slice(0, 100) } : {}) });
const pageOf = url => { try { const parsed = new URL(url); return parsed.origin + parsed.pathname; } catch { return String(url ?? ''); } };

/**
 * Turns successive readings of Test Lab tables into operations on the session: `new` for an event read
 * for the first time, `update` when a later reading completes or changes it. `ref` names the event
 * across readings.
 */
export class TestLabTracker {
  constructor() { this.events = new Map(); this.viewStart = new Map(); this.waiting = new Map(); this.sequence = 0; }
  update(reading, meta = {}, catalog = null) {
    const groups = groupsOf(reading);
    // A table emptied while the panel reloads its data is not a reading.
    if (!groups.length) return [];
    const at = Number.isFinite(Date.parse(meta.at)) ? Date.parse(meta.at) : Date.now();
    const view = `${meta.targetId ?? ''}|${pageOf(meta.url)}`;
    if (!this.viewStart.has(view)) this.viewStart.set(view, at);
    const historical = at - this.viewStart.get(view) <= HISTORY_MS;
    const touched = new Set(), occurrences = new Map();
    for (const raw of groups) {
      const group = { group: raw.group === null || raw.group === undefined ? null : String(raw.group).slice(0, 100), name: text(raw.name), type: text(raw.type), subtype: text(raw.subtype),
        value: text(raw.value), status: status(raw.status), status_text: text(raw.status_text).slice(0, 100), complete: Boolean(raw.complete), collapsed: Boolean(raw.collapsed),
        params: (Array.isArray(raw.params) ? raw.params.slice(0, 500) : []).filter(param => param && typeof param === 'object').map(cleanParam).filter(param => param.name) };
      let id;
      if (group.group !== null) id = `${view}|#${group.group}`;
      else {
        // A table without receipt numbers: identical rows are counted, so each receipt is one event.
        const values = JSON.stringify([group.name, group.type, group.subtype, group.value, group.params.map(param => [param.name, param.subtype, param.value])]);
        const seen = occurrences.get(values) ?? 0; occurrences.set(values, seen + 1);
        id = `${view}|=${values}#${seen}`;
      }
      let state = this.events.get(id);
      if (!group.name) {
        // Parameters whose event row is scrolled away: kept for that event.
        if (state) this.#merge(state, group); else this.waiting.set(id, [...(this.waiting.get(id) ?? []), ...group.params]);
        if (state) touched.add(state);
        continue;
      }
      // The same number under another event name: the panel started a new test, this is another receipt.
      if (state && state.name !== group.name) { this.events.delete(id); state = null; }
      if (!state) {
        state = { ref: `TESTLAB-${++this.sequence}`, group: group.group, name: group.name, type: group.type, subtype: group.subtype, value: group.value, status: group.status, status_text: group.status_text,
          complete: false, collapsed: false, params: new Map(), historical, emitted: null };
        for (const param of this.waiting.get(id) ?? []) state.params.set(param.key ?? `name:${param.name}`, param);
        this.waiting.delete(id);
        this.events.set(id, state);
      }
      Object.assign(state, { type: group.type || state.type, subtype: group.subtype || state.subtype, value: group.value, status: group.status, status_text: group.status_text, collapsed: group.collapsed });
      this.#merge(state, group);
      if (group.complete) state.complete = true;
      touched.add(state);
    }
    const ops = [];
    for (const state of touched) {
      const event = { ...testLabEvent({ ...state, params: [...state.params.values()] }, { ...meta, catalog, reader: reading?.reader }), historical: state.historical };
      const signature = JSON.stringify([event.event_name, event.payload, event.testlab, event.capture ?? null]);
      if (signature === state.emitted) continue;
      ops.push({ ref: state.ref, op: state.emitted === null ? 'new' : 'update', event });
      state.emitted = signature;
    }
    return ops;
  }
  #merge(state, group) {
    // Parameters keep the order they were first seen in; a later reading updates their value and status.
    for (const param of group.params) state.params.set(param.key ?? `name:${param.name}`, param);
  }
}
