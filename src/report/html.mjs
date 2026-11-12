const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const text = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
const dateText = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) : String(value ?? '');
export function htmlSettings(input = {}) {
  return { fontSize: [12, 14, 16].includes(Number(input.fontSize)) ? Number(input.fontSize) : 14, wrap: input.wrap !== false,
    onlyIssues: input.onlyIssues === true, rowsPerPage: [25, 50, 100].includes(Number(input.rowsPerPage)) ? Number(input.rowsPerPage) : 50,
    hiddenColumns: Array.isArray(input.hiddenColumns) ? input.hiddenColumns.filter(value => typeof value === 'string' && value.length < 100).slice(0, 30) : [],
    columnOrder: Array.isArray(input.columnOrder) ? [...new Set(input.columnOrder.filter(value => typeof value === 'string' && value.length < 100))].slice(0, 30) : [] };
}

function viewer() {
  const model = JSON.parse(document.getElementById('report-data').textContent);
  const settings = model.settings, $ = id => document.getElementById(id);
  let section = model.sections[0], page = 0, query = '', outcome = '', filtered = [];
  const string = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  const MARK_TITLE = { different: 'Khác giá trị mẫu (đặc tả cho phép)', wrong: 'Sai so với đặc tả', missing: 'Thiếu ở bên này', extra: 'Đặc tả không có trường này', optional: 'Thiếu, nhưng đặc tả không bắt buộc' };
  if (model.sections.some(item => item.rows.some(row => row.diff))) $('legend').hidden = false;
  const issue = row => !row.status || ['MISMATCH', 'FAIL', 'NOT_SENT', 'DECODE_ERROR', 'AMBIGUOUS', 'REVIEW', 'NO_API', 'NO_MAPPING', 'NOT_SEEN'].includes(row.status);
  const orderedColumns = value => [...value.columns].sort((a, b) => {
    const index = key => settings.columnOrder.includes(key) ? settings.columnOrder.indexOf(key) : settings.columnOrder.length + value.columns.findIndex(column => column.key === key);
    return index(a.key) - index(b.key);
  });
  const paint = (element, status) => { element.className = ['MATCH', 'PASS', 'SENT', 'COMPLETED'].includes(status) ? 'good' : ['MISMATCH', 'FAIL', 'NOT_SENT', 'DECODE_ERROR', 'FAILED'].includes(status) ? 'bad' : 'review'; };
  function details(row) {
    $('detail-title').textContent = row.name || row.event_name || row.path || row.id || 'Chi tiết';
    const host = $('detail-body'); host.replaceChildren();
    const data = row.details || row;
    for (const [name, value] of Object.entries(data)) {
      const item = document.createElement('details'); item.open = true;
      const title = document.createElement('summary'); title.textContent = name; item.append(title);
      const pre = document.createElement('pre'); pre.textContent = string(value); item.append(pre); host.append(item);
    }
    $('detail').showModal();
  }
  function render() {
    if (!section) return;
    const columns = orderedColumns(section).filter(column => !settings.hiddenColumns.includes(column.key));
    const head = document.createElement('tr');
    for (const column of columns) { const th = document.createElement('th'); th.textContent = column.label; th.style.minWidth = `${column.width || 130}px`; head.append(th); }
    const more = document.createElement('th'); more.textContent = 'Chi tiết'; head.append(more); $('head').replaceChildren(head);
    const needle = query.toLocaleLowerCase('vi-VN');
    filtered = section.rows.filter(row => (!settings.onlyIssues || issue(row)) && (!outcome || row.status === outcome)
      && (!needle || section.columns.some(column => string(row[column.key]).toLocaleLowerCase('vi-VN').includes(needle))));
    const total = Math.max(1, Math.ceil(filtered.length / settings.rowsPerPage)); page = Math.min(page, total - 1);
    const body = document.createDocumentFragment();
    for (const row of filtered.slice(page * settings.rowsPerPage, (page + 1) * settings.rowsPerPage)) {
      const tr = document.createElement('tr');
      for (const column of columns) {
        const cell = document.createElement('td'), lines = row.diff?.[column.key];
        if (Array.isArray(lines)) {
          cell.className = 'diff-cell';
          for (const line of lines) { const div = document.createElement('div'); div.textContent = line.text || ' '; if (line.mark) { div.className = `mark-${line.mark}`; div.title = MARK_TITLE[line.mark] || ''; } cell.append(div); }
        } else cell.textContent = string(row[column.key]);
        if (column.key === 'result' || column.key === 'comment') paint(cell, row.status);
        tr.append(cell);
      }
      const cell = document.createElement('td'), button = document.createElement('button'); button.textContent = 'Xem chi tiết'; button.onclick = () => details(row); cell.append(button); tr.append(cell); body.append(tr);
    }
    if (!filtered.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = columns.length + 1; cell.textContent = 'Không có dữ liệu phù hợp.'; row.append(cell); body.append(row); }
    $('body').replaceChildren(body); $('count').textContent = `${filtered.length.toLocaleString('vi-VN')} dòng · Trang ${page + 1}/${total}`;
    $('previous').disabled = page === 0; $('next').disabled = page + 1 >= total;
    document.documentElement.style.setProperty('--font-size', `${settings.fontSize}px`); document.body.classList.toggle('nowrap', !settings.wrap);
  }
  function choose(value) {
    section = value; page = 0; outcome = '';
    for (const button of $('tabs').children) button.setAttribute('aria-selected', String(button.dataset.id === value.id));
    $('status').replaceChildren(new Option('Mọi kết quả', ''));
    const labels = new Map(value.rows.filter(row => row.status).map(row => [row.status, row.result || row.status]));
    for (const [status, label] of labels) $('status').append(new Option(label, status));
    $('columns').replaceChildren();
    for (const column of orderedColumns(value)) {
      const label = document.createElement('label'), check = document.createElement('input'); check.type = 'checkbox'; check.checked = !settings.hiddenColumns.includes(column.key);
      check.onchange = () => { settings.hiddenColumns = settings.hiddenColumns.filter(key => key !== column.key); if (!check.checked) settings.hiddenColumns.push(column.key); render(); };
      const up = document.createElement('button'); up.textContent = '↑'; up.title = `Đưa cột ${column.label} lên trước`; up.onclick = () => { const order = orderedColumns(section).map(item => item.key), index = order.indexOf(column.key); if (index > 0) { [order[index - 1], order[index]] = [order[index], order[index - 1]]; settings.columnOrder = order; choose(section); } };
      label.append(check, document.createTextNode(column.label), up); $('columns').append(label);
    }
    render();
  }
  for (const value of model.sections) { const button = document.createElement('button'); button.dataset.id = value.id; button.textContent = `${value.title} (${value.rows.length})`; button.onclick = () => choose(value); $('tabs').append(button); }
  $('search').oninput = event => { query = event.target.value; page = 0; render(); };
  $('status').onchange = event => { outcome = event.target.value; page = 0; render(); };
  $('issues').checked = settings.onlyIssues; $('issues').onchange = event => { settings.onlyIssues = event.target.checked; page = 0; render(); };
  $('wrap').checked = settings.wrap; $('wrap').onchange = event => { settings.wrap = event.target.checked; render(); };
  $('font').value = settings.fontSize; $('font').onchange = event => { settings.fontSize = Number(event.target.value); render(); };
  $('page-size').value = settings.rowsPerPage; $('page-size').onchange = event => { settings.rowsPerPage = Number(event.target.value); page = 0; render(); };
  $('previous').onclick = () => { page--; render(); }; $('next').onclick = () => { page++; render(); };
  $('close-detail').onclick = () => $('detail').close(); $('print').onclick = () => {
    const oldSize = settings.rowsPerPage, oldPage = page;
    settings.rowsPerPage = Math.max(1, filtered.length); page = 0; render();
    const restore = () => { settings.rowsPerPage = oldSize; page = oldPage; render(); };
    window.addEventListener('afterprint', restore, { once: true }); window.print();
  };
  if (section) choose(section);
}

/** One self-contained file, no CDN or server dependency, with paged DOM rendering. */
export function renderHtmlReport({ title = 'Báo cáo EventQA', session = {}, sections = [], settings = {} } = {}) {
  const data = JSON.stringify({ sections, settings: htmlSettings(settings) }).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const fallback = sections.map(section => `<h2>${escape(section.title)}</h2><table><thead><tr>${section.columns.map(column => `<th>${escape(column.label)}</th>`).join('')}</tr></thead><tbody>${section.rows.slice(0, 100).map(row => `<tr>${section.columns.map(column => `<td>${escape(text(row[column.key]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('');
  return `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>.diff-cell{font-family:Consolas,ui-monospace,monospace;font-size:.92em;white-space:pre-wrap}.diff-cell div{padding:0 3px;border-radius:2px}.mark-different,.mark-extra{background:#fff3b0}.mark-wrong{background:#fff3b0;color:#b91c1c;font-weight:700}.mark-missing{background:#fff3b0;color:#b91c1c;font-weight:700;font-style:italic}.mark-extra{color:#92400e;font-style:italic}.mark-optional{color:#6b7280;font-style:italic}.legend{margin:6px 0 10px;color:#4b5565}.legend span{padding:0 4px}:root{--font-size:14px;color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f4f6fb;color:#19243b;font:var(--font-size)/1.5 Arial,sans-serif}header{padding:26px 30px;background:#fff;border-bottom:1px solid #dfe4ef}h1{font-size:25px;margin:0 0 8px}.meta{color:#617089;font-size:12px}main{padding:22px 30px}button,input,select{font:inherit;border:1px solid #d7deea;border-radius:7px;padding:8px 11px;background:white;color:inherit}button{cursor:pointer;white-space:nowrap}th:last-child,td:last-child{min-width:140px}button:disabled{opacity:.4;cursor:default}#tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}#tabs [aria-selected=true]{background:#6742c2;color:white;border-color:#6742c2}.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;background:#fff;padding:15px;border:1px solid #dfe4ef;border-radius:10px 10px 0 0}.toolbar input[type=search]{min-width:240px;flex:1}label{display:inline-flex;align-items:center;gap:6px}.table{overflow:auto;max-height:72vh;background:white;border:1px solid #dfe4ef}table{border-collapse:separate;border-spacing:0;width:100%;font-size:var(--font-size)}td,th{padding:11px 13px;text-align:left;vertical-align:top;border-right:1px solid #e0e5ee;border-bottom:1px solid #e0e5ee;white-space:pre-wrap;overflow-wrap:anywhere;max-width:430px}th{position:sticky;top:0;background:#233958;color:#fff;z-index:1}tr:nth-child(even) td{background:#f7f9fd}td.good{background:#e3f5e9!important;color:#166534}td.bad{background:#ffe6e6!important;color:#991b1b}td.review{background:#fff4d5!important;color:#805600}.nowrap td{white-space:nowrap;max-width:430px;overflow:hidden;text-overflow:ellipsis}.footer{display:flex;justify-content:space-between;align-items:center;padding:14px;background:white;border:1px solid #dfe4ef;border-top:0;border-radius:0 0 10px 10px}details{margin:12px 0}summary{cursor:pointer;font-weight:bold}#columns{display:flex;gap:14px;flex-wrap:wrap;padding:12px;background:white}dialog{border:1px solid #dfe4ef;border-radius:12px;width:min(1100px,95vw);max-height:90vh;padding:22px}dialog::backdrop{background:#172b4d88}.dialog-head{display:flex;justify-content:space-between;gap:20px;align-items:center;position:sticky;top:-22px;background:#fff;padding:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6fb;padding:15px;border-radius:8px;font:13px/1.5 Consolas,monospace}@media print{header,main{padding:10px}.toolbar,#tabs,.footer,details,button{display:none!important}.table{max-height:none;overflow:visible}th{position:static}td{font-size:10px}}</style>
<header><h1>${escape(title)}</h1><div class="meta">Phiên: ${escape(session.id ?? session.session_id ?? '')} · Bắt đầu: ${escape(dateText(session.started_at))} · Kết thúc: ${escape(dateText(session.completed_at))} · giờ Việt Nam</div></header>
<main><nav id="tabs" aria-label="Nội dung báo cáo"></nav><p id="legend" class="legend" hidden>So sánh từng trường giữa <b>Event mong muốn</b> (đặc tả) và <b>Event thực tế</b>: dòng giống để nguyên · <span class="mark-different">nền vàng</span> = khác giá trị mẫu · <span class="mark-wrong">vàng chữ đỏ</span> = sai đặc tả · <span class="mark-missing">(thiếu)</span> = bên đó thiếu trường · <span class="mark-extra">(đặc tả không có)</span> = thực tế có thêm trường.</p><div class="toolbar"><input id="search" type="search" placeholder="Tìm trong bảng…" aria-label="Tìm trong báo cáo"><select id="status" aria-label="Lọc kết quả"></select><label><input id="issues" type="checkbox"> Chỉ vấn đề</label><button id="print">In / lưu PDF</button></div>
<details><summary>Định dạng bảng</summary><div class="toolbar"><label>Cỡ chữ <select id="font"><option>12</option><option>14</option><option>16</option></select></label><label><input id="wrap" type="checkbox"> Ngắt dòng</label><label>Số dòng <select id="page-size"><option>25</option><option>50</option><option>100</option></select></label></div><div id="columns"></div></details>
<div class="table"><table><thead id="head"></thead><tbody id="body"></tbody></table></div><div class="footer"><span id="count"></span><div><button id="previous">Trước</button> <button id="next">Sau</button></div></div><noscript>${fallback}</noscript></main>
<dialog id="detail"><div class="dialog-head"><h2 id="detail-title">Chi tiết</h2><button id="close-detail">Đóng</button></div><div id="detail-body"></div></dialog><script id="report-data" type="application/json">${data}</script><script>(${viewer.toString()})();</script></html>`;
}
