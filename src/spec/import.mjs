import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSON5 from 'json5';
import Ajv from 'ajv';
import JSZip from 'jszip';
import { parseInsiderSample } from './insider-sample.mjs';
import { INSIDER_TYPE_EVENTS, INSIDER_OBJECT_PAGES } from '../core/event-kind.mjs';

const fieldSchema = {
  type: 'object', required: ['op'], additionalProperties: true,
  properties: {
    op: { enum: ['eq', 'exists', 'not_exists', 'type', 'regex', 'one_of', 'range', 'ref', 'subset', 'ignore'] },
    value: {}, optional: { type: 'boolean' },
  },
  allOf: [
    { if: { properties: { op: { enum: ['eq', 'type', 'regex', 'one_of', 'range', 'ref', 'subset'] } } }, then: { required: ['value'] } },
    { if: { properties: { op: { const: 'ref' } } }, then: { properties: { value: { type: 'string', pattern: '^context\\.' } } } },
    { if: { properties: { op: { const: 'regex' } } }, then: { properties: { value: { type: 'string', maxLength: 512 } } } },
    { if: { properties: { op: { const: 'one_of' } } }, then: { properties: { value: { type: 'array' } } } },
  ],
};

export const caseSchema = {
  type: 'object', required: ['id', 'name', 'rules'], additionalProperties: true,
  properties: {
    id: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 }, source: { type: 'string' }, flow: { type: 'string' }, needs_review: { type: 'boolean' },
    rules: { type: 'array', items: {
      type: 'object', required: ['event_name', 'layer', 'fields'], additionalProperties: true,
      properties: {
        event_name: { type: 'string', minLength: 1 }, source: { type: 'string' }, layer: { enum: ['JS_QUEUE', 'TRACKING_REQUEST'] },
        needs_review: { type: 'boolean' }, within_ms: { type: 'number', minimum: 0 }, after: { type: 'string' },
        count: { type: 'object', required: ['min', 'max'], properties: { min: { type: 'integer', minimum: 0 }, max: { type: 'integer', minimum: 0 } }, additionalProperties: false },
        fields: { type: 'object', additionalProperties: fieldSchema },
      },
    } },
  },
};
const validate = new Ajv({ allErrors: true, strict: false }).compile(caseSchema);

export function validateTestCase(value) {
  if (!validate(value)) throw new Error(`Invalid test case: ${validate.errors.map(error => `${error.instancePath || '/'} ${error.message}`).join('; ')}`);
  for (const rule of value.rules) {
    if (rule.count && rule.count.min > rule.count.max) throw new Error('Invalid count: min is greater than max.');
    for (const field of Object.values(rule.fields)) if (field.op === 'regex') {
      try { new RegExp(field.value); } catch { throw new Error('Invalid regular expression in rule.'); }
    }
  }
  return value;
}

const normalized = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases = {
  id: ['stt', 'id', 'testcaseid'], source: ['nentang', 'platform', 'source'], flow: ['luong', 'flow'],
  event: ['eventname', 'tenevent', 'event'], description: ['eventdescription', 'description', 'mota'],
  sample: ['datalayersample', 'sample', 'payloadsample', 'payload', 'insiderqueuesample', 'samplepayload', 'samplepayloadapp', 'chitietevent',
    'datalayer', 'samplevaluejson', 'newdatalayersample', 'newsamplepayload', 'sampledatalayer', 'sampledatalayermoi'],
  // Change sheets keep the previous sample beside the new one; it is read only when the new cell is empty.
  sample_old: ['olddatalayersample', 'oldsamplepayload', 'sampledatalayercu'], note: ['note', 'notes', 'ghichu'],
  trigger: ['trigger', 'triggercondition', 'dieukienkichhoat', 'thoidiemban', 'thoidiembanevent', 'triggerpoint', 'triggerpointtrenapp'],
  sdk: ['sdk', 'sdkmethod', 'insidersdk', 'sdkmethodapp', 'cachfireinsidermobilesdk'], parameter_notes: ['giaithichthamso', 'chitietthamso', 'parameterdescription', 'diengiaiparam'],
  rules: ['rules', 'expectedrules', 'rulejson'],
};

function text(cell) {
  if (!cell) return '';
  // A merged cell reads its master; ExcelJS throws on `.text` when that master is empty.
  if (cell.isMerged && cell.master !== cell) return text(cell.master);
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && 'result' in value) return String(value.result ?? '');
  return cell.text ?? String(value);
}

/** Parse data literals only; never execute workbook JavaScript. */
export function parseSample(input) {
  let value = String(input ?? '').trim().replace(/^```(?:javascript|js|json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!value) return {};
  const wrapper = value.match(/^(?:(?:window\.)?(?:dataLayer|InsiderQueue)\.push)\s*\(([\s\S]*)\)\s*;?$/);
  if (wrapper) value = wrapper[1].trim();
  // Some supplied samples write unquoted GA/GTM dotted property names.
  value = value.replace(/([{,]\s*)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*:/g, '$1"$2":');
  const parsed = JSON5.parse(value);
  if (parsed === null || typeof parsed !== 'object') throw new Error('Sample must be an object or array.');
  return parsed;
}

// Slips in hand-typed samples: lines that are only "..." placeholders, a doubled quote around a
// value (`"abc"",` / `""https://…"`), an unquoted date, a note in parentheses or a `-- note` after
// a value, `;` instead of `,`, and a missing comma before the next property. An empty string `""`
// stays as it is. Structural mistakes (a missing bracket) are left for the import warning.
function repairSample(sample) {
  return sample
    .replace(/^[\s.,…]*(?:\.\.\.|…)[\s.,…]*$/gm, '')
    .replace(/([^\s:"])""(?=\s*[,}\]\n])/g, '$1"')
    .replace(/:(\s*)""(?=[^\s,}\]"])/g, ':$1"')
    .replace(/:(\s*)(\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?)(?=\s*[,}\n])/g, ':$1"$2"')
    .replace(/,[ \t]*\([^\n]*$/gm, ',')
    .replace(/[ \t]+--[^\n]*$/gm, '')
    .replace(/;[ \t]*$/gm, ',')
    .replace(/(["'\d\]}]|\btrue|\bfalse|\bnull)([ \t]*\r?\n\s*)(?=["']?[A-Za-z_$][\w$.-]*["']?\s*:)/g, '$1,$2');
}

/**
 * Lenient reader for workbook samples written by people: leading prose, `//` comments,
 * several objects in one cell, `Insider.eventManager.dispatch(...)` calls, unquoted
 * placeholder values, typing slips (see repairSample), a cell that starts at the first property
 * instead of `{`, and samples cut off mid-object. Still parses data only (JSON5).
 */
export function extractSamples(input) {
  let source = String(input ?? '').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  // A cell pasted from CSV: wrapped in quotes with every inner quote doubled.
  if (/^\s*"[{[]/.test(source) && source.includes('""')) source = source.trim().replace(/^"|"$/g, '').replace(/""/g, '"');
  if (/^\s*(["'])[A-Za-z_$][\w$]*\1\s*:/.test(source)) source = `{${source}}`;
  const first = readBlocks(source);
  if (first.complete) return first.parsed;
  // Slips such as a doubled quote also derail finding where an object ends; read the repaired
  // text too and keep whichever result holds more data.
  const repaired = readBlocks(repairSample(source));
  return JSON.stringify(repaired.parsed).length > JSON.stringify(first.parsed).length ? repaired.parsed : first.parsed;
}

function readBlocks(source) {
  const blocks = [];
  let complete = true;
  for (let start = source.indexOf('{'); start !== -1 && blocks.length < 20;) {
    const stack = []; let quote = null, end = -1, lastComma = null;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
      else if (ch === '}' || ch === ']') { stack.pop(); if (!stack.length) { end = i; break; } }
      else if (ch === ',') lastComma = { index: i, closers: stack.slice().reverse().join('') };
    }
    // A truncated sample keeps every complete field: cut at the last complete element, then close.
    blocks.push(end !== -1 ? source.slice(start, end + 1) : lastComma ? source.slice(start, lastComma.index) + lastComma.closers : source.slice(start) + stack.reverse().join(''));
    if (end === -1) { complete = false; break; }
    start = source.indexOf('{', end + 1);
  }
  const parsed = [];
  for (const block of blocks) {
    const attempts = [block, block.replace(/:\s*undefined\b/g, ': null')];
    // `key: Slug của trang (...)` placeholders become strings.
    attempts.push(attempts[1].replace(/^(\s*"?[\w.$-]+"?\s*:\s*)(?!["'{[\-\d]|true\b|false\b|null\b)([^\n]*?)\s*(,?)\s*$/gm, (_, key, value, comma) => `${key}${JSON.stringify(value)}${comma}`));
    attempts.push(repairSample(attempts[1]), repairSample(attempts[2]));
    const value = attempts.map(attempt => { try { return parseSample(attempt); } catch { return null; } }).find(item => item && typeof item === 'object' && !Array.isArray(item));
    if (value) parsed.push(value); else complete = false;
  }
  return { parsed, complete };
}
// The object in a cell that describes this row's event, when a cell holds several.
// Insider pushes are named by `type` ({type:'cart'} is cart_page_view) or by insider_object's page type.
function sampleFor(names, samples) {
  const namesOf = sample => [sample.event, sample.event_name, sample.value?.[0]?.event_name, sample.events?.[0]?.event_name,
    INSIDER_TYPE_EVENTS[sample.type], sample.transaction ? 'confirmation_page_view' : INSIDER_OBJECT_PAGES[String(sample.page?.type ?? '').toLowerCase()]].filter(Boolean);
  // GTM's `{ecommerce: null}` clear push precedes the event in GA4 cells; it is never the event itself.
  return samples.find(sample => namesOf(sample).some(name => names.includes(name)))
    ?? samples.find(sample => !(Object.keys(sample).length === 1 && sample.ecommerce === null));
}
// Event Name cells read "03. view_item_list", "product_detail_page_view (Hotel)" or
// "purchase / confirmation_page_view": numbering and the flow note are not part of the name.
function eventNames(cell) {
  return [...new Set(String(cell).replace(/\([^)]*\)/g, ' ').split(/[/,\n]/)
    // App SDK sheets use Insider's display names ("Listing Page View"), so words may be spaced;
    // test logs append what was tested ('Cart Page View "Gói Shopping"'), which is not the name.
    .map(name => name.trim().replace(/^\d+[.)]\s*/, '').match(/^[A-Za-z][\w.:-]*(?: [A-Za-z0-9][\w.:-]*(?=\s|$))*/)?.[0] ?? '')
    .filter(name => name.length >= 3))];
}

// Insider request bodies ({partner, events: [{event_name, event_params}]}) as the decoder flattens them.
function requestShape(sample) {
  if (!Array.isArray(sample?.events) || !sample.events[0]?.event_params) return null;
  const { events, ...rest } = sample;
  return { ...rest, ...events[0] };
}

const dynamicRefs = {
  search_term: 'context.search.term', destination: 'context.search.destination_name', destination_id: 'context.search.destination_id',
  service_start_date: 'context.search.start_date', service_end_date: 'context.search.end_date', service_duration: 'context.search.nights',
  quantity_adult: 'context.search.adults', quantity_child: 'context.search.children', quantity_infant: 'context.search.infants', quantity: 'context.search.quantity',
};
// search_source is not fixed: specs allow several entry points (home, header, listing...).
const fixed = new Set(['event', 'service', 'event_name', 'type']);
// Insider's own bookkeeping flag, not part of the tracking contract.
const ignoredKeys = new Set(['processed']);
function inferredFields(payload) {
  const fields = {};
  let uncertain = false;
  const visit = (object, prefix = '') => {
    for (const [key, value] of Object.entries(object)) {
      const fieldPath = prefix ? `${prefix}.${key}` : key;
      if (key.startsWith('gtm.') || key.startsWith('gtag.') || ignoredKeys.has(key)) fields[fieldPath] = { op: 'ignore' };
      else if (fixed.has(key) && (!prefix || /^value\.0$/.test(prefix)) && typeof value === 'string') fields[fieldPath] = { op: 'eq', value };
      else if (dynamicRefs[key] && !prefix && value !== null) fields[fieldPath] = { op: 'ref', value: dynamicRefs[key] };
      else if (value !== null && typeof value === 'object' && !Array.isArray(value)) visit(value, fieldPath);
      // Lists (ecommerce.items, Insider value[]) are checked through their first element.
      else if (Array.isArray(value) && value.length && value[0] && typeof value[0] === 'object' && !Array.isArray(value[0])) {
        fields[fieldPath] = { op: 'type', value: 'array' };
        visit(value[0], `${fieldPath}.0`);
      }
      else {
        // A null in a sample means "value not known when the sample was taken": the field must be
        // present, with any value.
        fields[fieldPath] = { op: 'type', value: value === null ? ['null', 'string', 'number', 'boolean', 'object', 'array'] : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value };
        uncertain = true;
      }
    }
  };
  if (payload && !Array.isArray(payload)) visit(payload);
  else uncertain = true;
  return { fields, uncertain };
}

// ExcelJS rejects some Excel Tables (filter buttons on unnamed columns). Table
// definitions only carry formatting/filters, so retry without them.
export async function readWorkbook(file) {
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.readFile(file); return workbook; }
  catch (error) {
    const zip = await JSZip.loadAsync(await fs.readFile(file));
    const tables = Object.keys(zip.files).filter(name => /^xl\/tables\/[^/]+\.xml$/i.test(name));
    if (!tables.length) throw error;
    for (const name of tables) zip.remove(name);
    for (const name of Object.keys(zip.files).filter(name => /^xl\/worksheets\/[^/]+\.xml$/i.test(name))) {
      zip.file(name, (await zip.file(name).async('string')).replace(/<tableParts[\s\S]*?<\/tableParts>|<tableParts[^>]*\/>/g, ''));
    }
    for (const name of Object.keys(zip.files).filter(name => /^xl\/worksheets\/_rels\/[^/]+\.rels$/i.test(name))) {
      zip.file(name, (await zip.file(name).async('string')).replace(/<Relationship[^>]*relationships\/table"[^>]*\/>/g, ''));
    }
    const types = await zip.file('[Content_Types].xml').async('string');
    zip.file('[Content_Types].xml', types.replace(/<Override[^>]*PartName="\/xl\/tables\/[^"]*"[^>]*\/>/g, ''));
    const retry = new ExcelJS.Workbook();
    await retry.xlsx.load(await zip.generateAsync({ type: 'nodebuffer' }));
    return retry;
  }
}

export async function specSheets(file) {
  const workbook = await readWorkbook(file);
  return workbook.worksheets.map(sheet => ({ name: sheet.name, rows: sheet.rowCount }));
}

export async function importSpec(filePath, { sheet } = {}) {
  const absolute = path.resolve(filePath);
  const extension = path.extname(absolute).toLowerCase();
  const warnings = [];
  if (extension === '.json') {
    const data = JSON.parse(await fs.readFile(absolute, 'utf8'));
    const cases = Array.isArray(data) ? data : data.cases;
    if (!Array.isArray(cases)) throw new Error('JSON spec must contain a cases array.');
    const seen = new Set();
    for (const testCase of cases) {
      validateTestCase(testCase);
      if (seen.has(testCase.id)) throw new Error(`Duplicate test case ID: ${testCase.id}`);
      seen.add(testCase.id);
      testCase.provenance ??= { file: absolute, sheet: null, row: null };
    }
    return { cases, warnings };
  }
  if (extension !== '.xlsx') throw new Error('Supported specifications: .json or .xlsx.');
  const workbook = await readWorkbook(absolute);
  const preferred = sheet ? workbook.getWorksheet(sheet) : workbook.getWorksheet('Tổng hợp Event tracking');
  if (sheet && !preferred) throw new Error(`Sheet not found: ${sheet}`);
  const worksheets = preferred ? [preferred] : workbook.worksheets;
  const cases = [];
  for (const worksheet of worksheets) {
    // A sheet can hold several tables (a guide's explanations, its event table, then a parameter
    // dictionary). A header row has an Event column plus another known column; a table ends at the
    // next header row. Tables with samples or rules are the event contract.
    const headers = [];
    for (let index = 1; index <= worksheet.rowCount; index++) {
      const mapping = {};
      worksheet.getRow(index).eachCell((cell, column) => {
        const name = normalized(text(cell));
        for (const [key, values] of Object.entries(aliases)) if (values.includes(name)) mapping[key] = column;
      });
      if (mapping.event && Object.keys(mapping).length >= 2) headers.push({ header: index, columns: mapping });
    }
    if (!headers.length) { warnings.push(`${worksheet.name}: no Event Name header found; skipped.`); continue; }
    // Execution logs, parameter dictionaries and profile attributes are not an event contract:
    // even an explicitly selected sheet needs a sample or rules column.
    const tables = headers.filter(({ columns }) => columns.sample || columns.sample_old || columns.rules);
    if (!tables.length || (!sheet && /(?:^|[\s_-])(?:test|uat|failed|adjust)(?:[\s_-]|$)/i.test(worksheet.name))) {
      warnings.push(`${worksheet.name}: not a source event specification; skipped.`); continue;
    }
    for (const { header, columns } of tables) {
      const end = headers.find(table => table.header > header)?.header ?? worksheet.rowCount + 1;
      for (let rowNumber = header + 1; rowNumber < end; rowNumber++) {
        const row = worksheet.getRow(rowNumber);
        const get = key => columns[key] ? text(row.getCell(columns[key])).trim() : '';
        const names = eventNames(get('event'));
        if (!names.length) continue;
        const [eventName] = names;
        const flow = get('flow') || get('event').match(/\(([^)]+)\)/)?.[1]?.trim() || '';
        // Sheets without a platform column (e.g. an "...Insider..." workbook) take it from the file or sheet name.
        const platform = get('source') || `${path.basename(absolute)} ${worksheet.name}`;
        const source = /insider/i.test(platform) ? 'INSIDER' : /ga4|google/i.test(platform) ? 'GA4' : 'CUSTOM';
        const provenance = { file: absolute, sheet: worksheet.name, row: rowNumber };
        const caseId = `TC-${normalized(worksheet.name).slice(0, 30)}-${get('id').replace(/[^a-zA-Z0-9_-]/g, '') || rowNumber}-${rowNumber}`;
        const testCase = { id: caseId, name: [flow, eventName].filter(Boolean).join(' / '), source, flow, stt: get('id'), description: get('description'), notes: get('note'), provenance, needs_review: true, rules: [] };
        testCase.trigger = get('trigger');
        testCase.sdk_method = get('sdk');
        testCase.parameter_notes = get('parameter_notes');
        if (get('rules')) {
          try {
            const rules = JSON5.parse(get('rules'));
            testCase.rules = Array.isArray(rules) ? rules : [rules];
            testCase.needs_review = testCase.rules.some(rule => rule.needs_review);
            validateTestCase(testCase);
            cases.push(testCase);
            continue;
          } catch (error) { warnings.push(`${worksheet.name}!${rowNumber}: invalid explicit rules (${error.message}); imported as draft.`); }
        }
        // A new-sample cell without a payload ("Không đổi" = unchanged) means the old sample still applies.
        const sampleSource = /[{[]/.test(get('sample')) || !get('sample_old') ? get('sample') : get('sample_old');
        const appContract = source === 'INSIDER' && (/samplepayloadapp|chitietevent/.test(normalized(text(worksheet.getRow(header).getCell(columns.sample || 1)))) || /(?:tagEvent|visitProductDetailPage|default_parameters|custom_parameters)/.test(sampleSource));
        let payload = {}, sampleImport;
        if (appContract) {
          sampleImport = parseInsiderSample(sampleSource, eventName);
          payload = sampleImport.payload ?? {};
          testCase.capture_platform = 'APP_SDK';
          testCase.sample_source = sampleSource;
          testCase.event_label = payload.event ?? eventName;
        } else {
          try { payload = parseSample(sampleSource); }
          catch (error) {
            const chosen = sampleFor(names, extractSamples(sampleSource));
            if (chosen) payload = chosen;
            else if (sampleSource) warnings.push(`${worksheet.name}!${rowNumber}: sample could not be parsed safely (${error.message}).`);
          }
          sampleImport = { format: 'json', status: Object.keys(payload).length ? 'complete' : 'unparsed', warnings: Object.keys(payload).length ? [] : ['No structured payload was extracted.'] };
        }
        const { payload: _parsedPayload, records, ...sampleMetadata } = sampleImport;
        testCase.sample_import = sampleMetadata;
        if (records?.length) testCase.sample_variants = records;
        if (!testCase.sdk_method && sampleImport.sdk_method) testCase.sdk_method = sampleImport.sdk_method;
        const request = requestShape(payload);
        const inferred = inferredFields(request ?? payload);
        if (appContract && sampleImport.format === 'json') {
          for (const group of ['default_parameters', 'custom_parameters']) {
            for (const key of ['platform', 'currency']) if (typeof payload[group]?.[key] === 'string') inferred.fields[`${group}.${key}`] = { op: 'eq', value: payload[group][key] };
            if (Array.isArray(payload[group]?.taxonomy) && payload[group].taxonomy.length) inferred.fields[`${group}.taxonomy`] = { op: 'subset', value: payload[group].taxonomy };
          }
        }
        if (!Object.hasOwn(inferred.fields, 'event') && source === 'GA4') inferred.fields.event = { op: 'eq', value: eventName };
        // The Event Name column is authoritative when a pasted sample belongs to another event.
        for (const key of appContract ? [] : ['event', 'event_name', 'value.0.event_name']) {
          const field = inferred.fields[key];
          if (field?.op === 'eq' && !names.includes(field.value)) { warnings.push(`${worksheet.name}!${rowNumber}: sample is for "${field.value}", not "${eventName}".`); field.value = eventName; }
        }
        testCase.rules = [{ event_name: eventName, source, layer: request || appContract && sampleImport.format === 'json' ? 'TRACKING_REQUEST' : 'JS_QUEUE', count: { min: 1, max: 1 }, fields: inferred.fields, needs_review: true,
          ...(names.length > 1 || appContract && payload.event ? { event_aliases: [...new Set([...names.slice(1), ...(appContract && payload.event ? [payload.event] : [])])] } : {}),
          ...(appContract ? { capture_platform: 'APP_SDK' } : {}), sample_status: sampleImport.status }];
        testCase.sample = appContract && !sampleImport.payload ? null : payload;
        testCase.sample_text = sampleSource;
        testCase.sample_available = Boolean(testCase.sample && Object.keys(testCase.sample).length);
        validateTestCase(testCase);
        cases.push(testCase);
        warnings.push(`${worksheet.name}!${rowNumber}: draft rule; confirm trigger, dynamic context and network mapping before acceptance.`);
      }
    }
  }
  if (!cases.length) warnings.push('No specification cases were found.');
  return { cases, warnings };
}
