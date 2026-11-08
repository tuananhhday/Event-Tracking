// Automation has its own state polling; execution and event capture stay on the local server.
(() => {
  'use strict';
  const panel = document.getElementById('automation-panel');
  if (!panel) return;
  const $ = id => document.getElementById(`automation-${id}`);
  const esc = EventQA.esc;
  const selected = new Set();
  let state = { workflows: [], run: null, exploration: null, history: [], busy: false }, currentWorkflow = null;
  let localBusy = false, polling = false, dirty = false, listSignature = '', runSignature = '', historySignature = '', exploreSignature = '', appliedExploration = null, waitingTitle = null;
  // A reload must not reopen a draft that was already shown (and maybe saved).
  try { appliedExploration = sessionStorage.getItem('eventqa-applied-exploration'); } catch { /* storage may be unavailable */ }
  const statusNames = { RUNNING: 'Đang chạy', COMPLETED: 'Hoàn tất', FAILED: 'Có lỗi', CANCELLED: 'Đã dừng', PENDING: 'Đang chờ', SCHEDULED: 'Theo lịch',
    PARTIAL: 'Dừng giữa chừng', STOPPED: 'Dừng trước nút đặt/thanh toán', SKIPPED: 'Bỏ qua', WAITING_USER: 'Chờ bạn' };
  const statusClass = status => status === 'COMPLETED' ? 'PASS' : status === 'FAILED' ? 'FAIL' : 'REVIEW';
  const pill = status => `<span class="pill ${statusClass(status)}">${esc(statusNames[status] || status || 'Chưa chạy')}</span>`;
  const exploring = () => ['RUNNING', 'WAITING_USER'].includes(state.exploration?.status);
  const active = () => state.busy || state.run?.status === 'RUNNING' || exploring();
  const eventList = events => (events || []).map(item => `${item.source ? `${item.source} · ` : ''}${item.event_name}${item.count > 1 ? ` ×${item.count}` : ''}`).join(', ');
  const visible = () => !panel.classList.contains('hidden');
  const date = value => { try { return value ? new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—'; } catch { return '—'; } };
  const clock = value => { try { return new Date(value).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }); } catch { return ''; } };
  const displayHost = value => { try { return new URL(value).hostname; } catch { return value || ''; } };
  function message(text, error = false) {
    const box = $(error ? 'error' : 'message'), other = $(error ? 'message' : 'error');
    other.classList.add('hidden'); box.textContent = text; box.classList.toggle('hidden', !text);
  }
  function objectJson(text, name) {
    let value;
    try { value = JSON.parse(text.trim() || '{}'); } catch { throw new Error(`${name} chưa đúng JSON. Kiểm tra dấu nháy và dấu phẩy.`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} cần là một đối tượng JSON, ví dụ {"destination":"Phú Quốc"}.`);
    return value;
  }
  function website() {
    let parsed;
    try { parsed = new URL($('url').value.trim()); } catch { throw new Error('Nhập địa chỉ website đầy đủ, bắt đầu bằng https:// hoặc http://.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Website cần bắt đầu bằng https:// hoặc http://.');
    return parsed.toString();
  }
  async function request(route, body) {
    const response = await fetch(`/api/automation/${route}`, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EventQA-Token': typeof token === 'undefined' ? '' : token }, body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Không thực hiện được thao tác (HTTP ${response.status}).`);
    return result;
  }
  async function action(task) {
    if (localBusy) return;
    localBusy = true; updateControls(); message('');
    try { await task(); }
    catch (error) { message(error.message || 'Thao tác chưa hoàn tất.', true); }
    finally { localBusy = false; updateControls(); }
  }
  function acceptState(result) {
    if (!Array.isArray(result?.workflows)) return;
    state = { ...state, ...result };
    const ids = new Set(state.workflows.map(workflow => workflow.id));
    for (const id of selected) if (!ids.has(id)) selected.delete(id);
    render();
  }
  async function refresh(force = false) {
    if (polling || (!force && (!visible() && !active())) || document.hidden) return;
    polling = true;
    try { const before = state.run?.status; acceptState(await request('state')); if (before === 'RUNNING' && state.run?.status !== 'RUNNING') void EventQA.refresh(); }
    catch (error) { if (visible()) message(error.message, true); }
    finally { polling = false; }
  }
  function updateControls() {
    const blocked = localBusy || active();
    for (const button of panel.querySelectorAll('[data-auto-idle]')) button.disabled = blocked;
    $('save').disabled = blocked || !$('json').value.trim();
    $('run-current').disabled = blocked || !currentWorkflow?.id || dirty || !!state.session_running;
    $('run-selected').disabled = blocked || !selected.size || !!state.session_running;
    $('run-selected').textContent = selected.size ? `Chạy ${selected.size} luồng đã chọn` : 'Chạy các luồng đã chọn';
    $('select-all').disabled = blocked || !state.workflows.length;
    $('select-all').checked = !!state.workflows.length && selected.size === state.workflows.length;
    $('select-all').indeterminate = selected.size > 0 && selected.size < state.workflows.length;
    $('cancel').classList.toggle('hidden', !active()); $('cancel').disabled = localBusy;
    $('cancel').textContent = exploring() ? 'Dừng AI chạy thử' : 'Dừng lượt chạy';
    for (const control of panel.querySelectorAll('[data-auto-select], [data-auto-run], [data-auto-delete]')) control.disabled = blocked || (control.hasAttribute('data-auto-run') && !!state.session_running);
    $('session-hint').textContent = state.session_running && !active() ? 'Đang có phiên thu thập thủ công. Kết thúc phiên đó trước khi chạy luồng tự động.' : 'Các luồng trong cùng lượt chạy lần lượt, dùng cùng một trình duyệt.';
    $('draft-badge').classList.toggle('hidden', !dirty);
    $('save-state').textContent = dirty ? 'Có thay đổi chưa lưu.' : currentWorkflow?.id ? 'Đã lưu. Có thể chạy ngay hoặc dùng lịch đã đặt.' : 'Xem lại các bước trước khi lưu.';
    $('save-state').classList.toggle('automation-save-dirty', dirty);
  }
  function renderLibrary() {
    const signature = JSON.stringify([state.workflows, [...selected], currentWorkflow?.id]);
    if (signature === listSignature) return;
    listSignature = signature; $('count').textContent = state.workflows.length;
    $('workflows').innerHTML = state.workflows.length ? state.workflows.map(workflow => `<article class="automation-workflow${workflow.id === currentWorkflow?.id ? ' is-editing' : ''}">
      <div class="automation-workflow-top"><input type="checkbox" data-auto-select="${esc(workflow.id)}" aria-label="Chọn ${esc(workflow.name)}"${selected.has(workflow.id) ? ' checked' : ''}><button type="button" class="automation-workflow-name" data-auto-open="${esc(workflow.id)}">${esc(workflow.name)}</button></div>
      <p class="automation-workflow-meta">${esc(displayHost(workflow.url))}<br>${workflow.browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'} · ${workflow.steps?.length || 0} bước<br>${workflow.schedule?.enabled ? `Tự chạy ${esc(workflow.schedule.time)} · giờ Việt Nam` : 'Chạy khi bạn chọn'}</p>
      <div class="automation-workflow-actions"><button type="button" class="btn small" data-auto-open="${esc(workflow.id)}">Chỉnh sửa</button><button type="button" class="btn small primary" data-auto-run="${esc(workflow.id)}">Chạy</button><button type="button" class="btn small ghost" data-auto-delete="${esc(workflow.id)}">Xóa</button></div></article>`).join('') : '<p class="hint">Chưa có luồng nào. Tạo kịch bản đầu tiên bằng hướng dẫn hoặc file của bạn.</p>';
  }
  function locatorText(locator) {
    if (!locator) return 'thành phần trên trang';
    return `“${locator.value || locator.role}”${locator.within?.text ? ` trong khối “${locator.within.text}”` : ''}${locator.nth !== undefined ? ` (vị trí ${locator.nth + 1})` : ''}`;
  }
  function actionText(item) {
    const target = locatorText(item.locator);
    switch (item.type) {
      case 'goto': return `Mở ${item.url || ''}`;
      case 'click': return `Bấm ${target}`;
      case 'hover': return `Rê chuột lên ${target}`;
      case 'fill': return `Nhập “${item.value ?? ''}” vào ${target}`;
      case 'type': return `Gõ từng phím “${item.value ?? ''}” vào ${target}`;
      case 'select': return `Chọn “${[].concat(item.value ?? '').join(', ')}” tại ${target}`;
      case 'check': return `${item.checked === false ? 'Bỏ chọn' : 'Đánh dấu'} ${target}`;
      case 'press': return `Nhấn ${item.key || ''} tại ${target}`;
      case 'scroll': return `Cuộn trang ${item.direction === 'up' ? 'lên' : 'xuống'}`;
      case 'wait_ms': return `Chờ ${item.ms ?? 0} ms`;
      case 'wait_for': return `Chờ ${target} ${item.state === 'hidden' ? 'ẩn đi' : 'xuất hiện'}`;
      case 'assert_text': return `Kiểm tra ${target} chứa “${item.text ?? ''}”`;
      case 'assert_url': return `Kiểm tra địa chỉ trang: ${item.url || ''}`;
      case 'wait_url': return `Kiểm tra đã tới trang có “${item.contains || ''}”`;
      default: return 'Thao tác chưa được hỗ trợ';
    }
  }
  function actionBadges(item) {
    return `${item.optional ? '<span class="automation-badge">nếu có</span>' : ''}${item.irreversible ? '<span class="automation-badge danger">đặt/thanh toán thật</span>' : ''}`;
  }
  function preview(workflow) {
    const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
    $('step-count').textContent = steps.length ? `${steps.length} bước` : '';
    $('preview').innerHTML = steps.length ? `<ol class="automation-preview-steps">${steps.map(step => `<li class="automation-preview-step"><strong>${esc(step.name || step.id || 'Bước chưa có tên')}${step.pending ? '<span class="automation-badge warn">AI làm khi chạy</span>' : ''}</strong>${step.note ? `<span class="automation-step-note">${esc(step.note)}</span>` : ''}<ul>${(step.actions || []).map(item => `<li>${esc(actionText(item))}${actionBadges(item)}</li>`).join('')}</ul>${step.expected_events?.length ? `<span class="automation-expected">Event mong đợi: ${step.expected_events.map(item => esc(`${item.source ? `${item.source} · ` : ''}${item.event_name}`)).join(', ')}</span>` : ''}${step.observed_events?.length ? `<span class="automation-events">Event thấy khi AI chạy thử: ${esc(eventList(step.observed_events))}</span>` : ''}${step.case_id ? `<span class="automation-expected">Đối chiếu case: ${esc(step.case_id)}</span>` : ''}</li>`).join('')}</ol>` : '<p class="hint">Các bước xuất hiện ở đây sau khi AI chạy thử hoặc nạp JSON.</p>';
  }
  function applyWorkflow(value, { saved = false } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.steps)) throw new Error('Kịch bản cần có danh sách steps. Hãy nạp một file JSON kịch bản hoặc cho AI chạy thử để tạo kịch bản.');
    if (value.steps.some(step => !step || typeof step !== 'object' || !Array.isArray(step.actions) || step.expected_events !== undefined && !Array.isArray(step.expected_events))) throw new Error('Mỗi bước cần có danh sách actions; expected_events nếu có cũng phải là một danh sách.');
    const workflow = structuredClone(value);
    if (!saved) { delete workflow.id; workflow.schedule = { ...workflow.schedule, enabled: false }; }
    currentWorkflow = workflow; dirty = !saved;
    $('name').value = workflow.name || ''; $('url').value = workflow.url || ''; $('browser').value = workflow.browser === 'edge' ? 'edge' : 'chrome';
    $('variables').value = JSON.stringify(workflow.variables || {}, null, 2);
    $('schedule-enabled').checked = saved && !!workflow.schedule?.enabled; $('schedule-time').value = workflow.schedule?.time || '07:00';
    $('export-report').checked = workflow.export_report !== false; $('ai-heal').checked = workflow.ai_heal !== false;
    if (workflow.instructions && !$('instructions').value.trim()) $('instructions').value = workflow.instructions;
    $('json').value = JSON.stringify(workflow, null, 2); $('editor-title').textContent = saved ? 'Chỉnh sửa luồng' : 'Xem lại kịch bản';
    preview(workflow); renderLibrary(); updateControls();
  }
  function newWorkflow() {
    currentWorkflow = null; dirty = false;
    for (const name of ['name', 'url', 'instructions', 'json']) $(name).value = '';
    $('browser').value = 'chrome'; $('variables').value = '{}'; $('schedule-enabled').checked = false; $('schedule-time').value = '07:00';
    $('export-report').checked = true; $('ai-heal').checked = true; $('allow-irreversible').checked = false;
    $('file').value = ''; $('file-name').textContent = 'TXT, Markdown hoặc JSON · tối đa 1 MB';
    if (!exploring()) $('explore-status').classList.add('hidden');
    $('editor-title').textContent = 'Tạo luồng mới'; $('advanced').open = false;
    preview(null); renderLibrary(); updateControls(); message(''); $('name').focus();
  }
  /** Fills empty name/URL/browser fields from the scenario's own data lines. */
  function prefillFromScenario(text) {
    const value = key => text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'mi'))?.[1] || '';
    const site = value('website_url') || value('url');
    if (!$('url').value.trim() && /^https?:\/\//i.test(site)) $('url').value = site;
    if (/^(chrome|edge)$/i.test(value('browser'))) $('browser').value = value('browser').toLowerCase();
    const title = text.split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
    if (!$('name').value.trim() && title && !title.startsWith('{')) $('name').value = title.replace(/^(LUỒNG|Luồng)\s*:\s*/, '').slice(0, 200);
  }
  function readWorkflow() {
    const workflow = objectJson($('json').value, 'Kịch bản');
    if (!Array.isArray(workflow.steps) || !workflow.steps.length) throw new Error('Kịch bản cần ít nhất một bước thực hiện.');
    const name = $('name').value.trim(); if (!name) throw new Error('Điền tên luồng trước khi lưu.');
    const variables = objectJson($('variables').value, 'Giá trị dùng lại');
    const time = $('schedule-time').value || '07:00';
    return { ...workflow, ...(currentWorkflow?.id ? { id: currentWorkflow.id } : {}), schema_version: '1.0', name, url: website(), browser: $('browser').value, variables,
      export_report: $('export-report').checked, ai_heal: $('ai-heal').checked, schedule: { ...workflow.schedule, enabled: $('schedule-enabled').checked, time, timezone: 'Asia/Ho_Chi_Minh', days: workflow.schedule?.days || [0, 1, 2, 3, 4, 5, 6] } };
  }
  function progressText(item) {
    if (item.message) return item.message;
    const workflow = state.workflows.find(value => value.id === item.workflow_id)?.name || 'Luồng';
    const step = state.workflows.find(value => value.id === item.workflow_id)?.steps?.find(value => value.id === item.step_id)?.name || item.step_id || '';
    const names = { 'workflow-start': `Bắt đầu ${workflow}`, 'step-start': `Đang thực hiện: ${step}`, 'action-start': `Thực hiện thao tác ${(item.action_index ?? 0) + 1}`, 'action-complete': `Xong thao tác ${(item.action_index ?? 0) + 1}`, 'step-complete': `Hoàn tất: ${step}`, 'workflow-complete': `Kết thúc ${workflow}` };
    return names[item.type] || step || workflow;
  }
  function renderRun() {
    const run = state.run, signature = JSON.stringify(run);
    if (signature === runSignature) return;
    runSignature = signature;
    if (!run) { $('run').innerHTML = '<p class="hint">Chưa có lượt chạy tự động.</p>'; return; }
    const names = run.workflow_names?.join(', ') || run.workflow_ids?.map(id => state.workflows.find(value => value.id === id)?.name || id).join(', ') || 'Lượt chạy tự động';
    $('run').innerHTML = `<div class="automation-run-overview"><strong>${esc(names)}</strong>${pill(run.status)}</div><p class="hint">Bắt đầu ${esc(date(run.started_at))}${run.completed_at ? ` · Kết thúc ${esc(date(run.completed_at))}` : ''}</p>${run.error ? `<div class="banner error">${esc(run.error)}</div>` : ''}
      ${run.progress?.length ? `<ol class="automation-progress">${run.progress.slice(-10).map(item => `<li><time>${esc(clock(item.at))}</time><span>${esc(progressText(item))}</span></li>`).join('')}</ol>` : ''}
      ${run.ai_usage?.calls ? `<p class="hint">AI tự sửa đã dùng ${run.ai_usage.calls} lần gọi (~$${Number(run.ai_usage.cost_usd || 0).toFixed(4)}).</p>` : ''}
      ${(run.results || []).map(result => `<details class="automation-result" open><summary>${pill(result.status)}<strong>${esc(result.name || state.workflows.find(workflow => workflow.id === result.workflow_id)?.name || result.workflow_id)}</strong>${result.assisted_steps ? `<span class="automation-badge warn">AI đã sửa ${result.assisted_steps} bước</span>` : ''}${result.warning ? `<span class="automation-badge warn">${esc(result.warning)}</span>` : ''}</summary>${result.error ? `<p class="field-error">${esc(result.error)}</p>` : ''}<ul>${(result.steps || []).map(step => `<li>${esc(step.name || step.id)} · ${esc(statusNames[step.status] || step.status)}${step.assisted ? `<span class="automation-badge ${step.assisted.status === 'DONE' ? 'warn' : 'danger'}">${step.assisted.reason === 'pending' ? 'AI thực hiện' : 'AI tự sửa'}${step.assisted.status === 'DONE' ? '' : ' chưa xong'}</span>` : ''}${step.missing_events?.length ? `<span class="automation-badge danger">Thiếu: ${esc(eventList(step.missing_events))}</span>` : ''}${step.error ? `<br><span class="field-error">${esc(step.error)}</span>` : ''}${step.assisted?.note ? `<span class="automation-step-note">AI: ${esc(step.assisted.note)}</span>` : ''}${step.observed_events?.length ? `<span class="automation-events">Event gửi lên: ${esc(eventList(step.observed_events))}</span>` : ''}</li>`).join('')}</ul></details>`).join('')}
      ${run.status !== 'RUNNING' ? `<div class="automation-actions"><button type="button" class="btn small" data-setup-stage="report">Mở phần báo cáo</button><button type="button" class="btn small ghost" data-workspace-tab="events">Xem event thu thập</button></div><p class="hint">${run.reports ? 'File đã xuất nằm trong phần Kết thúc &amp; báo cáo.' : 'Bằng chứng đã lưu. Mở phần báo cáo để chọn nội dung cần xuất.'}</p>` : ''}`;
  }
  function renderHistory() {
    const history = state.history || [], signature = JSON.stringify(history);
    if (signature === historySignature) return;
    historySignature = signature;
    $('history').innerHTML = history.length ? `<div class="table-scroll"><table class="automation-history-table"><thead><tr><th>Luồng</th><th>Kết quả</th><th>Bắt đầu</th><th>Kết thúc</th></tr></thead><tbody>${history.slice(0, 30).map(run => `<tr><td><strong>${esc(run.workflow_names?.join(', ') || run.name || run.workflow_id || 'Lượt chạy tự động')}</strong>${run.error ? `<br><span class="field-error">${esc(run.error)}</span>` : ''}</td><td>${pill(run.status)}</td><td>${esc(date(run.started_at))}</td><td>${esc(date(run.completed_at))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">Sau mỗi lượt chạy, kết quả và thời điểm thực hiện xuất hiện ở đây.</p>';
  }
  const exploreLabels = { RUNNING: 'AI đang chạy thử', WAITING_USER: 'Đang chờ bạn thao tác trên trình duyệt test', COMPLETED: 'Đã ghi xong kịch bản', PARTIAL: 'Dừng giữa chừng — đã ghi các bước làm được',
    STOPPED: 'Dừng trước nút đặt/thanh toán — đã ghi thao tác', FAILED: 'AI chạy thử gặp lỗi', CANCELLED: 'Đã dừng AI chạy thử' };
  function renderExploration() {
    const exploration = state.exploration, box = $('explore-status'), signature = JSON.stringify(exploration);
    if (signature === exploreSignature) return;
    exploreSignature = signature;
    // Waiting for the user is visible from the taskbar and brings its box into view.
    const waiting = exploration?.status === 'WAITING_USER';
    if (waiting && waitingTitle === null) { waitingTitle = document.title; document.title = '⏸ Chờ bạn — EventQA'; requestAnimationFrame(() => box.scrollIntoView({ behavior: 'smooth', block: 'center' })); }
    else if (!waiting && waitingTitle !== null) { document.title = waitingTitle; waitingTitle = null; }
    if (!exploration) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const items = (exploration.progress || []).filter(item => item.message).slice(-14);
    const usage = exploration.usage ? `${exploration.usage.calls} lần gọi AI · ~$${Number(exploration.usage.cost_usd || 0).toFixed(4)}${exploration.usage.models?.length ? ` · ${exploration.usage.models.join(', ')}` : ''}` : '';
    const step = exploring() && exploration.steps?.length && exploration.current_step !== undefined
      ? `Bước ${exploration.current_step + 1}/${exploration.steps.length}: ${exploration.current_step_name || exploration.steps[exploration.current_step] || ''}` : '';
    box.innerHTML = `<div class="automation-explore-head"><strong>${esc(exploreLabels[exploration.status] || exploration.status)} · ${esc(exploration.name || '')}</strong>${pill(exploration.status === 'STOPPED' || exploration.status === 'PARTIAL' ? 'PENDING' : exploration.status)}</div>
      ${step ? `<p class="automation-explore-meta">${esc(step)}</p>` : ''}
      ${exploration.status === 'WAITING_USER' ? `<div class="banner info automation-waiting"><strong>Cần bạn:</strong> ${esc(exploration.waiting?.message || 'Thao tác trong cửa sổ trình duyệt test rồi bấm Tiếp tục.')}</div>
        <div class="automation-actions"><button type="button" class="btn primary" data-auto-resume>Tiếp tục — tôi đã xong</button>${exploration.allow_irreversible ? '<span class="hint">Lượt này được phép bấm nút đặt/thanh toán thật.</span>' : ''}<button type="button" class="btn ghost" data-auto-stop>Dừng &amp; giữ các bước đã ghi</button></div>` : ''}
      ${items.length ? `<ol class="automation-progress">${items.map(item => `<li><time>${esc(clock(item.at))}</time><span>${esc(item.message)}${item.actions?.length ? ` → ${esc(item.actions.join('; '))}` : ''}</span></li>`).join('')}</ol>` : ''}
      ${exploration.error ? `<div class="banner ${exploration.status === 'FAILED' ? 'error' : 'info'}">${esc(exploration.error)}</div>` : ''}
      ${usage ? `<p class="automation-explore-meta">${esc(usage)}</p>` : ''}
      ${exploration.status !== 'RUNNING' && exploration.run_dir ? '<div class="automation-actions"><button type="button" class="btn small ghost" data-workspace-tab="events">Xem event thu thập khi chạy thử</button></div>' : ''}`;
    const list = box.querySelector('.automation-progress'); if (list) list.scrollTop = list.scrollHeight;
    // The recorded workflow opens in the editor once, as soon as the exploration ends.
    if (exploration.status !== 'RUNNING' && exploration.workflow && appliedExploration !== exploration.id) {
      appliedExploration = exploration.id;
      try { sessionStorage.setItem('eventqa-applied-exploration', exploration.id); } catch { /* storage may be unavailable */ }
      try {
        applyWorkflow(exploration.workflow);
        message(exploration.status === 'COMPLETED' ? 'AI đã chạy thử xong và ghi lại các bước. Xem lại rồi bấm Lưu luồng; có thể bật lịch chạy hằng ngày.'
          : 'AI đã ghi các bước làm được. Bước đánh dấu “AI làm khi chạy” sẽ do AI thực hiện ở lần chạy (cần bật AI tự sửa), hoặc chỉnh kịch bản rồi cho AI chạy thử lại.');
      } catch (error) { message(error.message, true); }
    }
  }
  function render() { renderLibrary(); renderExploration(); renderRun(); renderHistory(); updateControls(); }
  async function runWorkflows(ids) {
    if (!ids.length) throw new Error('Chọn ít nhất một luồng để chạy.');
    const browsers = new Set(ids.map(id => state.workflows.find(workflow => workflow.id === id)?.browser || 'chrome'));
    if (browsers.size > 1) throw new Error('Các luồng trong cùng lượt cần dùng cùng một trình duyệt. Chọn các luồng Chrome hoặc các luồng Edge để chạy cùng nhau.');
    const variables = objectJson($('run-variables').value, 'Giá trị cho lượt chạy');
    acceptState(await request('run', { ids, variables, aiNotes: false }));
    message('Đã nhận lượt chạy. Bạn có thể theo dõi các bước và event ngay trong ứng dụng.');
    $('run-heading').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); void EventQA.refresh();
  }
  $('new').addEventListener('click', newWorkflow);
  $('refresh').addEventListener('click', () => void refresh(true));
  $('select-all').addEventListener('change', () => { selected.clear(); if ($('select-all').checked) for (const workflow of state.workflows) selected.add(workflow.id); render(); });
  $('run-selected').addEventListener('click', () => void action(() => runWorkflows([...selected])));
  $('run-current').addEventListener('click', () => void action(() => runWorkflows([currentWorkflow.id])));
  $('cancel').addEventListener('click', () => void action(async () => { acceptState(await request('cancel', {})); message('Đã yêu cầu dừng. Bằng chứng đã thu thập được giữ lại.'); void EventQA.refresh(); }));
  $('workflows').addEventListener('change', event => {
    const id = event.target.dataset.autoSelect; if (!id) return;
    if (event.target.checked) selected.add(id); else selected.delete(id); render();
  });
  $('workflows').addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if (button.dataset.autoOpen) {
      const workflow = state.workflows.find(value => value.id === button.dataset.autoOpen); if (!workflow) return;
      $('instructions').value = workflow.instructions || ''; applyWorkflow(workflow, { saved: true }); message('');
    } else if (button.dataset.autoRun) void action(() => runWorkflows([button.dataset.autoRun]));
    else if (button.dataset.autoDelete) void action(async () => {
      const id = button.dataset.autoDelete; acceptState(await request('delete', { id }));
      if (currentWorkflow?.id === id) newWorkflow(); message('Đã xóa luồng khỏi danh sách.');
    });
  });
  $('file').addEventListener('change', () => void action(async () => {
    const file = $('file').files?.[0]; if (!file) return;
    if (!/\.(?:txt|md|json)$/i.test(file.name)) throw new Error('Chọn file TXT, Markdown (.md) hoặc JSON.');
    if (file.size > 1000000) throw new Error('File hướng dẫn vượt quá 1 MB. Rút gọn nội dung rồi chọn lại.');
    const text = await file.text(); $('instructions').value = text; $('file-name').textContent = `${file.name} · ${Math.max(1, Math.ceil(file.size / 1000))} KB`;
    currentWorkflow = null; dirty = false; $('schedule-enabled').checked = false; $('json').value = /\.json$/i.test(file.name) ? text : ''; preview(null); renderLibrary();
    if (!/\.json$/i.test(file.name)) prefillFromScenario(text);
    message(/\.json$/i.test(file.name) ? 'Đã đọc file. Bấm Nạp JSON để xem các bước, không cần gọi AI.' : 'Đã đọc kịch bản. Kiểm tra website, trình duyệt rồi bấm “AI chạy thử & tạo kịch bản”.');
  }));
  $('explore').addEventListener('click', () => void action(async () => {
    const instructions = $('instructions').value.trim();
    if (!instructions) throw new Error('Viết hoặc chọn file kịch bản trước khi cho AI chạy thử.');
    prefillFromScenario(instructions);
    const url = $('url').value.trim() ? website() : '';
    const variables = objectJson($('variables').value, 'Giá trị dùng lại');
    if (state.session_running) throw new Error('Đang có phiên thu thập thủ công. Kết thúc phiên đó trước khi cho AI chạy thử.');
    if ($('allow-irreversible').checked && !confirm('AI sẽ bấm cả nút đặt/thanh toán cuối cùng trên website, có thể tạo đơn thật. Tiếp tục?')) return;
    acceptState(await request('explore', { name: $('name').value.trim(), url, browser: $('browser').value, instructions, variables,
      allowIrreversible: $('allow-irreversible').checked, waitForLogin: $('wait-login').checked }));
    message($('wait-login').checked ? 'Trình duyệt test đang mở. Đăng nhập trên website, sau đó bấm “Tiếp tục — tôi đã xong” bên dưới để AI bắt đầu.'
      : 'AI đang mở trình duyệt test và chạy thử từng bước. Nếu gặp trang đăng nhập, AI sẽ dừng chờ bạn.');
    $('explore-status').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }));
  $('open-browser').addEventListener('click', () => void action(async () => {
    const instructions = $('instructions').value.trim();
    if (instructions) prefillFromScenario(instructions);
    if (!$('url').value.trim()) throw new Error('Nhập website bắt đầu (hoặc chọn file kịch bản có website_url) trước khi mở trình duyệt.');
    acceptState(await request('open-browser', { url: website(), browser: $('browser').value }));
    message('Đã mở cửa sổ trình duyệt test. Đăng nhập trên website; đăng nhập được giữ lại cho AI chạy thử và các lần chạy theo lịch. Xong thì quay lại bấm “AI chạy thử & tạo kịch bản”.');
  }));
  $('explore-status').addEventListener('click', event => {
    const button = event.target.closest('[data-auto-resume], [data-auto-stop]'); if (!button || button.disabled) return;
    button.disabled = true;
    void action(async () => {
      if (button.hasAttribute('data-auto-resume')) { acceptState(await request('resume', {})); message('AI tiếp tục chạy thử từ trang hiện tại.'); }
      else { acceptState(await request('cancel', {})); message('Đã dừng. Các bước đã ghi được mở để bạn xem lại.'); }
    });
  });
  $('load-json').addEventListener('click', () => void action(async () => {
    const source = $('json').value.trim() || $('instructions').value.trim();
    const value = objectJson(source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''), 'Kịch bản');
    applyWorkflow(value.workflow || value); message('Đã nạp kịch bản, không gọi AI. Xem lại các bước rồi lưu. Lịch tự chạy đang tắt.');
  }));
  $('save').addEventListener('click', () => void action(async () => {
    const workflow = readWorkflow(), previousIds = new Set(state.workflows.map(value => value.id));
    const result = await request('save', { workflow }); acceptState(result);
    const saved = state.workflows.find(value => value.id === workflow.id) || state.workflows.find(value => !previousIds.has(value.id) && value.name === workflow.name);
    if (saved) applyWorkflow(saved, { saved: true }); else { dirty = false; currentWorkflow = workflow; }
    message(workflow.schedule.enabled ? `Đã lưu luồng và bật lịch ${workflow.schedule.time} theo giờ Việt Nam.` : 'Đã lưu luồng. Bạn có thể chạy ngay từ danh sách.');
  }));
  for (const name of ['name', 'url', 'browser', 'variables', 'schedule-enabled', 'schedule-time', 'export-report', 'ai-heal', 'json']) $(name).addEventListener('input', () => {
    if ($('json').value.trim()) dirty = true;
    if (name === 'json') { try { preview(JSON.parse($('json').value)); } catch { $('step-count').textContent = 'JSON cần chỉnh lại'; } }
    updateControls();
  });
  const observeTab = () => { if (visible()) { const heading = document.getElementById('board-title'); if (heading) heading.textContent = 'Luồng tự động'; void refresh(true); } };
  new MutationObserver(observeTab).observe(panel, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  void refresh(true); setInterval(() => { void refresh(); }, 1000);
})();
