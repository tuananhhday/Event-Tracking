import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSON5 from 'json5';
import Ajv from 'ajv';
import JSZip from 'jszip';
import { sensitivePath } from './sanitize.mjs';

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
        event_name: { type: 'string', minLength: 1 }, event_aliases: { type: 'array', items: { type: 'string', minLength: 1 } }, source: { type: 'string' }, layer: { enum: ['JS_QUEUE', 'TRACKING_REQUEST'] },
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
  event: ['eventname', 'tenevent', 'event'], description: ['eventdescription', 'description', 'mota', 'triggerpointtrenapp'],
  sample: ['datalayersample', 'sample', 'payloadsample', 'payload', 'insiderqueuesample', 'chitietevent', 'eventdetails', 'samplepayloadapp', 'samplepayload'], note: ['note', 'notes', 'ghichu'],
  parameter_notes: ['chitietparam', 'diengiaiparam'], sdk_notes: ['cachfireinsidermobilesdk'],
  rules: ['rules', 'expectedrules', 'rulejson'],
};

function text(cell) {
  if (!cell) return '';
  const value = cell.value;
  if (value && typeof value === 'object' && 'result' in value) return String(value.result ?? '');
  return cell.text ?? String(value ?? '');
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

/**
 * Lenient reader for workbook samples written by people: leading prose, `//` comments,
 * several objects in one cell, `Insider.eventManager.dispatch(...)` calls, unquoted
 * placeholder values and samples cut off mid-object. Still parses data only (JSON5).
 */
export function extractSamples(input) {
  const source = String(input ?? '').split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  const blocks = [];
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
    if (end === -1) break;
    start = source.indexOf('{', end + 1);
  }
  const parsed = [];
  for (const block of blocks) {
    const attempts = [block, block.replace(/:\s*undefined\b/g, ': null')];
    // `key: Slug của trang (...)` placeholders become strings.
    attempts.push(attempts[1].replace(/^(\s*"?[\w.$-]+"?\s*:\s*)(?!["'{[\-\d]|true\b|false\b|null\b)([^\n]*?)\s*(,?)\s*$/gm, (_, key, value, comma) => `${key}${JSON.stringify(value)}${comma}`));
    for (const attempt of attempts) {
      try { const value = parseSample(attempt); if (value && typeof value === 'object' && !Array.isArray(value)) { parsed.push(value); break; } } catch { /* next attempt */ }
    }
  }
  return parsed;
}
// The object in a cell that describes this row's event, when a cell holds several.
function sampleFor(eventName, samples) {
  const names = sample => [sample.event, sample.event_name, sample.value?.[0]?.event_name, sample.events?.[0]?.event_name].filter(Boolean);
  return samples.find(sample => names(sample).includes(eventName)) ?? samples[0];
}
// Insider request bodies ({partner, events: [{event_name, event_params}]}) as the decoder flattens them.
function requestShape(sample) {
  if (typeof sample?.event_name === 'string' && sample.event_params && typeof sample.event_params === 'object' && !Array.isArray(sample.event_params)) return sample;
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
      if (sensitivePath(fieldPath)) fields[fieldPath] = { op: 'exists' };
      else if (key.startsWith('gtm.') || key.startsWith('gtag.') || ignoredKeys.has(key)) fields[fieldPath] = { op: 'ignore' };
      else if (fixed.has(key) && (!prefix || /^value\.0$/.test(prefix)) && typeof value === 'string') fields[fieldPath] = { op: 'eq', value };
      else if (dynamicRefs[key] && !prefix) fields[fieldPath] = { op: 'ref', value: dynamicRefs[key] };
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
async function readWorkbook(file) {
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
    let header;
    let columns;
    for (let index = 1; index <= Math.min(worksheet.rowCount, 50); index++) {
      const mapping = {};
      worksheet.getRow(index).eachCell((cell, column) => {
        const name = normalized(text(cell));
        for (const [key, values] of Object.entries(aliases)) if (values.includes(name)) mapping[key] = column;
      });
      if (mapping.event) { header = index; columns = mapping; break; }
    }
    if (!header) { warnings.push(`${worksheet.name}: no Event Name header found.`); continue; }
    for (let rowNumber = header + 1; rowNumber <= worksheet.rowCount; rowNumber++) {
      const row = worksheet.getRow(rowNumber);
      const get = key => columns[key] ? text(row.getCell(columns[key])).trim() : '';
      const eventName = get('event');
      if (!eventName) continue;
      // Sheets without a platform column (e.g. an "...Insider..." workbook) take it from the file or sheet name.
      const platform = get('source') || `${path.basename(absolute)} ${worksheet.name}`;
      const source = /insider/i.test(platform) ? 'INSIDER' : /ga4|google/i.test(platform) ? 'GA4' : 'CUSTOM';
      const provenance = { file: absolute, sheet: worksheet.name, row: rowNumber };
      const caseId = `TC-${normalized(worksheet.name).slice(0, 30)}-${get('id').replace(/[^a-zA-Z0-9_-]/g, '') || rowNumber}-${rowNumber}`;
      const testCase = { id: caseId, name: [get('flow'), eventName].filter(Boolean).join(' / '), source, flow: get('flow'), stt: get('id'), description: get('description'), notes: get('note'), provenance, needs_review: true, rules: [] };
      const sampleHeader = columns.sample ? normalized(text(worksheet.getRow(header).getCell(columns.sample))) : '';
      const triggerHeader = columns.description ? normalized(text(worksheet.getRow(header).getCell(columns.description))) : '';
      if (sampleHeader === 'samplepayloadapp' || triggerHeader === 'triggerpointtrenapp') testCase.target_platform = 'APP';
      else if (sampleHeader === 'datalayersample' || sampleHeader === 'insiderqueuesample') testCase.target_platform = 'WEB';
      testCase.parameter_notes = get('parameter_notes'); testCase.sdk_notes = get('sdk_notes');
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
      let payload = {};
      try { payload = parseSample(get('sample')); }
      catch (error) {
        const samples = extractSamples(get('sample'));
        if (samples.length) payload = sampleFor(eventName, samples);
        else if (get('sample')) warnings.push(`${worksheet.name}!${rowNumber}: sample could not be parsed safely (${error.message}).`);
      }
      const request = requestShape(payload);
      const queueNames = { home: 'homepage_view', category: 'listing_page_view', product: 'product_detail_page_view', cart: 'cart_page_view', purchase: 'confirmation_page_view', add_to_cart: 'add_to_cart', remove_from_cart: 'remove_from_cart' };
      const sampleEventName = source === 'INSIDER' ? queueNames[payload?.type] : null;
      if (sampleEventName && sampleEventName !== eventName && eventName.replaceAll(' ', '_') !== sampleEventName) {
        testCase.sample_conflict = true;
        testCase.spec_conflicts = [{ code: 'SAMPLE_EVENT_CONFLICT', message: `Event Name là ${eventName} nhưng sample type=${payload.type} mô tả ${sampleEventName}.`, sheet: worksheet.name, row: rowNumber }];
        warnings.push(`${worksheet.name}!${rowNumber}: sample type=${payload.type} không khớp Event Name ${eventName}; cần kiểm tra yêu cầu trước khi kết luận website.`);
      }
      // AppOTA exports use display names and default/custom parameters. Preserve that
      // contract verbatim; it is not an InsiderQueue payload or a GA4 event literal.
      const parameterExport = payload.default_parameters && payload.custom_parameters && typeof payload.event === 'string';
      if (/^AppOTA$/i.test(String(payload.custom_parameters?.platform || payload.default_parameters?.platform || ''))) testCase.target_platform = 'APP';
      const inferred = inferredFields(request ?? payload);
      if (parameterExport) {
        // These identify the platform/product family, unlike device, price or date examples.
        for (const group of ['default_parameters', 'custom_parameters']) {
          for (const key of ['platform', 'currency']) {
            if (typeof payload[group]?.[key] === 'string') inferred.fields[`${group}.${key}`] = { op: 'eq', value: payload[group][key] };
          }
          if (Array.isArray(payload[group]?.taxonomy) && payload[group].taxonomy.length) inferred.fields[`${group}.taxonomy`] = { op: 'subset', value: payload[group].taxonomy };
        }
      }
      if (!Object.hasOwn(inferred.fields, 'event') && source === 'GA4') inferred.fields.event = { op: 'eq', value: eventName };
      // The Event Name column is authoritative when a pasted sample belongs to another event.
      for (const key of ['event', 'event_name', 'value.0.event_name']) {
        const field = inferred.fields[key];
        if (!parameterExport && field?.op === 'eq' && field.value !== eventName) { warnings.push(`${worksheet.name}!${rowNumber}: sample is for "${field.value}", not "${eventName}".`); field.value = eventName; }
      }
      testCase.rules = [{ event_name: eventName, source, layer: request || parameterExport ? 'TRACKING_REQUEST' : 'JS_QUEUE', count: { min: 1, max: 1 }, fields: inferred.fields, needs_review: true,
        ...(parameterExport ? { event_aliases: [payload.event] } : {}) }];
      testCase.sample = payload;
      testCase.sample_text = get('sample');
      testCase.sample_available = Object.keys(payload).length > 0;
      if (parameterExport) {
        testCase.payload_format = 'default_custom_parameters';
        warnings.push(`${worksheet.name}!${rowNumber}: mẫu default_parameters/custom_parameters (AppOTA); website phải phát đúng cấu trúc này mới đối chiếu được. Không tự chuyển InsiderQueue sang payload AppOTA.`);
      }
      if (!get('sample')) warnings.push(`${worksheet.name}!${rowNumber}: không có chi tiết payload; chưa đủ dữ liệu để xác nhận khớp trường.`);
      validateTestCase(testCase);
      cases.push(testCase);
      warnings.push(`${worksheet.name}!${rowNumber}: draft rule; confirm trigger, dynamic context and network mapping before acceptance.`);
    }
  }
  if (!cases.length) warnings.push('No specification cases were found.');
  return { cases, warnings };
}
