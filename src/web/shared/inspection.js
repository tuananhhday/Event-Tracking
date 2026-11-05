(() => {
  'use strict';
  const $ = id => document.getElementById(id), esc = EventQA.esc, pretty = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  const labels = { MATCH: 'Khớp', MISMATCH: 'Lệch', REVIEW: 'Cần kiểm tra', CLICK: 'Click affiliate', NO_MAPPING: 'Chọn API để so sánh', NO_API: 'Chưa tìm thấy API', AMBIGUOUS: 'Cần chọn API', DECODE_ERROR: 'Lỗi giải mã' };
  const pill = status => `<span class="pill ${status === 'MATCH' ? 'PASS' : ['MISMATCH', 'DECODE_ERROR'].includes(status) ? 'FAIL' : 'REVIEW'}">${esc(labels[status] || status)}</span>`;
  const prefsKey = `eventqa:${document.body.dataset.mode}:export-options`;
  let finish = false, state = { mappings: [], events: [], apis: [] }, selected = null, editingId = '', loading = false, page = 0, draftFields = [], detailSequence = 0;
  async function get(route) { const response = await fetch(`/api/${route}`, { cache: 'no-store' }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Không tải được dữ liệu.'); return result; }
  async function post(route, data) { const response = await fetch(`/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EventQA-Token': token }, body: JSON.stringify(data) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Thao tác chưa hoàn tất.'); return result; }
  const run = fn => async () => { try { await fn(); } catch (error) { if ($('tp2-detail').open) $('tp2-detail-error').textContent = error.message; else EventQA.toast(error.message, 'error'); } };
  const columns = [['stt', 'STT'], ['platform', 'Nền tảng'], ['flow', 'Luồng'], ['event_name', 'Tên event'], ['expected', 'Mong muốn'], ['actual_ga4', 'Thực tế GA4'], ['actual_insider', 'Thực tế Insider'], ['comment', 'Nhận xét']];
  $('export-columns').innerHTML = columns.map(([key, label]) => `<label class="check"><input type="checkbox" data-export-column="${key}" checked> ${label} <button type="button" class="btn small" data-export-up title="Đưa cột lên trước">↑</button></label>`).join('');
  $('export-columns').onclick = event => { const button = event.target.closest('[data-export-up]'); if (button) { const label = button.closest('label'); if (label.previousElementSibling) label.parentNode.insertBefore(label, label.previousElementSibling); } };
  window.EventQAExports = { open(endSession = false) {
    finish = endSession; $('export-title').textContent = finish ? 'Kết thúc & xuất báo cáo' : 'Xuất báo cáo'; $('export-confirm').textContent = finish ? 'Kết thúc & xuất' : 'Xuất báo cáo'; $('export-error').textContent = '';
    let prefs = {}; try { prefs = JSON.parse(localStorage.getItem(prefsKey) || '{}'); } catch { /* use defaults */ }
    for (const type of ['events', 'tp2', 'api']) $(`export-${type}`).checked = (prefs.contents || ['events']).includes(type);
    $('export-format').value = prefs.format || 'html'; $('export-font').value = prefs.htmlSettings?.fontSize || 14; $('export-page-size').value = prefs.htmlSettings?.rowsPerPage || 50;
    $('export-wrap').checked = prefs.htmlSettings?.wrap !== false; $('export-issues').checked = prefs.htmlSettings?.onlyIssues === true;
    for (const input of document.querySelectorAll('[data-export-column]')) input.checked = !prefs.htmlSettings?.hiddenColumns?.includes(input.dataset.exportColumn);
    for (const key of prefs.htmlSettings?.columnOrder || []) { const input = [...document.querySelectorAll('[data-export-column]')].find(item => item.dataset.exportColumn === key); if (input) $('export-columns').append(input.closest('label')); }
    $('export-dialog').showModal();
  } };
  $('export-close').onclick = () => $('export-dialog').close();
  $('export-confirm').onclick = async () => {
    const contents = ['events', 'tp2', 'api'].filter(type => $(`export-${type}`).checked), format = $('export-format').value;
    if (!contents.length) { $('export-error').textContent = 'Chọn ít nhất một nội dung để xuất.'; return; }
    const htmlSettings = { fontSize: Number($('export-font').value), rowsPerPage: Number($('export-page-size').value), wrap: $('export-wrap').checked, onlyIssues: $('export-issues').checked,
      hiddenColumns: [...document.querySelectorAll('[data-export-column]')].filter(input => !input.checked).map(input => input.dataset.exportColumn), columnOrder: [...document.querySelectorAll('[data-export-column]')].map(input => input.dataset.exportColumn) };
    try { localStorage.setItem(prefsKey, JSON.stringify({ contents, format, htmlSettings })); } catch { /* optional preference */ }
    $('export-confirm').disabled = true; $('export-error').textContent = '';
    try {
      const result = await EventQA.api(finish ? 'finish' : 'export', { selection: { contents, formats: format === 'all' ? ['xlsx', 'html', 'json', 'bugs'] : [format], htmlSettings },
        aiNotes: contents.includes('events') && $('report-ai-notes')?.checked !== false }, 'export');
      $('export-dialog').close(); EventQA.toast(result.exported ? 'Đã tạo các file đã chọn trong phần báo cáo.' : 'Tác vụ xuất đã dừng.', 'ok');
    } catch (error) { $('export-error').textContent = error.message; }
    finally { $('export-confirm').disabled = false; }
  };
  $('tp2-panel').innerHTML = `<p class="hint">Thao tác trên website như bình thường. Ứng dụng đọc ue_px trong TP2 và tự tìm API liên quan để so sánh. Bấm Xem / đối chiếu để xem trường khớp, lệch hoặc chưa ghép được. Click affiliate và mua hàng là các lần gửi riêng.</p>
    <div class="tp2-summary" id="tp2-summary"></div><div class="tp2-toolbar"><input id="tp2-search" type="search" placeholder="Tìm event, schema hoặc trang…"><select id="tp2-filter"><option value="">Mọi kết quả</option>${Object.entries(labels).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select><button class="btn" id="tp2-refresh">Làm mới</button></div>
    <div id="tp2-error" class="field-error"></div><div id="tp2-list"></div><div class="tp2-toolbar"><button class="btn small" id="tp2-prev">Trước</button><span id="tp2-page"></span><button class="btn small" id="tp2-next">Sau</button></div>`;
  async function refresh() {
    if (loading || document.hidden || document.querySelector('[data-panel="tp2"]').classList.contains('hidden')) return;
    loading = true;
    try {
      state = await get(`tp2?${new URLSearchParams({ q: $('tp2-search').value, status: $('tp2-filter').value, page })}`);
      $('tp2-count').textContent = state.total; $('tp2-error').textContent = '';
      $('tp2-summary').innerHTML = Object.entries(state.summary).map(([status, count]) => `${pill(status)} <b>${count}</b>`).join(' ');
      $('tp2-list').innerHTML = state.events.length ? `<div class="tp2-table-wrap"><table><thead><tr><th>Thời điểm</th><th>Event</th><th>HTTP</th><th>Giải mã</th><th>Đối chiếu</th><th></th></tr></thead><tbody>${state.events.map(event => `<tr><td>${esc(new Date(event.captured_at).toLocaleTimeString('vi-VN', { hour12: false }))}</td><td><strong>${esc(event.event_name)}</strong><br><small>${esc(event.schema || event.page?.url || '')}</small></td><td>${esc(event.http_status ?? 'Đang chờ')}</td><td>${event.decode_status === 'DECODED' ? 'Đã đọc JSON' : 'Lỗi giải mã'}</td><td>${pill(event.status)}</td><td><button class="btn small" data-tp2-id="${esc(event.evidence_id)}">Xem / đối chiếu</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="tp2-empty"><b>Chưa ghi nhận TP2 phù hợp</b>Event sẽ xuất hiện khi website gửi request TP2. Kiểm tra bộ lọc hoặc thực hiện bước đặt hàng nếu cần.</div>';
      $('tp2-page').textContent = `${state.matched} event · Trang ${page + 1}`; $('tp2-prev').disabled = !page; $('tp2-next').disabled = (page + 1) * 100 >= state.matched;
      if ($('tp2-detail').open && !$('tp2-mapping-editor').open && selected) await details(selected.event.evidence_id);
    } catch (error) { $('tp2-error').textContent = error.message; }
    finally { loading = false; }
  }
  function paths(value, prefix = '', out = [], depth = 0) {
    if (out.length >= 500 || depth > 15) return out;
    if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { if (out.length >= 500) break; paths(item, prefix ? `${prefix}.${key}` : key, out, depth + 1); }
    else if (prefix) out.push(prefix);
    return out;
  }
  const valueAt = (value, path) => path ? path.replace(/\[(\d+)\]/g, '.$1').split('.').reduce((node, key) => node != null && Object.hasOwn(Object(node), key) ? node[key] : undefined, value) : value;
  const apiRecord = () => valueAt(selected?.api?.[$('tp2-map-side').value]?.body?.json, $('tp2-map-record').value.trim());
  function apiPattern(call) {
    if (!call) return '';
    const stem = call.path.match(/^(.*\/(?:myorder|products?))(?:\/|$)/i)?.[1] || call.path;
    return '^' + (call.host + stem).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (stem === call.path ? '$' : '(?:/|$)');
  }
  function pathSuggestions() {
    $('tp2-event-paths').innerHTML = paths(selected?.event.payload).map(value => `<option value="${esc(value)}">`).join('');
    const body = apiRecord();
    $('tp2-api-paths').innerHTML = paths(body).map(value => `<option value="${esc(value)}">`).join('');
  }
  function renderFields() {
    const record = apiRecord(), apiPaths = paths(record);
    $('tp2-field-rows').innerHTML = draftFields.length ? `<table><thead><tr><th>So sánh</th><th>Trường TP2 / Giá trị</th><th>Trường API</th><th>Giá trị API</th><th>Cách so</th></tr></thead><tbody>${draftFields.map((field, index) => {
      const choices = [...new Set([...apiPaths, ...(field.api_path ? [field.api_path] : [])])];
      return `<tr><td><input type="checkbox" data-field-index="${index}" data-field-key="enabled" aria-label="So sánh ${esc(field.event_path)}" ${field.enabled !== false ? 'checked' : ''}></td><td><b>${esc(field.event_path)}</b><pre>${esc(pretty(valueAt(selected.event.payload, field.event_path)))}</pre></td><td><select data-field-index="${index}" data-field-key="api_path" aria-label="Trường API cho ${esc(field.event_path)}"><option value="">Chưa ghép: chọn trường API</option>${choices.map(path => `<option value="${esc(path)}" ${path === field.api_path ? 'selected' : ''}>${esc(path)}</option>`).join('')}</select><small>${esc(field.reason || '')}</small></td><td><pre>${esc(field.api_path ? pretty(valueAt(record, field.api_path)) : 'Chưa ghép')}</pre></td><td><select data-field-index="${index}" data-field-key="type" aria-label="Cách so ${esc(field.event_path)}">${Object.entries({ json: 'Đúng kiểu và giá trị', number: 'Số', string: 'Chữ', date: 'Ngày' }).map(([type, label]) => `<option value="${type}" ${type === field.type ? 'selected' : ''}>${label}</option>`).join('')}</select></td></tr>`;
    }).join('')}</tbody></table>` : '<p class="hint">Chưa có trường dữ liệu để ghép. Chọn một TP2 đã giải mã và API có JSON đầy đủ.</p>';
  }
  $('tp2-field-rows').onchange = event => {
    const input = event.target, field = draftFields[Number(input.dataset.fieldIndex)];
    if (!field || !['enabled', 'api_path', 'type'].includes(input.dataset.fieldKey)) return;
    field[input.dataset.fieldKey] = input.dataset.fieldKey === 'enabled' ? input.checked : input.value;
    field.reason = ''; renderFields();
  };
  function editMapping(mapping) {
    editingId = mapping?.id || '';
    $('tp2-map-name').value = mapping?.name || `Đối chiếu ${selected.event.event_name}`; $('tp2-map-event').value = mapping?.event_name || selected.event.event_name;
    $('tp2-map-pattern').value = mapping?.api_pattern || apiPattern(selected.api); $('tp2-map-side').value = mapping?.api_side || 'response';
    $('tp2-map-record').value = mapping?.record_path || ''; $('tp2-map-event-id').value = mapping?.event_id_path || ''; $('tp2-map-api-id').value = mapping?.api_id_path || '';
    $('tp2-map-window').value = (mapping?.window_ms || 1800000) / 60000; draftFields = structuredClone(mapping?.fields || selected.suggestions?.fields || []); $('tp2-delete-mapping').disabled = !mapping;
    pathSuggestions(); renderFields();
  }
  async function details(id, reset = false, forceAuto = false) {
    const sequence = ++detailSequence;
    const query = new URLSearchParams({ id }); if (!reset && $('tp2-api-choice').value) query.set('api_id', $('tp2-api-choice').value); if (!reset && !forceAuto && $('tp2-mapping-choice').value) query.set('mapping_id', $('tp2-mapping-choice').value);
    if (forceAuto) query.set('auto', '1');
    const result = await get(`tp2/detail?${query}`); if (sequence !== detailSequence) return;
    selected = result; const { event, comparison, api } = selected;
    if (reset) {
      $('tp2-mapping-choice').innerHTML = '<option value="">Tự chọn cách ghép</option>' + state.mappings.map(mapping => `<option value="${esc(mapping.id)}">${esc(mapping.name)}</option>`).join('');
      const candidateIds = new Set(comparison.candidates.map(call => call.evidence_id));
      const apis = [...state.apis].sort((a, b) => Number(candidateIds.has(b.evidence_id)) - Number(candidateIds.has(a.evidence_id)));
      $('tp2-api-choice').innerHTML = '<option value="">Tự tìm API liên quan</option>' + apis.map(call => `<option value="${esc(call.evidence_id)}">${esc(`${candidateIds.has(call.evidence_id) ? 'Liên quan · ' : ''}${call.method} ${call.path} · HTTP ${call.status ?? '?'} · ${call.captured_at.slice(11,19)}`)}</option>`).join('');
      $('tp2-mapping-editor').open = false;
    }
    if (reset || forceAuto || !$('tp2-mapping-editor').open) { $('tp2-mapping-choice').value = comparison.mapping_id || ''; editMapping(state.mappings.find(mapping => mapping.id === comparison.mapping_id)); }
    $('tp2-title').textContent = `${event.event_name} · TP2 ↔ API`; $('tp2-detail-error').textContent = '';
    $('tp2-decoded').textContent = pretty(event.payload); $('tp2-metadata').textContent = pretty({ ...event.tp2, network: event.network }); $('tp2-api-data').textContent = pretty(api);
    $('tp2-comparison').innerHTML = `<p>${pill(comparison.status)} ${esc(comparison.message || '')}</p>${api ? `<p><b>API đã dùng:</b> ${esc(api.method)} ${esc(api.path)}</p>` : ''}` + (comparison.comparisons.length ? `<div class="tp2-table-wrap"><table><thead><tr><th>Trường TP2</th><th>Giá trị TP2</th><th>Trường API</th><th>Giá trị API</th><th>Kết quả</th></tr></thead><tbody>${comparison.comparisons.map(field => `<tr><td>${esc(field.field)}</td><td>${esc(pretty(field.actual))}</td><td>${esc(field.api_field || 'Chưa ghép')}</td><td>${esc(pretty(field.expected))}</td><td>${pill(field.status)}<br>${esc(field.reason)}</td></tr>`).join('')}</tbody></table></div>` : '');
    pathSuggestions(); if (!$('tp2-detail').open) $('tp2-detail').showModal();
  }
  $('tp2-list').onclick = event => { const button = event.target.closest('[data-tp2-id]'); if (button) void run(() => details(button.dataset.tp2Id, true))(); };
  $('tp2-close').onclick = () => { detailSequence++; $('tp2-detail').close(); };
  $('tp2-detail').addEventListener('close', () => { detailSequence++; });
  $('tp2-api-choice').onchange = run(() => details(selected.event.evidence_id, false, true));
  $('tp2-mapping-choice').onchange = run(async () => { await details(selected.event.evidence_id); editMapping(state.mappings.find(mapping => mapping.id === $('tp2-mapping-choice').value)); });
  $('tp2-map-side').onchange = $('tp2-map-record').onchange = () => { pathSuggestions(); renderFields(); };
  $('tp2-add-field').onclick = run(() => {
    const field = { event_path: $('tp2-field-event').value.trim(), api_path: $('tp2-field-api').value.trim(), type: $('tp2-field-type').value };
    if (!field.event_path || !field.api_path) throw new Error('Chọn đủ trường TP2 và trường API trước khi thêm cặp.');
    const existing = draftFields.findIndex(item => item.event_path === field.event_path);
    if (existing >= 0) draftFields[existing] = field; else draftFields.push(field);
    renderFields(); $('tp2-detail-error').textContent = '';
  });
  $('tp2-suggest').onclick = run(async () => {
    const query = new URLSearchParams({ id: selected.event.evidence_id, side: $('tp2-map-side').value, record: $('tp2-map-record').value.trim() });
    if (selected.api) query.set('api_id', selected.api.evidence_id);
    const result = await get(`tp2/detail?${query}`); draftFields = result.suggestions.fields; pathSuggestions(); renderFields();
    $('tp2-detail-error').textContent = '';
  });
  $('tp2-save-mapping').onclick = run(async () => {
    const fields = draftFields.filter(field => field.enabled !== false);
    if (!fields.length) throw new Error('Chọn ít nhất một trường để so sánh.');
    if (fields.some(field => !field.api_path)) throw new Error('Còn trường chưa ghép. Chọn trường API trong bảng hoặc bỏ tick trường bạn không cần kiểm tra.');
    const mapping = { ...(editingId ? { id: editingId } : {}), name: $('tp2-map-name').value, event_name: $('tp2-map-event').value, api_pattern: $('tp2-map-pattern').value,
      api_side: $('tp2-map-side').value, record_path: $('tp2-map-record').value, event_id_path: $('tp2-map-event-id').value, api_id_path: $('tp2-map-api-id').value,
      window_ms: Number($('tp2-map-window').value) * 60000, dynamic_items: !$('tp2-map-record').value.trim() && fields.some(field => /(?:\.|\[)\d+(?:\.|\])/.test(field.event_path) || /(?:\.|\[)\d+(?:\.|\])/.test(field.api_path)), fields };
    $('tp2-save-mapping').disabled = true;
    try { state = await post('tp2/mapping', { mapping }); await details(selected.event.evidence_id, true); await refresh(); $('tp2-result-title').scrollIntoView({ block: 'start' }); EventQA.toast('Đã so sánh. Kết quả ở đầu cửa sổ.', 'ok'); }
    finally { $('tp2-save-mapping').disabled = false; }
  });
  $('tp2-delete-mapping').onclick = run(async () => { if (editingId) { state = await post('tp2/mapping', { deleteId: editingId }); await details(selected.event.evidence_id, true); await refresh(); } });
  $('tp2-refresh').onclick = () => void refresh(); $('tp2-filter').onchange = () => { page = 0; void refresh(); }; let timer;
  $('tp2-search').oninput = () => { page = 0; clearTimeout(timer); timer = setTimeout(refresh, 200); };
  $('tp2-prev').onclick = () => { page--; void refresh(); }; $('tp2-next').onclick = () => { page++; void refresh(); };
  new MutationObserver(() => { void refresh(); }).observe(document.querySelector('[data-panel="tp2"]'), { attributes: true, attributeFilter: ['class'] });
  setInterval(() => { void refresh(); }, 3000);
})();
