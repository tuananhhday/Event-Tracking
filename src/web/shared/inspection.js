(() => {
  'use strict';
  const $ = id => document.getElementById(id), esc = EventQA.esc, pretty = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  const labels = { MATCH: 'Khớp', MISMATCH: 'Lệch', REVIEW: 'Chưa đủ dữ liệu', NO_MAPPING: 'Chưa có cấu hình', NO_API: 'Chưa tìm thấy API', AMBIGUOUS: 'Cần chọn API', DECODE_ERROR: 'Lỗi giải mã' };
  const pill = status => `<span class="pill ${status === 'MATCH' ? 'PASS' : ['MISMATCH', 'DECODE_ERROR'].includes(status) ? 'FAIL' : 'REVIEW'}">${esc(labels[status] || status)}</span>`;
  const prefsKey = `eventqa:${document.body.dataset.mode}:export-options`;
  let finish = false, state = { mappings: [], events: [], apis: [] }, selected = null, editingId = '', loading = false, page = 0;
  async function get(route) { const response = await fetch(`/api/${route}`, { cache: 'no-store' }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Không tải được dữ liệu.'); return result; }
  async function post(route, data) { const response = await fetch(`/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EventQA-Token': token }, body: JSON.stringify(data) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Thao tác chưa hoàn tất.'); return result; }
  const run = fn => async () => { try { await fn(); } catch (error) { if ($('tp2-detail').open) $('tp2-detail-error').textContent = error.message; else EventQA.toast(error.message, 'error'); } };
  const columns = [['stt', 'STT'], ['at', 'Thời điểm'], ['platform', 'Nền tảng'], ['flow', 'Luồng'], ['event_name', 'Tên event'], ['expected', 'Mong muốn'], ['actual_ga4', 'Thực tế GA4'], ['actual_insider', 'Thực tế Insider'], ['comment', 'Nhận xét']];
  $('export-columns').innerHTML = columns.map(([key, label]) => `<label class="check"><input type="checkbox" data-export-column="${key}" checked> ${label} <button type="button" class="btn small" data-export-up title="Đưa cột lên trước">↑</button></label>`).join('');
  $('export-columns').onclick = event => { const button = event.target.closest('[data-export-up]'); if (button) { const label = button.closest('label'); if (label.previousElementSibling) label.parentNode.insertBefore(label, label.previousElementSibling); } };
  window.EventQAExports = { open(endSession = false) {
    finish = endSession; $('export-title').textContent = finish ? 'Kết thúc & xuất báo cáo' : 'Xuất báo cáo'; $('export-confirm').textContent = finish ? 'Kết thúc & xuất' : 'Xuất báo cáo'; $('export-error').textContent = '';
    let prefs = {}; try { prefs = JSON.parse(localStorage.getItem(prefsKey) || '{}'); } catch { /* use defaults */ }
    for (const type of ['events', 'insider', 'tp2', 'api']) $(`export-${type}`).checked = (prefs.contents || ['events']).includes(type);
    $('export-format').value = prefs.format || 'html'; $('export-font').value = prefs.htmlSettings?.fontSize || 14; $('export-page-size').value = prefs.htmlSettings?.rowsPerPage || 50;
    $('export-wrap').checked = prefs.htmlSettings?.wrap !== false; $('export-issues').checked = prefs.htmlSettings?.onlyIssues === true;
    for (const input of document.querySelectorAll('[data-export-column]')) input.checked = !prefs.htmlSettings?.hiddenColumns?.includes(input.dataset.exportColumn);
    for (const key of prefs.htmlSettings?.columnOrder || []) { const input = [...document.querySelectorAll('[data-export-column]')].find(item => item.dataset.exportColumn === key); if (input) $('export-columns').append(input.closest('label')); }
    $('export-dialog').showModal();
  } };
  $('export-close').onclick = () => $('export-dialog').close();
  $('export-confirm').onclick = async () => {
    const contents = ['events', 'insider', 'tp2', 'api'].filter(type => $(`export-${type}`).checked), format = $('export-format').value;
    if (!contents.length) { $('export-error').textContent = 'Chọn ít nhất một nội dung để xuất.'; return; }
    const htmlSettings = { fontSize: Number($('export-font').value), rowsPerPage: Number($('export-page-size').value), wrap: $('export-wrap').checked, onlyIssues: $('export-issues').checked,
      hiddenColumns: [...document.querySelectorAll('[data-export-column]')].filter(input => !input.checked).map(input => input.dataset.exportColumn), columnOrder: [...document.querySelectorAll('[data-export-column]')].map(input => input.dataset.exportColumn) };
    try { localStorage.setItem(prefsKey, JSON.stringify({ contents, format, htmlSettings })); } catch { /* optional preference */ }
    $('export-confirm').disabled = true; $('export-error').textContent = '';
    try {
      const result = await EventQA.api(finish ? 'finish' : 'export', { selection: { contents, formats: format === 'all' ? ['xlsx', 'html', 'json', 'bugs'] : [format], htmlSettings },
        aiNotes: (contents.includes('events') || contents.includes('insider')) && $('report-ai-notes')?.checked !== false }, 'export');
      $('export-dialog').close(); EventQA.toast(result.exported ? 'Đã tạo các file đã chọn trong phần báo cáo.' : 'Tác vụ xuất đã dừng.', 'ok');
    } catch (error) { $('export-error').textContent = error.message; }
    finally { $('export-confirm').disabled = false; }
  };
  $('tp2-panel').innerHTML = `<p class="hint">TP2 được bắt trong suốt phiên. Nếu website chỉ gửi khi đặt hàng, hãy thực hiện đúng bước đó; chưa ghi nhận không đồng nghĩa thiếu event.</p>
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
    } catch (error) { $('tp2-error').textContent = error.message; }
    finally { loading = false; }
  }
  function paths(value, prefix = '', out = []) { if (out.length > 500) return out; if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) paths(item, prefix ? `${prefix}.${key}` : key, out); else if (prefix) out.push(prefix); return out; }
  function pathSuggestions() {
    $('tp2-event-paths').innerHTML = paths(selected?.event.payload).map(value => `<option value="${esc(value)}">`).join('');
    const body = selected?.api?.[$('tp2-map-side').value]?.body?.json;
    $('tp2-api-paths').innerHTML = paths(body).map(value => `<option value="${esc(value)}">`).join('');
  }
  function editMapping(mapping) {
    editingId = mapping?.id || '';
    $('tp2-map-name').value = mapping?.name || `Đối chiếu ${selected.event.event_name}`; $('tp2-map-event').value = mapping?.event_name || selected.event.event_name;
    $('tp2-map-pattern').value = mapping?.api_pattern || selected.api?.path || ''; $('tp2-map-side').value = mapping?.api_side || 'response';
    $('tp2-map-record').value = mapping?.record_path || ''; $('tp2-map-event-id').value = mapping?.event_id_path || ''; $('tp2-map-api-id').value = mapping?.api_id_path || '';
    $('tp2-map-window').value = (mapping?.window_ms || 1800000) / 60000; $('tp2-map-fields').value = JSON.stringify(mapping?.fields || [], null, 2); $('tp2-delete-mapping').disabled = !mapping;
    pathSuggestions();
  }
  async function details(id, reset = false) {
    const query = new URLSearchParams({ id }); if (!reset && $('tp2-api-choice').value) query.set('api_id', $('tp2-api-choice').value); if (!reset && $('tp2-mapping-choice').value) query.set('mapping_id', $('tp2-mapping-choice').value);
    selected = await get(`tp2/detail?${query}`); const { event, comparison, api } = selected;
    if (reset) {
      $('tp2-mapping-choice').innerHTML = '<option value="">Tự chọn cấu hình theo event</option>' + state.mappings.map(mapping => `<option value="${esc(mapping.id)}">${esc(mapping.name)}</option>`).join('');
      $('tp2-api-choice').innerHTML = '<option value="">Tự ghép theo cấu hình</option>' + state.apis.map(call => `<option value="${esc(call.evidence_id)}">${esc(`${call.method} ${call.path} · HTTP ${call.status ?? '?'} · ${call.captured_at.slice(11,19)}`)}</option>`).join('');
      editMapping(state.mappings.find(mapping => mapping.id === comparison.mapping_id));
      $('tp2-mapping-editor').open = !comparison.mapping_id;
    }
    $('tp2-title').textContent = `${event.event_name} · TP2 ↔ API`; $('tp2-detail-error').textContent = '';
    $('tp2-decoded').textContent = pretty(event.payload); $('tp2-metadata').textContent = pretty({ ...event.tp2, network: event.network }); $('tp2-api-data').textContent = pretty(api);
    $('tp2-comparison').innerHTML = `<p>${pill(comparison.status)} ${esc(comparison.message || '')}</p>` + (comparison.comparisons.length ? `<div class="tp2-table-wrap"><table><thead><tr><th>Trường TP2</th><th>Thực tế TP2</th><th>Trường API</th><th>Giá trị API</th><th>Kết quả</th></tr></thead><tbody>${comparison.comparisons.map(field => `<tr><td>${esc(field.field)}</td><td>${esc(pretty(field.actual))}</td><td>${esc(field.api_field)}</td><td>${esc(pretty(field.expected))}</td><td>${pill(field.status)}<br>${esc(field.reason)}</td></tr>`).join('')}</tbody></table></div>` : '');
    pathSuggestions(); if (!$('tp2-detail').open) $('tp2-detail').showModal();
  }
  $('tp2-list').onclick = event => { const button = event.target.closest('[data-tp2-id]'); if (button) void run(() => details(button.dataset.tp2Id, true))(); };
  $('tp2-close').onclick = () => $('tp2-detail').close();
  $('tp2-api-choice').onchange = run(async () => { await details(selected.event.evidence_id); if (!editingId && selected.api) $('tp2-map-pattern').value = selected.api.path; });
  $('tp2-mapping-choice').onchange = run(async () => { await details(selected.event.evidence_id); editMapping(state.mappings.find(mapping => mapping.id === $('tp2-mapping-choice').value)); });
  $('tp2-map-side').onchange = pathSuggestions;
  $('tp2-add-field').onclick = run(() => { const fields = JSON.parse($('tp2-map-fields').value); fields.push({ event_path: $('tp2-field-event').value.trim(), api_path: $('tp2-field-api').value.trim(), type: $('tp2-field-type').value }); $('tp2-map-fields').value = JSON.stringify(fields, null, 2); });
  $('tp2-suggest').onclick = run(() => {
    const eventPaths = paths(selected.event.payload), apiPaths = paths(selected.api?.[$('tp2-map-side').value]?.body?.json);
    const key = field => field.split('.').at(-1).replace(/_/g, '').toLowerCase();
    const fields = eventPaths.flatMap(field => { const matches = apiPaths.filter(candidate => key(candidate) === key(field)); return matches.length === 1 ? [{ event_path: field, api_path: matches[0], type: 'json' }] : []; });
    $('tp2-map-fields').value = JSON.stringify(fields.slice(0, 100), null, 2); if (!fields.length) throw new Error('Chưa có cặp cùng tên rõ ràng. Hãy thêm cặp trường thủ công.');
  });
  $('tp2-save-mapping').onclick = run(async () => {
    const mapping = { ...(editingId ? { id: editingId } : {}), name: $('tp2-map-name').value, event_name: $('tp2-map-event').value, api_pattern: $('tp2-map-pattern').value,
      api_side: $('tp2-map-side').value, record_path: $('tp2-map-record').value, event_id_path: $('tp2-map-event-id').value, api_id_path: $('tp2-map-api-id').value,
      window_ms: Number($('tp2-map-window').value) * 60000, fields: JSON.parse($('tp2-map-fields').value) };
    state = await post('tp2/mapping', { mapping }); await details(selected.event.evidence_id, true); await refresh(); EventQA.toast('Đã lưu cấu hình đối chiếu.', 'ok');
  });
  $('tp2-delete-mapping').onclick = run(async () => { if (editingId) { state = await post('tp2/mapping', { deleteId: editingId }); await details(selected.event.evidence_id, true); await refresh(); } });
  $('tp2-refresh').onclick = () => void refresh(); $('tp2-filter').onchange = () => { page = 0; void refresh(); }; let timer;
  $('tp2-search').oninput = () => { page = 0; clearTimeout(timer); timer = setTimeout(refresh, 200); };
  $('tp2-prev').onclick = () => { page--; void refresh(); }; $('tp2-next').onclick = () => { page++; void refresh(); };
  new MutationObserver(() => { void refresh(); }).observe(document.querySelector('[data-panel="tp2"]'), { attributes: true, attributeFilter: ['class'] });
  setInterval(() => { void refresh(); }, 3000);
})();
