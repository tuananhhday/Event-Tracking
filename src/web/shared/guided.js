/* Guided Web QA: requirements first, one manual action at a time. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const statuses = { missing: 'Thiếu event', mismatch: 'Có dữ liệu sai', extra: 'Có phần ngoài yêu cầu', match: 'Khớp các kiểm tra', review: 'Cần kiểm tra thêm', pass: 'Khớp các kiểm tra', fail: 'Có lỗi', not_executed: 'Đã bỏ qua' };
  const parameterStatuses = { missing: 'Thiếu', mismatch: 'Sai giá trị', extra: 'Ngoài yêu cầu', match: 'Khớp', review: 'Chưa đủ căn cứ' };
  const ui = { state: null, busy: false, busyId: null, offline: false, upload: null, fileName: '', editing: false, previewStep: null, allowPaidDirty: false, context: new Map(), selectedCaseIds: new Set(), signatures: {}, toastTimer: null, pollTimer: null };
  const guided = () => ui.state?.guided || {};
  const plan = () => guided().plan;
  const planSteps = () => plan()?.steps || [];
  const results = () => guided().results || [];
  const resultStepId = result => result.plan_step_id || result.step_id || result.id;
  const statusOf = item => String(item?.status || item?.verdict || 'review').toLowerCase();
  const badge = (status, text) => `<span class="pill ${esc(status)}">${esc(text || statuses[status] || status)}</span>`;
  const valueText = value => value === undefined ? 'Không ghi nhận' : typeof value === 'string' ? (value === '' ? '""' : value) : JSON.stringify(value, null, 2);
  const shortValue = value => { const text = valueText(value); return text.length > 320 ? text.slice(0, 320) + '…' : text; };
  const basename = value => String(value || '').split(/[\\/]/).at(-1);
  const activeStepId = () => guided().current_step_id || guided().active_step_id || guided().currentStep?.plan_step_id || guided().currentStep?.id || null;
  const recording = () => Boolean(guided().currentStep || guided().current_step_id || ui.state?.currentStep);
  const findResult = id => results().filter(result => resultStepId(result) === id).at(-1);
  const nextStep = () => planSteps().find(step => step.id === activeStepId()) || planSteps().find(step => step.id === ui.previewStep) || planSteps().find(step => !findResult(step.id));

  function error(message = '') { $('error').textContent = message; $('error').classList.toggle('hidden', !message); }
  function notice(message = '') { $('notice').textContent = message; $('notice').classList.toggle('hidden', !message); }
  function toast(message) { clearTimeout(ui.toastTimer); $('toast').textContent = message; $('toast').classList.remove('hidden'); ui.toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 4500); }
  function reasonText(reason) {
    return ({ AI_DISABLED: 'AI đang tắt.', API_KEY_MISSING: 'Chưa có API key.', OPENROUTER_HTTP_401: 'API key chưa hợp lệ.', OPENROUTER_HTTP_402: 'Tài khoản AI chưa đủ credit.', OPENROUTER_HTTP_403: 'Kết nối AI bị từ chối.', OPENROUTER_HTTP_429: 'Các model đang giới hạn lượt gọi.', OPENROUTER_TIMEOUT: 'AI chưa trả lời trong thời gian chờ.', AI_CANCELLED: 'Đã dừng tác vụ AI.', NO_SUITABLE_MODELS: 'Chưa tìm được model phù hợp.' })[reason] || reason || '';
  }
  async function api(route, payload = {}) {
    const response = await fetch(`/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EventQA-Token': token }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => ({ error: 'Ứng dụng chưa trả về dữ liệu. Hãy thử lại.' }));
    if (!response.ok) throw new Error(body.error || `Không thực hiện được thao tác (${response.status}).`);
    if (body.application || body.guided || body.cases || body.session) applyState(body);
    return body;
  }
  function setBusy(value, id = null) {
    ui.busy = value; ui.busyId = value ? id : null;
    for (const button of document.querySelectorAll('button')) {
      if (button.id === 'stop' || button.id === 'toggle-ai') continue;
      button.disabled = value;
      button.classList.toggle('busy', value && button.id === id);
    }
    $('requirement-file').disabled = value || recording();
    $('website-url').disabled = value; $('business-flow').disabled = value || !(ui.state?.cases?.length);
    $('make-plan').disabled = value || !activeSelectedCases().length;
    for (const input of document.querySelectorAll('[data-select-case], #requirement-vendor, #requirement-search, #include-shared')) input.disabled = value || input.dataset.unavailable === 'true';
    $('select-visible').disabled = value || !visibleCases().some(selectable);
    $('clear-visible').disabled = value || !visibleCases().some(c => ui.selectedCaseIds.has(c.id));
    $('clear-selection').disabled = value || !ui.selectedCaseIds.size;
    $('finish').disabled = value || recording() || !results().length || (ui.state?.session?.status === 'COMPLETED' && Boolean(ui.state?.exported));
    if ($('step-action')) $('step-action').disabled = value || !ui.state?.running;
    if ($('skip-step')) $('skip-step').disabled = value || !ui.state?.running;
  }
  async function action(id, operation) {
    if (ui.busy) return;
    error(); setBusy(true, id);
    try { await operation(); }
    catch (failure) { error(failure?.message || 'Không thực hiện được thao tác. Hãy thử lại.'); }
    finally { setBusy(false); render(); }
  }
  function applyState(state) {
    if (!ui.state && state.guided?.plan) {
      for (const id of state.guided.plan.selection?.selected_case_ids || state.guided.selection?.selected_case_ids || state.guided.plan.case_ids || []) ui.selectedCaseIds.add(id);
      const chosen = (state.cases || []).filter(item => ui.selectedCaseIds.has(item.id));
      ui.restoreFlow = chosen.find(item => !commonFlow(item.flow))?.flow || chosen[0]?.flow || state.guided.plan.flow;
      if (chosen.some(item => commonFlow(item.flow))) $('include-shared').checked = true;
    }
    ui.state = state; ui.offline = false; render();
  }
  async function refresh() {
    if (document.hidden) return;
    try {
      const response = await fetch('/api/state?compact=1', { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      applyState(await response.json());
    } catch { ui.offline = true; $('connection').textContent = 'Mất kết nối ứng dụng'; $('connection').classList.add('offline'); }
  }
  function getPath(object, input) {
    let current = object;
    for (const part of String(input).replace(/^context\./, '').replace(/\[(\d+)\]/g, '.$1').split('.')) { if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined; current = current[part]; }
    return current;
  }
  function setPath(object, input, value) {
    const parts = String(input).replace(/^context\./, '').replace(/\[(\d+)\]/g, '.$1').split('.');
    if (parts.some(part => !/^[A-Za-z0-9_$-]+$/.test(part) || ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('Trường dữ liệu trong yêu cầu chưa đúng định dạng.');
    let node = object;
    for (let i = 0; i < parts.length - 1; i++) { if (!Object.hasOwn(node, parts[i])) node[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {}; node = node[parts[i]]; }
    node[parts.at(-1)] = value;
  }
  function fieldLabel(field) {
    if (field.label) return field.label;
    const names = { term: 'Từ khóa tìm kiếm', destination_name: 'Điểm đến đã chọn', destination_id: 'Mã điểm đến', start_date: 'Ngày bắt đầu', end_date: 'Ngày kết thúc', adults: 'Số người lớn', children: 'Số trẻ em', infants: 'Số em bé', quantity: 'Số lượng đã chọn', total: 'Tổng tiền', nights: 'Số đêm', product_id: 'Mã sản phẩm đã chọn' };
    return names[String(field.path).split('.').at(-1)] || String(field.path).replace(/^context\./, '').replaceAll('_', ' ');
  }
  function readContext(step) {
    const context = {};
    for (const field of step.context_fields || []) {
      const input = [...$('current-instruction').querySelectorAll('[data-context-path]')].find(node => node.dataset.contextPath === field.path);
      if (!input) continue;
      const raw = input.type === 'checkbox' ? input.checked : input.value.trim();
      if (raw === '' && field.required !== false) { input.focus(); throw new Error(`Điền ${fieldLabel(field).toLowerCase()} đúng với thao tác bạn sẽ thực hiện.`); }
      if (raw === '') continue;
      let value = raw;
      if (['number', 'integer'].includes(field.type)) { value = Number(raw); if (!Number.isFinite(value)) throw new Error(`${fieldLabel(field)} cần là số.`); }
      if (field.type === 'array') value = raw.split(',').map(part => part.trim()).filter(Boolean);
      setPath(context, field.path, value);
    }
    return context;
  }
  function stepExpected(step) {
    if (Array.isArray(step.expected)) return step.expected;
    if (Array.isArray(step.expected_events)) return step.expected_events;
    const ids = step.case_ids || step.expected_case_ids || [];
    return (ui.state?.cases || []).filter(candidate => ids.includes(candidate.id)).flatMap(candidate => (candidate.rules || []).map(rule => ({ case_id: candidate.id, event_name: rule.event_name, source: rule.source || candidate.source, layer: rule.layer })));
  }

  const plain = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();
  const commonFlow = value => /^(?:all|all luong|chung|common)$/.test(plain(value));
  const caseSources = item => [...new Set([item.source, ...(item.rules || []).map(rule => rule.source)].filter(Boolean))];
  const selectable = item => item.target_platform !== 'APP';
  const parameterCount = item => (item.rules || []).reduce((count, rule) => count + Object.keys(rule.fields || {}).length, 0);
  function inScope(item) {
    const flow = $('business-flow').value;
    return !!flow && (plain(item.flow) === plain(flow) || !commonFlow(flow) && $('include-shared').checked && commonFlow(item.flow));
  }
  const activeSelectedCases = () => (ui.state?.cases || []).filter(item => selectable(item) && inScope(item) && ui.selectedCaseIds.has(item.id));
  function visibleCases() {
    const query = plain($('requirement-search').value), vendor = $('requirement-vendor').value;
    return (ui.state?.cases || []).filter(item => inScope(item) && (!vendor || caseSources(item).includes(vendor)) && (!query || plain([item.name, item.description, item.notes, ...(item.rules || []).map(rule => rule.event_name)].join(' ')).includes(query)));
  }
  function requirementIssues(item) {
    const issues = (item.spec_conflicts || []).map(problem => problem.message || problem.code || 'Mẫu chưa thống nhất với yêu cầu');
    if (item.sample_conflict && !issues.length) issues.push('Payload mẫu chưa thống nhất với tên event hoặc mô tả.');
    if (item.target_platform === 'APP') issues.push('Yêu cầu dành cho App điện thoại; bản này kiểm Web.');
    if (!item.description?.trim()) issues.push('Chưa mô tả thao tác/trigger.');
    if (!parameterCount(item)) issues.push('Chưa có yêu cầu tham số để đối chiếu.');
    else if (item.sample_available === false) issues.push('Chưa đọc được payload mẫu; cần làm rõ phần tham số.');
    return issues;
  }
  function renderSelection() {
    const cases = ui.state?.cases || [], visible = visibleCases(), active = activeSelectedCases();
    $('requirement-selection').classList.toggle('hidden', !cases.length);
    $('include-shared').closest('label').classList.toggle('hidden', commonFlow($('business-flow').value) || !cases.some(item => commonFlow(item.flow)));
    $('selection-count').textContent = active.length ? `Đã chọn ${active.length} yêu cầu để test` : 'Chưa chọn event nào';
    const visibleIds = new Set(visible.map(item => item.id));
    const hidden = active.filter(item => !visibleIds.has(item.id)).length;
    const outside = ui.selectedCaseIds.size - active.length;
    $('selection-hint').textContent = !hasScopeFlow() ? 'Chọn luồng ở trên rồi tích chọn từng event cần kiểm.'
      : `${visible.length} dòng đang hiển thị${hidden ? ` · ${hidden} lựa chọn đang ẩn bởi bộ lọc` : ''}${outside ? ` · ${outside} lựa chọn ngoài phạm vi hiện tại sẽ không được gửi` : ''}. Không chọn không có nghĩa là đã đạt.`;
    $('plan-help').textContent = !cases.length ? 'Nhập file để bắt đầu.' : active.length ? `Chỉ ${active.length} yêu cầu đã chọn được đưa vào hướng dẫn và đánh giá.` : 'Chọn ít nhất một event để tạo hướng dẫn.';
    $('make-plan').querySelector('span').textContent = active.length ? `Hướng dẫn ${active.length} yêu cầu đã chọn` : 'Hướng dẫn phần đã chọn';
    const signature = JSON.stringify([visible.map(item => [item.id, item.description, item.needs_review, item.sample_conflict, item.spec_conflicts, item.rules, item.target_platform, parameterCount(item)]), [...ui.selectedCaseIds], ui.busy]);
    if (signature === ui.signatures.selection) return; ui.signatures.selection = signature;
    $('requirement-list').innerHTML = !hasScopeFlow() ? '<div class="selection-empty">Chọn một luồng để xem các event trong file.</div>' : !visible.length ? '<div class="selection-empty">Không có yêu cầu phù hợp bộ lọc. Các lựa chọn đã đánh dấu vẫn được giữ.</div>' : `<table class="requirements-table"><thead><tr><th class="pick-column">Chọn</th><th>Event / nền tảng</th><th>Thao tác cần test</th><th>Đặc tả</th></tr></thead><tbody>${visible.map(item => {
      const issues = requirementIssues(item), fields = (item.rules || []).flatMap(rule => Object.entries(rule.fields || {}).map(([field, check]) => ({ field, check })));
      const source = caseSources(item).join(' / '), names = (item.rules || []).map(rule => rule.event_name).join(' + ');
      const description = item.description || 'Chưa mô tả trigger';
      return `<tr class="${ui.selectedCaseIds.has(item.id) ? 'selected' : ''}"><td class="pick-column"><input type="checkbox" data-select-case="${esc(item.id)}" data-unavailable="${!selectable(item)}" aria-label="Chọn ${esc(names)} ${esc(source)}" ${ui.selectedCaseIds.has(item.id) ? 'checked' : ''} ${!selectable(item) || ui.busy ? 'disabled' : ''}></td><td><b class="requirement-event">${esc(names || item.name)}</b><span class="event-sub">${esc(source)} · ${esc(item.flow || 'Chưa có luồng')}</span>${item.provenance?.row ? `<small class="event-sub">${esc(item.provenance.sheet)} · dòng ${esc(item.provenance.row)}</small>` : ''}</td><td><p class="trigger-preview">${esc(description.length > 145 ? description.slice(0, 145) + '…' : description)}</p><details class="requirement-details"><summary>Xem đầy đủ thao tác và ${fields.length} trường</summary><p>${esc(description)}</p>${issues.length ? `<ul class="requirement-warnings">${issues.map(issue => `<li>${esc(issue)}</li>`).join('')}</ul>` : ''}<ul class="requirement-fields">${fields.map(({ field, check }) => `<li><code>${esc(field)}</code><span>${esc(check.op)}${check.value !== undefined ? ' · ' + esc(shortValue(check.value)) : ''}</span></li>`).join('')}</ul>${item.notes ? `<p class="help">Ghi chú: ${esc(item.notes)}</p>` : ''}</details></td><td><span class="pill ${issues.length ? 'review' : 'green'}">${issues.length ? item.target_platform === 'APP' ? 'Đặc tả App' : 'Cần làm rõ' : 'Đọc được yêu cầu'}</span><span class="event-sub">${fields.length} trường cần kiểm</span>${issues.length ? `<small class="requirement-warning">${esc(issues[0])}</small>` : ''}</td></tr>`;
    }).join('')}</tbody></table>`;
    for (const input of document.querySelectorAll('[data-select-case]')) input.addEventListener('change', () => {
      if (input.checked) ui.selectedCaseIds.add(input.dataset.selectCase); else ui.selectedCaseIds.delete(input.dataset.selectCase);
      ui.signatures.selection = null; render();
    });
  }
  function hasScopeFlow() { return $('business-flow').value; }

  function renderCompleteness() {
    const current = plan();
    $('scope-completeness').classList.toggle('hidden', !current);
    if (!current) return;
    const selection = current.selection || guided().selection || {};
    const ids = selection.selected_case_ids || current.case_ids || [...new Set(planSteps().flatMap(step => step.case_ids || step.expected_case_ids || []))];
    const completeness = guided().completeness || {};
    const records = ids.map(id => {
      const item = (ui.state?.cases || []).find(c => c.id === id);
      const step = planSteps().find(step => (step.case_ids || step.expected_case_ids || []).includes(id));
      const result = step && findResult(step.id), row = (result?.comparisons || result?.expected || []).find(row => row.case_id === id);
      const declared = completeness.requirements?.find(record => record.case_id === id);
      const status = declared?.status || (result ? statusOf(result) === 'not_executed' ? 'skipped' : row?.status || 'review' : 'pending');
      const pendingParams = declared?.unverified_parameters ?? (row?.parameters || []).filter(p => p.status === 'review').length;
      return { id, item, row, status, pendingParams, executed: !!result && statusOf(result) !== 'not_executed', skipped: !!result && statusOf(result) === 'not_executed' };
    });
    const executed = Number.isFinite(completeness.executed) ? completeness.executed : records.filter(r => r.executed).length;
    const skipped = Number.isFinite(completeness.skipped) ? completeness.skipped : records.filter(r => r.skipped).length;
    const remaining = Number.isFinite(completeness.remaining) ? completeness.remaining : records.length - executed - skipped;
    const excluded = completeness.excluded ?? selection.excluded_case_ids?.length ?? selection.excluded ?? 0;
    const signature = JSON.stringify([current.id, selection, completeness, records.map(r => [r.id, r.status, r.pendingParams]), executed, skipped, remaining, excluded]);
    if (signature === ui.signatures.completeness) return; ui.signatures.completeness = signature;
    const labels = { pending: 'Chưa chạy', not_run: 'Chưa chạy', in_progress: 'Đang ghi nhận', not_executed: 'Đã bỏ qua', skipped: 'Đã bỏ qua', executed: 'Đã thực hiện', missing: 'Thiếu event', mismatch: 'Có phần sai', extra: 'Có phần ngoài yêu cầu', review: 'Cần xác minh', checked_unverified: 'Đã kiểm · còn cần xác minh', verified: 'Đã xác minh', match: 'Khớp phần đã kiểm' };
    $('scope-completeness').innerHTML = `<div class="scope-heading"><strong>Độ phủ phần bạn đã chọn</strong><small>Chỉ đánh giá các yêu cầu đã chọn; phần không chọn và bước bỏ qua không được tính là đạt.</small></div><div class="scope-metrics">${[['Đã chọn', ids.length], ['Đã thực hiện', executed], ['Chưa chạy', remaining], ['Đã bỏ qua', skipped], ['Không chọn', excluded]].map(([label, count]) => `<span><b>${esc(count)}</b>${label}</span>`).join('')}</div><details class="scope-details"><summary>Xem đầy đủ ${ids.length} yêu cầu đã chọn</summary><div class="table-scroll"><table class="scope-table"><thead><tr><th>Event</th><th>Trạng thái</th><th>Đối chiếu tham số</th></tr></thead><tbody>${records.map(record => `<tr><td><strong>${esc(record.item?.rules?.map(rule => rule.event_name).join(' + ') || record.id)}</strong><small class="event-sub">${esc(caseSources(record.item || {}).join(' / '))}</small></td><td>${badge(record.status, labels[record.status] || record.status)}</td><td>${record.pendingParams ? `${esc(record.pendingParams)} trường chưa đủ căn cứ` : !record.executed ? 'Chưa kiểm tra' : !record.row?.actual_count ? 'Chưa có payload phù hợp để kiểm params' : record.row.needs_review ? 'Đã đối chiếu, yêu cầu còn cần xác nhận' : 'Xem các phép kiểm trong kết quả'}</td></tr>`).join('')}</tbody></table></div></details>`;
  }

  function renderSetup() {
    const cases = ui.state?.cases || [];
    const signature = JSON.stringify(cases.map(candidate => [candidate.id, candidate.flow, candidate.source]));
    if (signature !== ui.signatures.cases) {
      ui.signatures.cases = signature;
      const select = $('business-flow'), current = select.value;
      let flows = [...new Set(cases.map(candidate => candidate.flow).filter(Boolean))];
      select.innerHTML = cases.length ? '<option value="">Chọn luồng cần kiểm tra</option>' + flows.map(flow => `<option value="${esc(flow)}">${esc(flow)}</option>`).join('') : '<option value="">Nhập file yêu cầu trước</option>';
      if (flows.includes(current)) select.value = current; else if (ui.restoreFlow && flows.some(flow => plain(flow) === plain(ui.restoreFlow) || (ui.state.flows?.[ui.restoreFlow] && plain(flow) === plain(ui.state.flows[ui.restoreFlow])))) select.value = flows.find(flow => plain(flow) === plain(ui.restoreFlow) || plain(flow) === plain(ui.state.flows?.[ui.restoreFlow])); else if (flows.length === 1) select.value = flows[0];
      const sources = [...new Set(cases.map(candidate => candidate.source).filter(Boolean))];
      $('file-summary').innerHTML = cases.length ? `<span>✓ Đã đọc <strong>${cases.length} event</strong></span><span class="muted">· ${flows.length} luồng</span>${sources.map(source => `<span class="pill">${esc(source)}</span>`).join('')}` : '';
      $('file-summary').classList.toggle('hidden', !cases.length);
      $('requirement-vendor').innerHTML = '<option value="">Tất cả nền tảng</option>' + sources.map(source => `<option value="${esc(source)}">${esc(source)}</option>`).join('');
      const validIds = new Set(cases.map(c => c.id));
      for (const id of ui.selectedCaseIds) if (!validIds.has(id)) ui.selectedCaseIds.delete(id);
      if (!ui.fileName && cases.length) { const file = basename(cases[0].provenance?.file); if (file) { $('file-label').textContent = file; $('file-help').textContent = 'Yêu cầu đang được nạp trong ứng dụng'; } }
    }
    const ai = ui.state?.ai || {};
    $('ai-status').textContent = ai.enabled && ai.configured_key_count ? `Đã lưu key · miễn phí trước${ai.allow_paid ? ', trả phí rẻ nhất sau' : ', chỉ dùng model free'}` : 'Chưa có key · mở để kết nối trợ lý AI';
    if (!ui.allowPaidDirty && document.activeElement !== $('allow-paid') && typeof ai.allow_paid === 'boolean') $('allow-paid').checked = ai.allow_paid;
    const visibleSetup = !plan() || ui.editing;
    $('setup').classList.toggle('hidden', !visibleSetup);
    $('guide').classList.toggle('hidden', !plan() || ui.editing);
  }
  function renderProgress() {
    const phase = results().length && !nextStep() && !ui.editing ? 'results' : plan() && !ui.editing ? 'steps' : ui.state?.cases?.length ? 'website' : 'file';
    const order = ['file', 'website', 'steps', 'results'];
    for (const node of document.querySelectorAll('[data-phase]')) { const index = order.indexOf(node.dataset.phase); node.classList.toggle('active', node.dataset.phase === phase); node.classList.toggle('done', index < order.indexOf(phase)); }
    $('connection').textContent = ui.offline ? 'Mất kết nối ứng dụng' : recording() ? 'Đang ghi nhận thao tác' : 'Đã kết nối';
    $('connection').classList.toggle('offline', ui.offline);
    $('stop').classList.toggle('hidden', !ui.state?.running && !recording() && ui.busyId !== 'make-plan' && guided().status !== 'PLANNING');
  }
  function renderGuide() {
    const currentPlan = plan(); if (!currentPlan) return;
    $('plan-title').textContent = currentPlan.title || `Kiểm tra luồng ${currentPlan.flow || ''}`;
    const target = currentPlan.url || ui.state?.session?.target_url || '';
    let host = target; try { host = new URL(target).host; } catch {}
    $('plan-meta').textContent = `${currentPlan.flow || ''} · ${planSteps().length} bước${host ? ' · ' + host : ''}`;
    const warnings = currentPlan.warnings || [];
    const fallback = currentPlan.guidance_source && currentPlan.guidance_source !== 'ai';
    const notesSig = JSON.stringify([warnings, fallback, ui.state.navigationError]);
    if (notesSig !== ui.signatures.notes) {
      ui.signatures.notes = notesSig;
      $('plan-notes').innerHTML = (ui.state.navigationError ? `<div class="notice error">${esc(ui.state.navigationError)} Sửa URL hoặc kết nối môi trường trước khi kiểm tra.</div>` : '') + (fallback ? '<div class="notice info">Hướng dẫn hiện được lập từ file yêu cầu. AI chưa trả về hướng dẫn hợp lệ; dữ liệu thực tế vẫn được thu và đối chiếu theo yêu cầu đã nhập.</div>' : '') + (warnings.length ? `<details class="minor-details"><summary>${warnings.length} lưu ý từ yêu cầu cần xem</summary><ul>${warnings.map(warning => `<li>${esc(typeof warning === 'string' ? warning : warning.message || JSON.stringify(warning))}</li>`).join('')}</ul></details>` : '');
    }
    const step = nextStep();
    const outlineSig = JSON.stringify([currentPlan.id, activeStepId(), step?.id, results().map(result => [resultStepId(result), result.status, result.verdict])]);
    if (outlineSig !== ui.signatures.outline) {
      ui.signatures.outline = outlineSig;
      $('step-outline').innerHTML = planSteps().map((item, index) => { const previous = findResult(item.id), skipped = previous && statusOf(previous) === 'not_executed'; return `<li class="${item.id === step?.id ? 'active' : previous && !skipped ? 'done' : ''}"><b>${previous ? skipped ? '–' : '✓' : index + 1}</b><span>${esc(item.title || `Bước ${index + 1}`)}${skipped ? '<small class="event-sub">Đã bỏ qua</small>' : ''}</span></li>`; }).join('');
    }
    $('current-instruction').classList.toggle('hidden', !step);
    $('completion').classList.toggle('hidden', Boolean(step));
    if (!step) return;
    const active = recording() && (activeStepId() === step.id || !activeStepId());
    const signature = JSON.stringify([currentPlan.id, step.id, active, step.context_fields, step.instruction]);
    if (signature === ui.signatures.instruction) return;
    ui.signatures.instruction = signature;
    const index = planSteps().findIndex(item => item.id === step.id), fields = step.context_fields || [];
    const remembered = ui.context.get(step.id) || {};
    const activeContext = guided().currentStep?.context || ui.state?.currentStep?.context || {};
    $('current-instruction').innerHTML = `<div class="step-topline"><span class="step-counter">BƯỚC ${index + 1} / ${planSteps().length}</span>${active ? badge('missing', 'Đang ghi nhận') : badge('review', step.optional ? 'Kịch bản tùy chọn' : 'Sẵn sàng thao tác')}</div><h2 class="step-title">${esc(step.title || `Bước ${index + 1}`)}</h2><p class="step-instruction">${esc(step.instruction || step.description || 'Thực hiện thao tác theo yêu cầu trên website test.')}</p><div class="expected-label">Event cần ghi nhận sau thao tác</div><div class="expected-chips">${stepExpected(step).map(event => `<span class="event-chip"><b>${esc(event.event_name || event.name || event)}</b>${event.source ? `<small>${esc(event.source)}</small>` : ''}</span>`).join('') || '<span class="help">Yêu cầu chưa chỉ rõ event; kết quả sẽ cần kiểm tra thêm.</span>'}</div>${fields.length ? '<p class="context-intro">Điền dữ liệu bạn sẽ chọn trên website để đối chiếu đúng giá trị.</p>' : ''}<div class="context-grid" id="context-fields">${fields.map((field, fieldIndex) => {
      const current = Object.hasOwn(remembered, field.path) ? remembered[field.path] : getPath(activeContext, field.path);
      const type = ['number', 'integer'].includes(field.type) ? 'number' : field.type === 'date' ? 'date' : field.type === 'boolean' ? 'checkbox' : 'text';
      const label = fieldLabel(field), value = current === undefined || current === null ? '' : Array.isArray(current) ? current.join(', ') : current;
      return `<div><label for="context-${fieldIndex}">${esc(label)}${field.required !== false ? ' <span aria-label="bắt buộc">*</span>' : ''}</label><input id="context-${fieldIndex}" data-context-path="${esc(field.path)}" type="${type}" ${type === 'checkbox' ? value === true || value === 'true' ? 'checked' : '' : `value="${esc(value)}"`} ${type === 'number' ? 'step="any"' : ''} ${active ? 'disabled' : ''} placeholder="${esc(field.placeholder || (field.type === 'array' ? 'Các giá trị cách nhau bằng dấu phẩy' : 'Giá trị bạn sẽ thao tác'))}">${field.help || field.description ? `<span class="help">${esc(field.help || field.description)}</span>` : ''}</div>`;
    }).join('')}</div>${active ? '<div class="recording-note"><span class="recording-dot"></span><span>Đang ghi nhận. Chuyển sang cửa sổ website test, thực hiện thao tác phía trên rồi quay lại đây.</span></div>' : '<p class="help">Bấm bắt đầu trước khi thao tác để phân biệt event của bước này.</p>'}<div class="actions"><button type="button" class="button ${active ? 'recording' : 'primary'}" id="step-action" data-step-id="${esc(step.id)}" data-step-action="${active ? 'complete' : 'start'}">${active ? 'Tôi đã thao tác xong · Kiểm tra' : 'Bắt đầu bước'}</button>${!active ? '<button type="button" class="quiet" id="skip-step">Bỏ qua bước này</button>' : ''}</div>`;
    const contextGrid = $('context-fields');
    const optionalNodes = [...contextGrid.children].filter(node => fields.find(field => field.path === node.querySelector('[data-context-path]')?.dataset.contextPath)?.required === false);
    if (optionalNodes.length) {
      const details = document.createElement('details'); details.className = 'minor-details';
      const summary = document.createElement('summary'); summary.textContent = 'Đối chiếu thêm giá trị cụ thể (tùy chọn)';
      const optionalGrid = document.createElement('div'); optionalGrid.className = 'context-grid';
      for (const node of optionalNodes) optionalGrid.append(node);
      details.append(summary, optionalGrid); contextGrid.after(details);
      contextGrid.classList.toggle('hidden', !contextGrid.children.length);
    }
    for (const input of $('current-instruction').querySelectorAll('[data-context-path]')) input.addEventListener('input', () => {
      const values = ui.context.get(step.id) || {};
      values[input.dataset.contextPath] = input.type === 'checkbox' ? input.checked : input.value;
      ui.context.set(step.id, values);
    });
    $('step-action').addEventListener('click', () => action('step-action', async () => {
      if (active) { await api('guided/step/complete'); ui.previewStep = null; toast('Đã đối chiếu. Xem các phần thiếu, thừa hoặc sai phía dưới.'); }
      else { await api('guided/step/start', { stepId: step.id, context: readContext(step) }); toast('Đã bắt đầu ghi nhận. Thao tác trên cửa sổ website test.'); }
    }));
    $('skip-step')?.addEventListener('click', () => action('skip-step', async () => {
      await api('guided/step/skip', { stepId: step.id }); ui.previewStep = null; toast('Đã bỏ qua. Bước này không được tính là lỗi thiếu event.');
    }));
    setBusy(ui.busy, ui.busyId);
  }

  function expectedDescription(parameter) {
    if (parameter.expected_origin === 'operator_context') return valueText(parameter.expected) + ' · giá trị bạn nhập';
    if (parameter.code === 'VALUE_NOT_VERIFIED') {
      if (parameter.constraint?.op === 'type') return `Kiểu dữ liệu: ${valueText(parameter.constraint.value)} · cần thêm giá trị đúng theo thao tác`;
      return 'Cần giá trị đúng từ thao tác để đối chiếu';
    }
    if (parameter.op === 'exists') return 'Phải có giá trị';
    if (parameter.op === 'not_exists') return 'Không được có';
    if (parameter.op === 'ignore') return 'Không kiểm tra';
    if (parameter.op === 'type') return `Kiểu dữ liệu: ${valueText(parameter.expected)}`;
    return valueText(parameter.expected);
  }
  function parameterRows(row) {
    if (Array.isArray(row.parameters)) return row.parameters;
    return [...(row.missing_parameters || []).map(item => typeof item === 'string' ? { path: item, status: 'missing' } : { ...item, status: 'missing' }), ...(row.wrong_parameters || []).map(item => ({ ...item, status: 'mismatch' })), ...(row.extra_parameters || []).map(item => typeof item === 'string' ? { path: item, status: 'extra' } : { ...item, status: 'extra' })];
  }
  function comparisonHtml(row) {
    const actual = row.actual_events || [];
    const names = [...new Set(actual.map(event => event.event_name || event.name).filter(Boolean))];
    const count = row.actual_count ?? actual.length;
    const status = statusOf(row);
    const fields = parameterRows(row);
    const issues = fields.filter(field => statusOf(field) !== 'match' && statusOf(field) !== 'pass');
    const sorted = [...issues, ...fields.filter(field => statusOf(field) === 'match' || statusOf(field) === 'pass')];
    const sample = row.expected_payload_sample ?? row.expected_payload;
    const actualPayload = row.actual_payload ?? actual[0]?.parameters ?? actual[0]?.payload;
    const expectedCount = typeof row.expected_count === 'object' ? `${row.expected_count.min ?? 1}–${row.expected_count.max ?? 1}` : row.expected_count ?? 1;
    const notes = (row.issues || []).map(issue => issueMessage(issue)).filter(Boolean);
    return `<details class="comparison" ${['missing', 'mismatch'].includes(status) ? 'open' : ''}><summary><div><span class="column-label">Event mong muốn</span><span class="event-name">${esc(row.event_name || row.name || 'Chưa rõ tên event')}</span><span class="event-sub">${esc(row.source || '')} · ${esc(expectedCount)} lần</span></div><div><span class="column-label">Event thực tế</span><span class="event-name">${esc(names.join(', ') || (count ? row.event_name : 'Chưa ghi nhận'))}</span><span class="event-sub">${esc(count)} lần${issues.length ? ' · ' + issues.length + ' phần cần xem' : ''}</span></div>${badge(status)}</summary><div class="comparison-content">${notes.length ? `<div class="review-note">${[...new Set(notes)].map(text => `<div>${esc(text)}</div>`).join('')}</div>` : ''}${fields.length ? `<div class="table-scroll"><table class="params"><thead><tr><th>Tham số</th><th>Mong muốn</th><th>Thực tế</th><th>Kết quả</th></tr></thead><tbody>${sorted.slice(0, 200).map(field => { const state = statusOf(field); return `<tr><td>${esc(field.path || field.name || '(event)')}</td><td><pre>${esc(expectedDescription(field))}</pre></td><td><pre>${esc(shortValue(field.actual))}</pre></td><td>${badge(state, field.code === 'VALUE_NOT_VERIFIED' ? 'Chưa kiểm đúng giá trị' : parameterStatuses[state] || field.message || field.code || state)}</td></tr>`; }).join('')}</tbody></table></div>${fields.length > 200 ? '<p class="help">Hiển thị 200 kiểm tra đầu tiên. Bằng chứng đầy đủ được giữ trong báo cáo.</p>' : ''}` : `<p class="no-fields">${count ? 'Chưa có quy tắc tham số đủ rõ để đối chiếu.' : 'Chưa thu được event đáp ứng bước này. Kiểm tra lại thao tác, thời gian chờ và nguồn tracking.'}</p>`}${row.provenance?.sheet ? `<p class="provenance">Nguồn yêu cầu: ${esc(row.provenance.sheet)} · dòng ${esc(row.provenance.row)}</p>` : ''}<details class="technical"><summary>Xem mẫu yêu cầu, JSON thực tế và bằng chứng</summary><div class="payload-grid"><div><h4>Mẫu trong yêu cầu · giá trị ví dụ</h4><pre>${esc(valueText(sample))}</pre></div><div><h4>Tracking thực tế đã ghi nhận</h4><pre>${esc(valueText(actualPayload))}</pre></div></div>${actual.map(event => `<details class="raw-event"><summary>${esc(event.evidence_id || '')} · ${esc(event.source || '')} · ${esc(event.layer || '')}</summary><pre>${esc(JSON.stringify({ event_name: event.event_name, payload: event.payload, parameter_origins: event.parameter_origins, data_layer_model: event.data_layer_model, captured_at: event.captured_at }, null, 2))}</pre></details>`).join('')}</details></div></details>`;
  }
  function issueMessage(issue) {
    if (typeof issue === 'string') return issue;
    if (issue?.message) return issue.message;
    const code = issue?.code;
    const known = { WEBSITE_UNVERIFIED: 'Event được quan sát ở website khác hoặc chưa xác định được trang gốc; chưa dùng để đạt bước này.', MISSING_EVENT: 'Chưa thấy event bắt buộc sau thao tác này.', DUPLICATE_EVENT: 'Event được ghi nhận nhiều lần hơn yêu cầu.', LAYER_UNAVAILABLE: 'Chưa quan sát được nguồn tracking mà yêu cầu cần kiểm.', STEP_NOT_COMPLETED: 'Bước thao tác chưa hoàn tất.', CAPTURE_UNAVAILABLE: 'Chưa đọc được bằng chứng đủ rõ để kết luận thiếu event.', FLOW_UNVERIFIED: 'Chưa xác định được event thuộc đúng luồng đang kiểm.', FLOW_CONFLICT: 'Luồng trong URL và dữ liệu event chưa thống nhất.', INCOMPLETE_CAPTURE: 'Bằng chứng thu được chưa đầy đủ.', REQUEST_FAILED: 'Request tracking gặp lỗi mạng.', HTTP_ERROR: 'Request tracking trả về lỗi HTTP.', TIMING_EXCEEDED: 'Event phát muộn hơn thời gian yêu cầu.', OUT_OF_ORDER: 'Thứ tự phát event chưa đúng yêu cầu.', NO_EXPECTED_FIELDS: 'Chưa có chi tiết tham số đủ rõ trong yêu cầu.', SPEC_CONFLICT: 'Yêu cầu có nội dung chưa thống nhất, cần xác nhận lại.', INVALID_RULE: 'Quy tắc trong yêu cầu chưa hợp lệ, cần kiểm tra lại.' };
    return known[code] || '';
  }
  function renderResults() {
    const list = results();
    $('results-section').classList.toggle('hidden', !list.length);
    const signature = JSON.stringify(list);
    if (signature !== ui.signatures.results) {
      ui.signatures.results = signature;
      const totals = { steps: list.filter(result => statusOf(result) !== 'not_executed').length, skipped: list.filter(result => statusOf(result) === 'not_executed').length, missing: 0, mismatch: 0, extra: 0, review: 0 };
      for (const result of list) for (const key of ['missing', 'mismatch', 'extra', 'review']) totals[key] += Number(result.counts?.[key]) || 0;
      $('result-summary').innerHTML = [['Bước đã kiểm', totals.steps], ['Thiếu', totals.missing], ['Sai', totals.mismatch], ['Ngoài yêu cầu', totals.extra], ['Cần review', totals.review], ...(totals.skipped ? [['Đã bỏ qua', totals.skipped]] : [])].map(([label, value]) => `<span><b>${value}</b>${esc(label)}</span>`).join('');
      $('results').innerHTML = list.map((result, index) => {
        const stepId = resultStepId(result), step = planSteps().find(item => item.id === stepId), status = statusOf(result);
        const rows = result.expected || result.comparisons || [];
        const extras = result.extra_events || result.unexpected_events || [];
        const observations = result.observations || [];
        const review = String(result.acceptance_status).toLowerCase() === 'review' || String(result.verdict).toUpperCase() === 'REVIEW' || rows.some(row => row.needs_review);
        return `<article class="card result-card"><div class="result-head"><div><h3>${esc(result.title || step?.title || `Bước ${index + 1}`)}</h3><p>${esc(result.summary || '')}</p></div>${badge(status)}</div><div class="result-body">${review ? '<p class="review-note">Chưa kết luận nghiệm thu: còn yêu cầu chưa duyệt hoặc giá trị chưa có đủ căn cứ. Phần thiếu/thừa/sai vẫn được liệt kê bên dưới.</p>' : ''}${result.ai_note_pending ? '<p class="help">AI đang bổ sung nhận xét cho bước này.</p>' : ''}${result.ai_note ? `<p class="result-note"><b>Nhận xét của trợ lý:</b> ${esc(result.ai_note)}</p>` : ''}${rows.map(comparisonHtml).join('')}${extras.map(event => `<div class="extra-event"><b>Event ngoài yêu cầu bước này:</b> ${esc(event.event_name || event.name || 'Chưa rõ tên')} <span class="pill">${esc(event.source || '')}</span>${event.count ? ' · ' + esc(event.count) + ' lần' : ''}</div>`).join('')}${observations.length ? `<details class="technical"><summary>Các quan sát bổ sung của cùng thao tác (${observations.length})</summary><p class="help">Queue, SDK và request có thể là các bằng chứng của cùng một lần thao tác. Những dòng này không tự động được tính là event gửi lặp.</p>${observations.map(event => `<details class="raw-event"><summary>${esc(event.event_name || event.name || '')} · ${esc(event.source || '')} · ${esc(event.layer || event.observation || '')}</summary><pre>${esc(JSON.stringify(event, null, 2))}</pre></details>`).join('')}</details>` : ''}<button type="button" class="quiet retry-step" data-retry-step="${esc(stepId)}">Kiểm tra lại bước này</button></div></article>`;
      }).join('');
      for (const button of document.querySelectorAll('[data-retry-step]')) button.addEventListener('click', () => {
        if (recording()) return error('Hoàn tất bước đang ghi trước khi kiểm tra lại bước khác.');
        ui.previewStep = button.dataset.retryStep; ui.signatures.instruction = null; render(); $('current-instruction').scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
    const exported = ui.state?.exported || guided().exported || guided().reports || {};
    const labels = { xlsx: 'Tải báo cáo Excel', json: 'Tải dữ liệu JSON', html: 'Xem báo cáo HTML', bugs: 'Tải danh sách lỗi' };
    $('downloads').innerHTML = Object.entries(exported).filter(([, url]) => typeof url === 'string' && /^\/download\/[A-Za-z0-9._-]+$/.test(url)).map(([kind, url]) => `<a href="${esc(url)}" download>${esc(labels[kind] || kind)} <span aria-hidden="true">↓</span></a>`).join('');
  }
  function render() {
    if (!ui.state) return;
    renderSetup(); renderSelection(); renderProgress(); renderGuide(); renderResults(); renderCompleteness(); setBusy(ui.busy, ui.busyId);
  }

  async function importFile(file) {
    if (!file) return;
    if (!/\.(xlsx|json)$/i.test(file.name)) throw new Error('Chọn file Excel .xlsx hoặc .json.');
    if (file.size > 3 * 1024 * 1024) throw new Error('File cần nhỏ hơn 3 MB.');
    if (recording()) throw new Error('Hoàn tất bước đang ghi trước khi thay file yêu cầu.');
    if (ui.state?.running) await api('guided/finish');
    ui.editing = true; ui.fileName = file.name;
    $('file-label').textContent = file.name; $('file-help').textContent = 'Đang đọc file và nhận diện yêu cầu…';
    const content = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('Không đọc được file đã chọn.')); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file); });
    ui.upload = await api('spec-upload', { name: file.name, content });
    const sheets = (ui.upload.sheets || []).map(sheet => typeof sheet === 'string' ? sheet : sheet.name);
    const selected = sheets.includes('Tổng hợp Event tracking') ? 'Tổng hợp Event tracking' : sheets.includes('R1511') ? 'R1511' : sheets[0] || '';
    $('requirement-sheet').innerHTML = sheets.map(sheet => `<option value="${esc(sheet)}">${esc(sheet)}</option>`).join('');
    $('requirement-sheet').value = selected; $('sheet-row').classList.toggle('hidden', sheets.length < 2);
    await importSheet();
  }
  async function importSheet() {
    if (!ui.upload?.path) throw new Error('Chọn file yêu cầu trước.');
    await api('import', { path: ui.upload.path, sheet: $('requirement-sheet').value || undefined });
    $('file-help').textContent = 'Đã đọc yêu cầu · có thể chọn lại sheet bên dưới';
    ui.previewStep = null; ui.context.clear(); ui.selectedCaseIds.clear(); $('requirement-search').value = ''; $('requirement-vendor').value = ''; $('include-shared').checked = false; ui.signatures = {}; render();
    notice('Đã đọc yêu cầu. Chọn luồng rồi tích chọn đúng các event muốn test.');
  }

  for (const id of ['business-flow', 'requirement-vendor', 'include-shared']) $(id).addEventListener('change', () => { ui.signatures.selection = null; render(); });
  $('requirement-search').addEventListener('input', () => { ui.signatures.selection = null; renderSelection(); setBusy(ui.busy, ui.busyId); });
  $('select-visible').addEventListener('click', () => { for (const item of visibleCases().filter(selectable)) ui.selectedCaseIds.add(item.id); ui.signatures.selection = null; render(); });
  $('clear-visible').addEventListener('click', () => { for (const item of visibleCases()) ui.selectedCaseIds.delete(item.id); ui.signatures.selection = null; render(); });
  $('clear-selection').addEventListener('click', () => { ui.selectedCaseIds.clear(); ui.signatures.selection = null; render(); });

  $('requirement-file').addEventListener('change', () => action(null, () => importFile($('requirement-file').files[0])));
  $('read-sheet').addEventListener('click', () => action('read-sheet', importSheet));
  for (const name of ['dragenter', 'dragover']) $('file-drop').addEventListener(name, event => { event.preventDefault(); $('file-drop').classList.add('dragover'); });
  for (const name of ['dragleave', 'drop']) $('file-drop').addEventListener(name, event => { event.preventDefault(); $('file-drop').classList.remove('dragover'); });
  $('file-drop').addEventListener('drop', event => { const file = event.dataTransfer?.files?.[0]; if (file) void action(null, () => importFile(file)); });
  $('toggle-ai').addEventListener('click', () => { $('ai-settings').open = !$('ai-settings').open; if ($('ai-settings').open) { $('ai-settings').scrollIntoView({ block: 'center', behavior: 'smooth' }); $('api-key').focus({ preventScroll: true }); } });
  $('allow-paid').addEventListener('change', () => { ui.allowPaidDirty = true; });
  $('save-key').addEventListener('click', () => action('save-key', async () => {
    const input = $('api-key'), key = input.value.trim();
    if (!key) { input.focus(); throw new Error('Dán API key để lưu trên máy này.'); }
    try { await api('ai-settings', { apiKey: key, allowPaid: $('allow-paid').checked }); ui.allowPaidDirty = false; toast('Đã lưu key trên máy này.'); $('ai-settings').open = false; }
    finally { input.value = ''; }
  }));
  $('make-plan').addEventListener('click', () => action('make-plan', async () => {
    let url = $('website-url').value.trim();
    if (!url) { $('website-url').focus(); throw new Error('Nhập URL website cần kiểm tra.'); }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
    let parsed; try { parsed = new URL(url); } catch { throw new Error('URL website chưa đúng. Ví dụ https://website-uat.vn'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Website cần dùng http hoặc https.');
    const flow = $('business-flow').value; if (!flow) { $('business-flow').focus(); throw new Error('Chọn luồng cần kiểm tra, ví dụ Golf hoặc Vé máy bay.'); }
    const selectedCaseIds = activeSelectedCases().map(c => c.id);
    if (!selectedCaseIds.length) throw new Error('Tích chọn ít nhất một event trong luồng này.');
    $('website-url').value = parsed.toString();
    notice('Đang mở website test và chuẩn bị hướng dẫn từ yêu cầu. Bạn có thể dừng phiên nếu cần.');
    await api('guided/plan', { url: parsed.toString(), flow, browser: $('browser').value, selectedCaseIds });
    ui.editing = false; ui.previewStep = null; ui.signatures = {}; notice(); render();
    $('guide').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }));
  $('change-setup').addEventListener('click', () => action('change-setup', async () => {
    if (recording()) throw new Error('Hoàn tất hoặc dừng bước đang ghi trước khi đổi yêu cầu.');
    if (ui.state?.running) await api('guided/finish');
    ui.editing = true; render(); $('setup').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }));
  $('finish').addEventListener('click', () => action('finish', async () => {
    await api('guided/finish'); toast('Đã lưu kết quả. Chọn file báo cáo cần tải phía dưới.');
    $('downloads').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }));
  $('stop').addEventListener('click', async () => {
    error();
    try { await api('stop-session'); notice('Đã dừng và giữ lại bằng chứng. Bước đang thực hiện cần kiểm tra lại.'); }
    catch (failure) { error(failure.message); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  async function poll() { await refresh(); ui.pollTimer = setTimeout(poll, 1600); }
  void poll();
})();
