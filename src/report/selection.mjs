import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { exportReports, prepareReportData } from './export.mjs';
import { renderHtmlReport, htmlSettings } from './html.mjs';
import { apiSection, tp2Section, insiderSection } from './models.mjs';
import { compareTp2Event, tp2Events } from '../core/tp2-compare.mjs';
import { redactApiData, apiCallSummary } from '../core/api-log.mjs';

export function normalizeSelection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Lựa chọn xuất không hợp lệ.');
  const contents = [...new Set(input.contents ?? ['events'])], formats = [...new Set(input.formats ?? ['html'])];
  if (!contents.length || contents.some(value => !['events', 'insider', 'api', 'tp2'].includes(value))) throw new Error('Chọn nội dung Event, Insider, TP2 hoặc API để xuất.');
  if (!formats.length || formats.some(value => !['xlsx', 'html', 'json', 'bugs'].includes(value)) || formats.every(value => value === 'bugs') && !contents.includes('events')) throw new Error('Chọn định dạng HTML, Excel hoặc JSON.');
  return { contents, formats, htmlSettings: htmlSettings(input.htmlSettings) };
}
const safeCell = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /^[=+@\-\t\r]/.test(text) ? `'${text}` : typeof value === 'number' ? value : text;
};
function leaves(value, field = '', out = []) {
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) leaves(item, field ? `${field}.${key}` : key, out);
  else {
    const text = String(value ?? '');
    let start = 0, part = 1;
    do {
      let end = Math.min(text.length, start + 31000);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      out.push([field, part++, text.slice(start, end)]); start = end;
    } while (start < text.length);
  }
  return out;
}
async function writeSectionWorkbook(file, section) {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet(section.title.replace(/[\\/*?:\[\]]/g, '').slice(0, 31));
  sheet.columns = section.columns.map(column => ({ header: column.label, key: column.key, width: Math.min(65, Math.max(12, (column.width ?? 160) / 8)) }));
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: 'A1', to: { row: 1, column: section.columns.length } };
  const detail = workbook.addWorksheet('Chi tiết đầy đủ');
  detail.columns = [{ header: 'Bằng chứng', width: 42 }, { header: 'Trường', width: 65 }, { header: 'Phần', width: 9 }, { header: 'Giá trị', width: 95 }]; detail.views = [{ state: 'frozen', ySplit: 1 }];
  for (const row of section.rows) {
    sheet.addRow(section.columns.map(column => { const value = safeCell(row[column.key]); return typeof value === 'string' && value.length > 32000 ? `${value.slice(0, 31800)}\n[Xem sheet Chi tiết đầy đủ]` : value; }));
    for (const values of leaves(row.details)) detail.addRow([row.id, ...values].map(safeCell));
  }
  for (const tab of [sheet, detail]) {
    tab.getRow(1).eachCell(cell => { cell.font = { bold: true, color: { argb: 'FFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '233958' } }; });
    tab.eachRow((row, index) => { row.alignment = { vertical: 'top', wrapText: true }; if (index > 1) row.height = 45; });
  }
  await workbook.xlsx.writeFile(file);
}
export async function exportSelection(snapshot, outputDir, rawSelection, { prepared, tp2Mappings = [] } = {}) {
  const selection = normalizeSelection(rawSelection), files = {}, directory = path.resolve(outputDir);
  await fs.mkdir(directory, { recursive: true });
  if (selection.contents.includes('events')) Object.assign(files, await exportReports({ ...snapshot, api_calls: [] }, directory,
    { prepared: prepared ?? prepareReportData(snapshot), formats: selection.formats, htmlSettings: selection.htmlSettings }));
  // Insider events only, in files of their own (insider-report.*).
  if (selection.contents.includes('insider')) {
    const data = prepared ?? prepareReportData(snapshot), section = insiderSection(snapshot, data);
    const insiderEvents = (snapshot.events ?? []).filter(event => String(event.source).toUpperCase() === 'INSIDER');
    for (const format of selection.formats.filter(format => format !== 'bugs')) {
      const file = path.join(directory, `insider-report.${format}`);
      if (format === 'html') await fs.writeFile(file, renderHtmlReport({ title: section.title, session: snapshot.session, sections: [section], settings: selection.htmlSettings }), 'utf8');
      else if (format === 'json') await fs.writeFile(file, JSON.stringify(redactApiData({ session: snapshot.session, report: section.rows.map(({ details, ...row }) => row), events: insiderEvents }), null, 2), 'utf8');
      else await writeSectionWorkbook(file, section);
      files[`insider_${format}`] = file;
    }
  }
  const calls = redactApiData(snapshot.api_calls ?? []), events = tp2Events(snapshot.events ?? []);
  const callsById = new Map(calls.map(call => [call.evidence_id, call]));
  const summaries = calls.map(apiCallSummary);
  for (const kind of selection.contents.filter(value => value === 'api' || value === 'tp2')) {
    const comparisons = kind === 'tp2' ? events.map(event => compareTp2Event(event, summaries, id => callsById.get(id), tp2Mappings)) : null;
    const section = kind === 'api' ? apiSection(calls) : tp2Section(comparisons, events);
    const data = kind === 'api' ? { session: redactApiData(snapshot.session), api_calls: calls } : { session: redactApiData(snapshot.session), events: redactApiData(events), comparisons };
    for (const format of selection.formats.filter(format => format !== 'bugs')) {
      const file = path.join(directory, `${kind}-report.${format}`);
      if (format === 'html') await fs.writeFile(file, renderHtmlReport({ title: section.title, session: snapshot.session, sections: [section], settings: selection.htmlSettings }), 'utf8');
      else if (format === 'json') await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
      else await writeSectionWorkbook(file, section);
      files[`${kind}_${format}`] = file;
    }
  }
  return files;
}
