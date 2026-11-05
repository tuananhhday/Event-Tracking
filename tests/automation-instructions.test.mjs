import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { readInstructions } from '../src/automation/instructions.mjs';
const input = (name, text) => ({ name, content: Buffer.from(text).toString('base64') });

test('reads typed/file descriptions as UTF-8 text and imports single or multiple saved JSON workflows', async () => {
  const description = 'Luồng 1: Tìm khách sạn\nNhập Phú Quốc, bấm Tìm kiếm.';
  assert.equal((await readInstructions(input('flows.md', description))).instructions, description);
  const workflow = { name: 'Tìm kiếm', url: 'https://example.test', steps: [{ name: 'Tìm', actions: [] }] };
  assert.deepEqual((await readInstructions(input('flows.json', JSON.stringify({ workflows: [workflow, workflow] })))).workflows, [workflow, workflow]);
  assert.deepEqual((await readInstructions(input('flow.json', JSON.stringify(workflow)))).workflows, [workflow]);
  for (const [name, content] of [['empty.txt', '  '], ['bad.json', '{'], ['null.json', 'null'], ['long.md', 'x'.repeat(30001)]]) await assert.rejects(readInstructions(input(name, content)));
});

test('Word paragraphs and Excel sheets retain the full flow descriptions and Vietnamese text', async () => {
  const zip = new JSZip(); zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Luồng 1: tìm &amp; chọn</w:t></w:r></w:p><w:p><w:r><w:t>Nhập Phú Quốc</w:t></w:r></w:p></w:body></w:document>');
  const word = await readInstructions({ name: 'flows.docx', content: (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64') });
  assert.equal(word.instructions, 'Luồng 1: tìm & chọn\nNhập Phú Quốc');
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Khách sạn').addRows([['Luồng', 'Bước', 'Dữ liệu'], ['Tìm khách sạn', 'Nhập điểm đến', 'Phú Quốc']]);
  workbook.addWorksheet('Giỏ hàng').addRow(['Luồng 2', 'Bấm giỏ hàng']);
  const excel = await readInstructions({ name: 'flows.xlsx', content: Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64') });
  assert.match(excel.instructions, /Sheet: Khách sạn/); assert.match(excel.instructions, /Phú Quốc/); assert.match(excel.instructions, /Luồng 2/);
  await assert.rejects(readInstructions(input('broken.docx', 'bad zip')), /không hợp lệ/);
});
