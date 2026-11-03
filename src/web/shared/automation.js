// Automation has its own state polling; execution and event capture stay on the local server.
(() => {
  'use strict';
  const panel = document.getElementById('automation-panel');
  if (!panel) return;
  const $ = id => document.getElementById(`automation-${id}`);
  const esc = EventQA.esc;
  const selected = new Set();
  let state = { workflows: [], run: null, history: [], busy: false }, currentWorkflow = null;
  let inspected = null, localBusy = false, polling = false, dirty = false, listSignature = '', runSignature = '', historySignature = '';
  const statusNames = { RUNNING: 'Đang chạy', COMPLETED: 'Hoàn tất', FAILED: 'Có lỗi', CANCELLED: 'Đã dừng', PENDING: 'Đang chờ', SCHEDULED: 'Theo lịch' };
  const statusClass = status => status === 'COMPLETED' ? 'PASS' : status === 'FAILED' ? 'FAIL' : 'REVIEW';
  const pill = status => `<span class="pill ${statusClass(status)}">${esc(statusNames[status] || status || 'Chưa chạy')}</span>`;
  const active = () => state.busy || state.run?.status === 'RUNNING';
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
  function locatorText(locator) { return locator?.value || locator?.role || 'thành phần trên trang'; }
  function actionText(item) {
    const target = locatorText(item.locator);
    switch (item.type) {
      case 'goto': return `Mở ${item.url || ''}`;
      case 'click': return `Bấm “${target}”`;
      case 'fill': return `Nhập “${item.value ?? ''}” vào “${target}”`;
      case 'select': return `Chọn “${[].concat(item.value ?? '').join(', ')}” tại “${target}”`;
      case 'check': return `${item.checked === false ? 'Bỏ chọn' : 'Đánh dấu'} “${target}”`;
      case 'press': return `Nhấn ${item.key || ''} tại “${target}”`;
      case 'wait_for': return `Chờ “${target}” ${item.state === 'hidden' ? 'ẩn đi' : 'xuất hiện'}`;
      case 'assert_text': return `Kiểm tra “${target}” chứa “${item.text ?? ''}”`;
      case 'assert_url': return `Kiểm tra địa chỉ trang: ${item.url || ''}`;
      default: return 'Thao tác chưa được hỗ trợ';
    }
  }
  function preview(workflow) {
    const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
    $('step-count').textContent = steps.length ? `${steps.length} bước` : '';
    $('preview').innerHTML = steps.length ? `<ol class="automation-preview-steps">${steps.map(step => `<li class="automation-preview-step"><strong>${esc(step.name || step.id || 'Bước chưa có tên')}</strong><ul>${(step.actions || []).map(item => `<li>${esc(actionText(item))}</li>`).join('')}</ul>${step.expected_events?.length ? `<span class="automation-expected">Event mong đợi: ${step.expected_events.map(item => esc(`${item.source ? `${item.source} · ` : ''}${item.event_name}`)).join(', ')}</span>` : ''}${step.case_id ? `<span class="automation-expected">Đối chiếu case: ${esc(step.case_id)}</span>` : ''}</li>`).join('')}</ol>` : '<p class="hint">Kịch bản xuất hiện ở đây sau khi tạo bằng AI hoặc nạp JSON.</p>';
  }
  function applyWorkflow(value, { saved = false } = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.steps)) throw new Error('Kịch bản cần có danh sách steps. Hãy nạp một file JSON kịch bản hoặc dùng AI tạo kịch bản.');
    if (value.steps.some(step => !step || typeof step !== 'object' || !Array.isArray(step.actions) || step.expected_events !== undefined && !Array.isArray(step.expected_events))) throw new Error('Mỗi bước cần có danh sách actions; expected_events nếu có cũng phải là một danh sách.');
    const workflow = structuredClone(value);
    if (!saved) { delete workflow.id; workflow.schedule = { ...workflow.schedule, enabled: false }; }
    currentWorkflow = workflow; dirty = !saved;
    $('name').value = workflow.name || ''; $('url').value = workflow.url || ''; $('browser').value = workflow.browser === 'edge' ? 'edge' : 'chrome';
    $('variables').value = JSON.stringify(workflow.variables || {}, null, 2);
    $('schedule-enabled').checked = saved && !!workflow.schedule?.enabled; $('schedule-time').value = workflow.schedule?.time || '07:00';
    $('json').value = JSON.stringify(workflow, null, 2); $('editor-title').textContent = saved ? 'Chỉnh sửa luồng' : 'Xem lại kịch bản';
    preview(workflow); renderLibrary(); updateControls();
  }
  function newWorkflow() {
    currentWorkflow = null; inspected = null; dirty = false;
    for (const name of ['name', 'url', 'instructions', 'json']) $(name).value = '';
    $('browser').value = 'chrome'; $('variables').value = '{}'; $('schedule-enabled').checked = false; $('schedule-time').value = '07:00';
    $('file').value = ''; $('file-name').textContent = 'TXT, Markdown hoặc JSON · tối đa 1 MB';
    $('inspect-status').textContent = 'Quan sát trang để AI nhận diện đúng các ô nhập và nút bấm trên website.';
    $('page-details').classList.add('hidden'); $('editor-title').textContent = 'Tạo luồng mới'; $('advanced').open = false;
    preview(null); renderLibrary(); updateControls(); message(''); $('name').focus();
  }
  function readWorkflow() {
    const workflow = objectJson($('json').value, 'Kịch bản');
    if (!Array.isArray(workflow.steps) || !workflow.steps.length) throw new Error('Kịch bản cần ít nhất một bước thực hiện.');
    const name = $('name').value.trim(); if (!name) throw new Error('Điền tên luồng trước khi lưu.');
    const variables = objectJson($('variables').value, 'Giá trị dùng lại');
    const time = $('schedule-time').value || '07:00';
    return { ...workflow, ...(currentWorkflow?.id ? { id: currentWorkflow.id } : {}), schema_version: '1.0', name, url: website(), browser: $('browser').value, variables,
      schedule: { ...workflow.schedule, enabled: $('schedule-enabled').checked, time, timezone: 'Asia/Ho_Chi_Minh', days: workflow.schedule?.days || [0, 1, 2, 3, 4, 5, 6] } };
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
      ${(run.results || []).map(result => `<details class="automation-result"${result.status === 'FAILED' ? ' open' : ''}><summary>${pill(result.status)}<strong>${esc(result.name || state.workflows.find(workflow => workflow.id === result.workflow_id)?.name || result.workflow_id)}</strong></summary>${result.error ? `<p class="field-error">${esc(result.error)}</p>` : ''}<ul>${(result.steps || []).map(step => `<li>${esc(step.name || step.id)} · ${esc(statusNames[step.status] || step.status)}${step.error ? `<br><span class="field-error">${esc(step.error)}</span>` : ''}</li>`).join('')}</ul></details>`).join('')}
      ${run.status !== 'RUNNING' ? '<div class="automation-actions"><button type="button" class="btn small" data-setup-stage="report">Mở phần báo cáo</button><button type="button" class="btn small ghost" data-workspace-tab="events">Xem event thu thập</button></div><p class="hint">File Excel, HTML, JSON và API của phiên nằm trong phần Kết thúc &amp; báo cáo.</p>' : ''}`;
  }
  function renderHistory() {
    const history = state.history || [], signature = JSON.stringify(history);
    if (signature === historySignature) return;
    historySignature = signature;
    $('history').innerHTML = history.length ? `<div class="table-scroll"><table class="automation-history-table"><thead><tr><th>Luồng</th><th>Kết quả</th><th>Bắt đầu</th><th>Kết thúc</th></tr></thead><tbody>${history.slice(0, 30).map(run => `<tr><td><strong>${esc(run.workflow_names?.join(', ') || run.name || run.workflow_id || 'Lượt chạy tự động')}</strong>${run.error ? `<br><span class="field-error">${esc(run.error)}</span>` : ''}</td><td>${pill(run.status)}</td><td>${esc(date(run.started_at))}</td><td>${esc(date(run.completed_at))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">Sau mỗi lượt chạy, kết quả và thời điểm thực hiện xuất hiện ở đây.</p>';
  }
  function render() { renderLibrary(); renderRun(); renderHistory(); updateControls(); }
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
      inspected = null; $('instructions').value = workflow.instructions || ''; $('page-details').classList.add('hidden');
      $('inspect-status').textContent = 'Quan sát lại trang nếu cần AI tạo một kịch bản khác.'; applyWorkflow(workflow, { saved: true }); message('');
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
    message(/\.json$/i.test(file.name) ? 'Đã đọc file. Bấm Nạp JSON để xem các bước, không cần gọi AI.' : 'Đã đọc hướng dẫn. Quan sát trang rồi dùng AI tạo kịch bản.');
  }));
  $('inspect').addEventListener('click', () => void action(async () => {
    const url = website(), browser = $('browser').value; message('Đang mở website và quan sát các ô nhập, nút bấm…');
    const result = await request('inspect', { url, browser }); inspected = { url, browser, page: result.page };
    $('inspect-status').textContent = `Đã quan sát ${result.page?.title || displayHost(result.page?.url || url)}. Có thể tạo kịch bản từ hướng dẫn.`;
    $('page-preview').textContent = JSON.stringify(result.page, null, 2); $('page-details').classList.remove('hidden'); message('Đã quan sát trang. Kiểm tra hướng dẫn rồi bấm AI tạo kịch bản.');
  }));
  $('draft').addEventListener('click', () => void action(async () => {
    const url = website(), browser = $('browser').value, instructions = $('instructions').value.trim(), name = $('name').value.trim();
    if (!instructions) throw new Error('Viết hoặc chọn file hướng dẫn trước khi tạo kịch bản.');
    if (!name) throw new Error('Điền tên luồng trước khi tạo kịch bản.');
    message('AI đang đọc hướng dẫn và đề xuất các bước thực hiện…');
    const page = inspected?.url === url && inspected?.browser === browser ? inspected.page : undefined;
    const result = await request('draft', { name, url, browser, instructions, ...(page ? { page } : {}) });
    if (!result.available || !result.workflow) throw new Error(result.message || ({ AI_DISABLED: 'Bật AI trong tab Trợ lý AI trước khi tạo kịch bản.', API_KEY_MISSING: 'Bật AI trong tab Trợ lý AI trước khi tạo kịch bản.', AI_CANCELLED: 'Đã dừng việc tạo kịch bản.' }[result.reason]) || `Chưa tạo được kịch bản${result.reason ? ` (${result.reason})` : ''}. Có thể nạp JSON có sẵn.`);
    applyWorkflow(result.workflow); message('Đã tạo bản nháp. Xem lại các bước, giá trị nhập và event mong đợi rồi lưu. Lịch tự chạy đang tắt.');
  }));
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
  for (const name of ['name', 'url', 'browser', 'variables', 'schedule-enabled', 'schedule-time', 'json']) $(name).addEventListener('input', () => {
    if ($('json').value.trim()) dirty = true;
    if (name === 'url' || name === 'browser') { inspected = null; $('page-details').classList.add('hidden'); $('inspect-status').textContent = 'Website hoặc trình duyệt đã thay đổi. Quan sát lại trang trước khi tạo bằng AI.'; }
    if (name === 'json') { try { preview(JSON.parse($('json').value)); } catch { $('step-count').textContent = 'JSON cần chỉnh lại'; } }
    updateControls();
  });
  const observeTab = () => { if (visible()) { const heading = document.getElementById('board-title'); if (heading) heading.textContent = 'Luồng tự động'; void refresh(true); } };
  new MutationObserver(observeTab).observe(panel, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  void refresh(true); setInterval(() => { void refresh(); }, 1000);
})();
