// A define file for the app: what each app event must carry, to compare with what Insider's Test Lab
// shows. Two shapes are read:
//  - a specification sheet written for the app (AppOTA_Insider, R1511…: one event per row with its sample
//    as JSON, SDK code or the text copied from Insider), read by the specification importer;
//  - a table with one parameter per row (Event · Tham số · Loại · Giá trị mong đợi · Kiểu dữ liệu ·
//    Bắt buộc), the template EventQA offers. A value given is expected exactly; otherwise its type.
// The sheet with the most app events wins. The cases are marked as the define (provenance.define) so a
// new define replaces the old one without touching the website's specification.
import path from 'node:path';
import ExcelJS from 'exceljs';
import { importSpec, readWorkbook, manualCase, validateTestCase } from './import.mjs';
import { insiderEventName } from '../core/insider-hit.mjs';

const fold = text => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '');
const COLUMNS = {
  event: ['event', 'eventname', 'tenevent', 'sukien', 'tensukien'],
  param: ['thamso', 'param', 'parameter', 'parametername', 'tenthamso', 'key', 'field', 'truong'],
  group: ['loai', 'type', 'defaultcustom', 'nhom', 'group', 'loaithamso'],
  value: ['giatrimongdoi', 'giatri', 'value', 'expectedvalue', 'sample', 'samplevalue', 'giatrimau'],
  datatype: ['kieudulieu', 'kieu', 'datatype', 'dulieu'],
  required: ['batbuoc', 'required', 'mandatory'],
  flow: ['luong', 'flow'],
  note: ['ghichu', 'note', 'notes', 'mota', 'description'],
};
const keyFor = label => String(label).trim().replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
function cellText(cell) {
  if (!cell) return '';
  if (cell.isMerged && cell.master !== cell) return cellText(cell.master);
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && 'result' in value) return String(value.result ?? '');
  if (typeof value === 'object' && Array.isArray(value.richText)) return value.richText.map(part => part.text).join('');
  return String(cell.text ?? value).trim();
}
// A value as written in the define, typed by its declared data type.
function typed(text, type) {
  const raw = String(text ?? '').trim();
  if (/^(?:number|integer|int|float|double|so)$/.test(fold(type))) { const plain = raw.replace(/,/g, ''); return /^-?\d+(?:\.\d+)?$/.test(plain) ? Number(plain) : raw; }
  if (/^(?:boolean|bool)$/.test(fold(type))) return raw === 'true' ? true : raw === 'false' ? false : raw;
  if (/^(?:array|list|stringarray|mang)$/.test(fold(type))) {
    try { const list = JSON.parse(raw); if (Array.isArray(list)) return list; } catch { /* a written list */ }
    return raw.replace(/^\[|\]$/g, '').split(/\s*,\s*/).map(item => item.replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return raw;
}
const TYPE_OF = { number: 'number', integer: 'number', int: 'number', float: 'number', double: 'number', so: 'number', boolean: 'boolean', bool: 'boolean',
  array: 'array', list: 'array', stringarray: 'array', mang: 'array', string: 'string', text: 'string', chuoi: 'string', datetime: 'string', date: 'string' };

/** The parameter table of one sheet (one parameter per row), as app test cases; [] when the sheet is not one. */
export function defineTableCases(sheet, { file = null } = {}) {
  let header = null, columns = null;
  for (let index = 1; index <= Math.min(12, sheet.rowCount) && !columns; index++) {
    const found = {};
    sheet.getRow(index).eachCell({ includeEmpty: false }, (cell, column) => {
      const name = fold(cellText(cell));
      for (const [key, names] of Object.entries(COLUMNS)) if (!found[key] && names.includes(name)) found[key] = column;
    });
    if (found.event && found.param) { header = index; columns = found; }
  }
  if (!columns) return [];
  const events = new Map();
  let lastEvent = '', lastFlow = '';
  for (let index = header + 1; index <= sheet.rowCount; index++) {
    const row = sheet.getRow(index), get = key => columns[key] ? cellText(row.getCell(columns[key])) : '';
    // A merged or blank event cell continues the event above.
    const eventCell = get('event') || lastEvent, param = get('param');
    if (get('event')) { lastEvent = get('event'); lastFlow = get('flow') || lastFlow; }
    if (!eventCell || !param) continue;
    const flow = get('flow') || lastFlow;
    const id = `${flow}|${eventCell}`;
    if (!events.has(id)) events.set(id, { event: eventCell, flow, row: index, params: [] });
    events.get(id).params.push({ name: param, group: /custom/i.test(get('group')) || (!/default/i.test(get('group')) && /^c_/.test(param)) ? 'custom' : 'default',
      value: get('value'), type: get('datatype'), optional: /^(?:khong|no|optional|tuychon|n)$/.test(fold(get('required'))), note: get('note'), row: index });
  }
  const cases = [];
  for (const entry of events.values()) {
    // The event as Insider shows it ("Product Page View") or by its key (product_detail_page_view).
    const label = entry.event, key = /\s|[A-Z]/.test(label) ? insiderEventName(label) ?? keyFor(label) : label;
    const sample = { event: label, default_parameters: {}, custom_parameters: {} }, fields = {};
    for (const param of entry.params) {
      const name = param.name.trim(), path = `${param.group}_parameters.${name}`;
      const type = TYPE_OF[fold(param.type)];
      if (param.value !== '') { sample[`${param.group}_parameters`][name] = typed(param.value, param.type); fields[path] = { op: 'eq', value: typed(param.value, param.type) }; }
      else { sample[`${param.group}_parameters`][name] = null; fields[path] = type ? { op: 'type', value: type } : { op: 'exists' }; }
      if (param.optional) fields[path].optional = true;
    }
    const { testCase } = manualCase({ source: 'INSIDER', flow: entry.flow, event_name: key, sample: JSON.stringify(sample) }, cases);
    const rule = { ...testCase.rules[0], event_name: key, fields, needs_review: false, capture_platform: 'APP_SDK', sample_status: 'complete',
      event_aliases: [...new Set([label, ...(testCase.rules[0].event_aliases ?? [])])].filter(alias => alias !== key) };
    cases.push(validateTestCase({ ...testCase, id: `DEFINE-${keyFor(entry.flow) || 'all'}-${keyFor(key)}`.slice(0, 120), name: [entry.flow, label].filter(Boolean).join(' / '),
      needs_review: false, capture_platform: 'APP_SDK', sample, rules: [rule], parameter_notes: entry.params.filter(param => param.note).map(param => `${param.name}: ${param.note}`).join('\n'),
      provenance: { file, sheet: sheet.name, row: entry.row, define: true } }));
  }
  return cases;
}

/** Reads a define file (XLSX or JSON): the app events it defines, the sheet they came from and how it was read. */
export async function importDefine(file, { name: original } = {}) {
  // The file as the QC named it (an upload is stored under another name).
  const extension = path.extname(file).toLowerCase(), name = typeof original === 'string' && original.trim() ? path.basename(original.trim()).slice(0, 200) : path.basename(file);
  const app = cases => cases.filter(testCase => (testCase.rules ?? []).some(rule => rule.capture_platform === 'APP_SDK'));
  const mark = (cases, sheet) => cases.map(testCase => ({ ...testCase, provenance: { ...testCase.provenance, file: name, ...(sheet ? { sheet } : {}), define: true } }));
  if (extension === '.json') {
    const cases = app((await importSpec(file)).cases);
    if (!cases.length) throw new Error('File JSON không có event app (mẫu dạng default_parameters / custom_parameters).');
    return { cases: mark(cases), sheet: null, format: 'spec' };
  }
  if (extension !== '.xlsx') throw new Error('File define cần là XLSX hoặc JSON.');
  const workbook = await readWorkbook(file);
  let best = null;
  for (const sheet of workbook.worksheets) {
    const table = defineTableCases(sheet, { file: name });
    let spec = [];
    if (!table.length) { try { spec = app((await importSpec(file, { sheet: sheet.name })).cases); } catch { /* not a specification sheet */ } }
    const cases = table.length ? table : spec;
    if (cases.length && (!best || cases.length > best.cases.length)) best = { cases: mark(cases, sheet.name), sheet: sheet.name, format: table.length ? 'table' : 'spec' };
  }
  if (!best) throw new Error(`Không thấy define cho app trong ${workbook.worksheets.length} sheet. Cần bảng có cột Event và Tham số (xem file define mẫu), hoặc sheet đặc tả app có mẫu default_parameters / custom_parameters.`);
  return best;
}

/** The define template: one parameter per row. */
export async function defineTemplate() {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Define');
  sheet.columns = [{ header: 'Luồng', width: 14 }, { header: 'Event', width: 24 }, { header: 'Tham số', width: 24 }, { header: 'Loại', width: 10 },
    { header: 'Giá trị mong đợi', width: 22 }, { header: 'Kiểu dữ liệu', width: 14 }, { header: 'Bắt buộc', width: 10 }, { header: 'Ghi chú', width: 50 }];
  for (const row of [
    ['All', 'Product Page View', 'Platform', 'Custom', 'AppOTA', 'string', 'Có', 'Giá trị cố định: phải đúng AppOTA'],
    ['All', 'Product Page View', 'Currency', 'Default', 'VND', 'string', 'Có', ''],
    ['All', 'Product Page View', 'Unit Price', 'Default', '', 'number', 'Có', 'Để trống giá trị: chỉ kiểm có mặt và đúng kiểu'],
    ['All', 'Product Page View', 'Taxonomy', 'Default', '', 'array', 'Có', ''],
    ['All', 'Product Page View', 'Slug', 'Custom', '', 'string', 'Có', ''],
    ['All', 'Product Page View', 'Promo Code', 'Custom', '', 'string', 'Không', 'Không bắt buộc: thiếu không tính lỗi'],
    ['All', 'Homepage View', 'Is Logged In', 'Custom', '', 'boolean', 'Có', ''],
  ]) sheet.addRow(row);
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '233958' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  const guide = workbook.addWorksheet('Hướng dẫn');
  guide.columns = [{ width: 110 }];
  for (const line of ['Mỗi dòng là một tham số của một event app.', 'Event: tên như Insider Test Lab hiện (Product Page View) hoặc key (product_detail_page_view).',
    'Tham số: tên như cột NAME của Test Lab (Unit Price) hoặc key (up, c_slug, unit_price).', 'Loại: Default hoặc Custom (như cột TYPE của Test Lab).',
    'Giá trị mong đợi: điền nếu giá trị phải cố định (so đúng từng chữ); để trống nếu giá trị thay đổi theo thao tác (chỉ kiểm có mặt và đúng kiểu).',
    'Kiểu dữ liệu: string, number, boolean, array.', 'Bắt buộc: Có / Không.']) guide.addRow([line]);
  return workbook.xlsx.writeBuffer();
}
