import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

const MAX_TEXT = 30000;
function bounded(text) {
  text = text.replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('File chưa có nội dung hướng dẫn.');
  if (text.length > MAX_TEXT) throw new Error('Hướng dẫn vượt 30.000 ký tự. Chia file thành các nhóm luồng nhỏ hơn rồi nhập lại.');
  return text;
}
function xmlText(text) {
  return text.replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
      if (entity[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()];
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    });
}
/** Read descriptions as data. No macros, formulas, embedded files or scripts run. */
export async function readInstructions({ name, content } = {}) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (!['.txt', '.md', '.json', '.docx', '.xlsx'].includes(ext)) throw new Error('Chọn file TXT, Markdown, Word (.docx), Excel (.xlsx) hoặc JSON.');
  if (typeof content !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new Error('Không đọc được file đã chọn. Hãy chọn lại file.');
  const bytes = Buffer.from(content, 'base64');
  if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw new Error('File phải có nội dung và không vượt quá 3 MB.');
  if (['.txt', '.md', '.json'].includes(ext)) {
    let text;
    try { text = bounded(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch (error) { if (error instanceof TypeError) throw new Error('File văn bản cần lưu ở định dạng UTF-8.'); throw error; }
    if (ext !== '.json') return { instructions: text };
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('File JSON chưa đúng định dạng. Có thể dùng TXT để AI đọc mô tả bằng lời.'); }
    if (!data || typeof data !== 'object') throw new Error('File JSON cần chứa kịch bản hoặc danh sách workflows.');
    const workflows = Array.isArray(data) ? data : data.workflows ?? [data.workflow ?? data];
    if (!Array.isArray(workflows) || !workflows.length || workflows.length > 10) throw new Error('File JSON cần từ 1 đến 10 luồng.');
    return { workflows };
  }
  let archive;
  try { archive = await JSZip.loadAsync(bytes); } catch { throw new Error('File Word/Excel không hợp lệ hoặc có mật khẩu. Hãy lưu lại thành DOCX/XLSX không có mật khẩu.'); }
  const entries = Object.values(archive.files).filter(entry => !entry.dir);
  if (entries.some(entry => !Number.isFinite(entry._data?.uncompressedSize)) || entries.reduce((size, entry) => size + entry._data.uncompressedSize, 0) > 20 * 1024 * 1024) throw new Error('Nội dung giải nén quá lớn. Chỉ giữ phần mô tả luồng cần chạy.');
  if (ext === '.docx') {
    const document = archive.file('word/document.xml');
    if (!document || document._data.uncompressedSize > 2 * 1024 * 1024) throw new Error('Không đọc được phần văn bản của file Word hoặc nội dung quá lớn.');
    return { instructions: bounded(xmlText(await document.async('string'))) };
  }
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes); } catch { throw new Error('Không đọc được workbook Excel. Hãy lưu lại file XLSX không có mật khẩu.'); }
  const lines = []; let rowsRead = 0;
  for (const sheet of workbook.worksheets) {
    if (sheet.rowCount > 1000 || sheet.columnCount > 40) throw new Error('Mỗi sheet tối đa 1.000 dòng và 40 cột. Tách phần mô tả luồng cần dùng sang file riêng.');
    lines.push(`Sheet: ${sheet.name}`);
    sheet.eachRow(row => {
      const cells = [];
      for (let column = 1; column <= sheet.columnCount; column++) cells.push(row.getCell(column).text);
      if (cells.some(value => value.trim())) { lines.push(cells.join(' | ')); rowsRead++; }
    });
  }
  if (!rowsRead) throw new Error('File Excel chưa có nội dung hướng dẫn.');
  return { instructions: bounded(lines.join('\n')) };
}
