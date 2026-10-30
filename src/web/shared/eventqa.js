// EventQA shared client. Each mode page provides its own markup and hooks;
// this file owns polling, the guided flow, live evidence, rule building and reports.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (value, max = 120) => { const text = typeof value === 'string' ? value : JSON.stringify(value); return text === undefined ? '—' : text.length > max ? `${text.slice(0, max)}…` : text; };
  const clock = iso => iso ? new Date(iso).toLocaleTimeString('vi-VN', { hour12: false }) : '';
  const duration = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const store = {
    get(key, fallback) { try { const raw = localStorage.getItem(key); return raw == null ? fallback : JSON.parse(raw); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
  };

  const DEFAULT_VENDORS = ['ga4', 'ga4_server', 'insider'];
  const DEMO_CONTEXTS = {
    'TC-HOTEL-SEARCH-001': { search: { destination_name: 'Phú Quốc', adults: 2, nights: 1 } },
    'TC-MERCH-SEARCH-001': { search: { term: 'snack' } },
    'TC-INSIDER-DETAIL-001': { product: { id: 'SKU-001' } },
  };
  // GA4 Measurement Protocol parameters: transport metadata, not business fields.
  const GA4_PROTOCOL = new Set(['v', 'tid', 'gtm', 'gcd', 'npa', 'dma', 'dma_cps', 'cid', 'ul', 'sr', 'uaa', 'uab', 'uafvl', 'uamb', 'uam', 'uap', 'uapv', 'uaw', 'are', 'frm', 'pscdl', 'sid', 'sct', 'seg', 'dl', 'dr', 'dt', 'tfd', 'ec_mode', 'tag_exp', 'ngs', 'gcs', 'gcu', 'richsstsse', 'pae', 'ir', 'tt', 'apve', 'apvf', 'gtm_up', 'gcut', 'dp', 'ecid', 'en']);
  const ISSUE_TEXT = {
    MISSING_EVENT: 'Không thấy event', DUPLICATE_EVENT: 'Event bị lặp', MISSING_FIELD: 'Thiếu trường', NULL_FIELD: 'Trường rỗng (null)',
    UNEXPECTED_FIELD: 'Có trường không được phép', VALUE_MISMATCH: 'Sai giá trị', DYNAMIC_VALUE_MISMATCH: 'Không khớp context', WRONG_TYPE: 'Sai kiểu dữ liệu',
    HTTP_ERROR: 'Request lỗi HTTP', REQUEST_FAILED: 'Request thất bại', TIMING_EXCEEDED: 'Quá thời gian cho phép', MISSING_TIMING: 'Thiếu mốc thời gian',
    OUT_OF_ORDER: 'Sai thứ tự', ORDER_PREDECESSOR_MISSING: 'Thiếu event đứng trước', MISSING_CONTEXT: 'Context chưa có giá trị này',
    INVALID_RULE: 'Rule không hợp lệ', RULE_NEEDS_REVIEW: 'Rule chưa được duyệt', LAYER_UNAVAILABLE: 'Phương án này không quan sát được tầng này',
    VALUE_TOO_LARGE: 'Giá trị quá lớn để so khớp', REVIEW: 'Cần QC review', NO_EXPECTED_FIELDS: 'Đặc tả chưa có chi tiết payload', INCOMPLETE_CAPTURE: 'Payload thu chưa đầy đủ',
  };
  const VERDICT_TEXT = { PASS: 'PASS', FAIL: 'FAIL', REVIEW: 'REVIEW', NOT_EXECUTED: 'Chưa chạy' };
  const LAYER_TEXT = { JS_QUEUE: 'JS queue', TRACKING_REQUEST: 'Request' };
  const FILE_TEXT = { xlsx: ['Excel', '6 sheet đối chiếu'], html: ['HTML', 'Xem nhanh trên trình duyệt'], json: ['JSON', 'Comparison đầy đủ'], bugs: ['Bug (Markdown)', 'Dán vào Jira thủ công'] };
  const OPS = [['eq', 'bằng'], ['exists', 'có mặt'], ['type', 'kiểu'], ['regex', 'regex'], ['ref', 'lấy từ context'], ['one_of', 'một trong'], ['not_exists', 'không được có'], ['ignore', 'bỏ qua']];

  const ui = { state: null, busy: null, stopped: false, offline: false, selectedCase: null, contexts: new Map(),
    sig: {}, details: new Map(), loadingDetails: new Set(), expandedGroup: null, casesKey: null, holdUntil: 0, holdTimer: null, groupFilter: null, openEvents: new Set(), seenEvents: new Set(), phase: null, tab: 'events', view: 'activity', marker: null,
    activity: [], activityVersion: null, activityNext: null, activityTotal: 0, activitySelected: null,
    hooks: {}, token: '', mode: '', vendorsRendered: false, builder: null };
  const siteKey = () => `eventqa:${ui.mode}:site`;

  // ---- feedback ---------------------------------------------------------
  function toast(message, kind = '') {
    const host = $('toasts'); if (!host) return;
    while (host.children.length >= 3) host.firstElementChild.remove();
    const item = document.createElement('div'); item.className = `toast ${kind}`; item.setAttribute('role', kind === 'error' ? 'alert' : 'status'); item.textContent = message;
    host.append(item); setTimeout(() => item.remove(), kind === 'error' ? 7000 : 3500);
  }
  function showError(message) {
    const box = $('error'); if (!box) return;
    box.textContent = message || ''; box.classList.toggle('hidden', !message);
    if (message) toast(message, 'error');
  }

  // ---- server -----------------------------------------------------------
  async function api(path, data = {}, label = path) {
    ui.busy = label; render(); showError('');
    try {
      const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EventQA-Token': ui.token }, body: JSON.stringify(data) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Thao tác thất bại (HTTP ${response.status}).`);
      if (result.mode) ui.state = result;
      return result;
    } catch (error) { showError(error.message); error.shown = true; throw error; }
    finally { ui.busy = null; await refresh(); }
  }
  async function refresh() {
    if (ui.stopped || ui.refreshing || document.hidden) return;
    ui.refreshing = true;
    try {
      const response = await fetch('/api/state' + (ui.view === 'stream' ? '' : '?compact=1'), { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      ui.state = await response.json(); setOffline(false);
    } catch { setOffline(true); }
    finally { ui.refreshing = false; }
    render();
  }
  async function fetchEvent(id) {
    const local = ui.state?.events.find(e => e.evidence_id === id); if (local && !ui.state?.eventsCompact) return local;
    const response = await fetch(`/api/event?id=${encodeURIComponent(id)}`); if (!response.ok) return null;
    return (await response.json()).event;
  }
  function setOffline(offline) {
    if (ui.offline === offline) return; ui.offline = offline;
    const conn = $('conn'); if (conn) { conn.classList.toggle('offline', offline); conn.textContent = offline ? 'Mất kết nối ứng dụng' : 'Đã kết nối'; }
  }
  const run = fn => () => Promise.resolve().then(fn).catch(error => { if (!error?.shown) showError(error?.message || String(error)); });

  // ---- derived state ----------------------------------------------------
  function phaseOf(s) {
    if (!s) return 'loading';
    if (s.closing) return 'closing';
    if (s.currentStep) return 'recording';
    if (s.running) return 'running';
    if (s.session) return 'finished';
    return 'idle';
  }
  const caseById = id => ui.state?.cases.find(c => c.id === id);
  const caseNeedsReview = c => !!c && (c.needs_review || (c.rules || []).some(r => r.needs_review));
  const latestResult = caseId => (ui.state?.results || []).filter(r => r.test_case_id === caseId && r.step_id).at(-1);
  const afterMarker = e => !ui.marker || Date.parse(e.captured_at) >= ui.marker;

  // ---- site configuration (URL, vendors, endpoints) -------------------------
  function renderVendors(s) {
    const host = $('vendors'); if (!host || ui.vendorsRendered || !s.vendors) return;
    const saved = store.get(siteKey(), {});
    const chosen = new Set(saved.vendors || DEFAULT_VENDORS);
    host.innerHTML = Object.entries(s.vendors).map(([key, vendor]) => `<label class="check"><input type="checkbox" data-vendor="${esc(key)}" ${chosen.has(key) ? 'checked' : ''} data-lock-proxy> ${esc(vendor.label)}</label>`).join('');
    ui.vendorsRendered = true;
  }
  function endpointPatterns() {
    const vendors = ui.state?.vendors || {};
    const patterns = $$('[data-vendor]').filter(box => box.checked).flatMap(box => vendors[box.dataset.vendor]?.patterns || []);
    const custom = ($('patterns')?.value || '').split('\n').map(p => p.trim()).filter(Boolean);
    for (const pattern of custom) { try { new RegExp(pattern); } catch { throw new Error(`Regex endpoint không hợp lệ: ${pattern}`); } }
    return [...new Set([...patterns, ...custom])];
  }
  function saveSite() {
    const saved = store.get(siteKey(), {});
    const url = $('url')?.value.trim();
    const recent = [url, ...(saved.recent || [])].filter((u, i, list) => u && !u.includes('/demo') && list.indexOf(u) === i).slice(0, 6);
    store.set(siteKey(), { ...saved, url, recent, browser: $('browser')?.value, vendors: $$('[data-vendor]').filter(b => b.checked).map(b => b.dataset.vendor), custom: $('patterns')?.value || '' });
    renderRecent();
  }
  function renderRecent() {
    const host = $('recent'); if (!host) return;
    const recent = store.get(siteKey(), {}).recent || [];
    host.innerHTML = recent.map(u => `<button type="button" class="chip" data-url="${esc(u)}" data-lock-running title="${esc(u)}">${esc(hostOf(u))}</button>`).join('');
    host.classList.toggle('hidden', !recent.length);
  }
  function restoreSite() {
    const saved = store.get(siteKey(), {});
    if ($('url') && saved.url) $('url').value = saved.url;
    if ($('patterns') && saved.custom) $('patterns').value = saved.custom;
    if (saved.browser) setBrowser(saved.browser);
    renderRecent();
  }
  function setBrowser(name) { if ($('browser')) $('browser').value = name; for (const b of $$('[data-browser]')) b.setAttribute('aria-pressed', String(b.dataset.browser === name)); }

  // ---- context templates -------------------------------------------------
  function contextTemplate(testCase) {
    if (!testCase) return {};
    if (DEMO_CONTEXTS[testCase.id]) return structuredClone(DEMO_CONTEXTS[testCase.id]);
    const template = {};
    for (const rule of testCase.rules || []) for (const field of Object.values(rule.fields || {})) {
      if (field?.op !== 'ref' || typeof field.value !== 'string' || !field.value.startsWith('context.')) continue;
      const parts = field.value.slice('context.'.length).split('.'); let node = template;
      parts.forEach((part, index) => { if (index === parts.length - 1) node[part] ??= ''; else node = node[part] = typeof node[part] === 'object' && node[part] ? node[part] : {}; });
    }
    return template;
  }
  function emptyLeaves(value, prefix = '') {
    if (value === '' || value === null) return [prefix];
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, child]) => emptyLeaves(child, prefix ? `${prefix}.${key}` : key));
  }
  function parseJson(id, errorId) {
    const area = $(id); const error = $(errorId);
    try { const value = JSON.parse(area.value || '{}'); area.classList.remove('invalid'); if (error) error.textContent = ''; return { ok: true, value }; }
    catch (e) { area.classList.add('invalid'); if (error) error.textContent = `JSON chưa hợp lệ: ${e.message}`; return { ok: false, message: e.message }; }
  }
  function validateContext() {
    const parsed = parseJson('context', 'context-error'); const hint = $('context-hint');
    if (!parsed.ok || !hint) return parsed;
    const empty = emptyLeaves(parsed.value);
    hint.textContent = empty.length ? `Cần điền giá trị thực tế: ${empty.map(p => `context.${p}`).join(', ')}` : '';
    hint.classList.toggle('hidden', !empty.length);
    return parsed;
  }

  // ---- case selection ---------------------------------------------------
  function selectCase(id, { force = false } = {}) {
    if (!force && ui.selectedCase === id) return;
    if (ui.selectedCase && $('context')) ui.contexts.set(ui.selectedCase, $('context').value);
    ui.selectedCase = id; const testCase = caseById(id);
    if ($('context')) { $('context').value = ui.contexts.get(id) ?? JSON.stringify(contextTemplate(testCase), null, 2); validateContext(); }
    loadRuleEditor(testCase);
    ui.sig.cases = null; render();
  }
  function resetSelection() { ui.contexts.clear(); ui.selectedCase = null; ui.sig.cases = null; render(); }
  function loadRuleEditor(testCase) {
    if (!$('case-json')) return;
    $('case-json').value = JSON.stringify(testCase || {}, null, 2);
    $('case-json').classList.remove('invalid'); if ($('case-json-error')) $('case-json-error').textContent = '';
    if ($('approve')) $('approve').checked = !!testCase && !caseNeedsReview(testCase);
    if ($('rule-title')) $('rule-title').textContent = testCase ? testCase.id : '';
  }
  function renderCases(s) {
    const host = $('cases'); if (!host) return;
    if (!s.cases.some(c => c.id === ui.selectedCase)) { const first = s.cases[0]?.id ?? null; if (first !== ui.selectedCase) { ui.selectedCase = null; if (first) return selectCase(first); } }
    const locked = !!s.currentStep;
    $('no-cases')?.classList.toggle('hidden', s.cases.length > 0);
    $('with-cases')?.classList.toggle('hidden', !s.cases.length);
    const sig = JSON.stringify([s.cases.map(c => [c.id, c.name, caseNeedsReview(c)]), ui.selectedCase, locked, s.currentStep?.test_case_id, s.results.map(r => [r.step_id, r.verdict])]);
    if (sig === ui.sig.cases) return; ui.sig.cases = sig;
    host.innerHTML = s.cases.map(c => {
      const last = latestResult(c.id); const active = s.currentStep?.test_case_id === c.id;
      const badge = active ? '<span class="pill FAIL">● Đang ghi</span>' : last ? `<span class="pill ${esc(last.verdict)}">${esc(VERDICT_TEXT[last.verdict] || last.verdict)}</span>` : '<span class="pill">Chưa chạy</span>';
      return `<button type="button" class="case" data-case="${esc(c.id)}" aria-pressed="${c.id === ui.selectedCase}" ${locked ? 'disabled' : ''}>
        <span class="case-main"><strong>${esc(c.name || c.id)}</strong><small>${esc(c.id)} · ${(c.rules || []).length} rule${caseNeedsReview(c) ? ' · <span class="pill warn">Cần duyệt</span>' : ''}</small></span>${badge}</button>`;
    }).join('');
  }

  // ---- flow (stepper) ---------------------------------------------------
  function stageForPhase(phase) { return { idle: 'session', loading: 'session', running: 'step', recording: 'step', finished: 'report', closing: 'report' }[phase]; }
  function setStage(name, open) { const stage = document.querySelector(`[data-stage="${name}"]`); if (stage) { stage.classList.toggle('open', open); stage.querySelector('.stage-head')?.setAttribute('aria-expanded', String(open)); } }
  function renderFlow(s, phase) {
    if (phase !== ui.phase) {
      const target = stageForPhase(phase);
      for (const stage of $$('[data-stage]')) setStage(stage.dataset.stage, stage.dataset.stage === target);
      ui.phase = phase;
    }
    const current = stageForPhase(phase);
    const done = { spec: s.cases.length > 0, session: !!s.session, step: s.results.some(r => r.step_id), report: !!s.exported };
    for (const stage of $$('[data-stage]')) { stage.classList.toggle('current', stage.dataset.stage === current); stage.classList.toggle('done', done[stage.dataset.stage] && stage.dataset.stage !== current); }
    const review = s.cases.filter(caseNeedsReview).length;
    const source = { reviewed: 'rule đã lưu', file: 'từ file', demo: 'demo' }[s.specSource] || '';
    setText('sum-spec', s.cases.length ? `${s.cases.length} case ${source}${review ? ` · ${review} cần duyệt` : ''}` : 'Chưa có · thu thập tự do');
    setText('sum-session', s.running ? `Đang chạy · ${s.session.browser || ''} · ${hostOf(s.session.target_url)}` : s.session ? `Phiên ${s.session.status === 'COMPLETED' ? 'đã kết thúc' : 'đã dừng'}` : 'Nhập URL và mở trình duyệt test');
    const executed = s.results.filter(r => r.step_id).length;
    setText('sum-step', s.currentStep ? `Đang ghi: ${caseById(s.currentStep.test_case_id)?.name || s.currentStep.test_case_id}` : s.cases.length ? `${executed} bước đã chạy` : 'Tạo rule từ event thật để bắt đầu');
    setText('sum-report', s.exported ? 'Báo cáo sẵn sàng tải' : s.running ? 'Kết thúc phiên để xuất' : 'Chưa xuất');
  }
  const hostOf = url => { try { return new URL(url).host; } catch { return url || ''; } };
  const setText = (id, text) => { const el = $(id); if (el && el.textContent !== text) el.textContent = text; };

  // ---- session bar ------------------------------------------------------
  function renderBar(s, phase) {
    const bar = $('sessionbar'); if (!bar) return;
    bar.classList.toggle('recording', phase === 'recording');
    $('phase').className = `phase ${phase}`;
    const explore = phase === 'running' && !s.cases.length;
    setText('phase-label', { loading: 'Đang tải…', idle: 'Chưa mở website', running: explore ? 'Đang thu thập tự do' : 'Phiên đang chạy', recording: 'ĐANG GHI BƯỚC', finished: s.session?.status === 'COMPLETED' ? 'Phiên đã kết thúc' : 'Phiên đã dừng', closing: 'Đang tắt…' }[phase]);
    const meta = [];
    if (s.session) meta.push(`<span>Website <b>${esc(hostOf(s.session.target_url))}</b></span>`);
    if (phase === 'recording') {
      meta.push(`<span>Case <b>${esc(caseById(s.currentStep.test_case_id)?.name || s.currentStep.test_case_id)}</b></span>`);
      meta.push(`<span>Thời gian <b data-elapsed="${esc(s.currentStep.started_at)}">${duration(Date.now() - Date.parse(s.currentStep.started_at))}</b></span>`);
      meta.push(`<span>Event trong bước <b>${s.stepEventCount ?? 0}</b></span>`);
    } else if (s.session) meta.push(`<span>Bằng chứng <b>${s.eventCount}</b></span><span>Loại event <b>${s.eventSummary?.length ?? 0}</b></span>`);
    else meta.push('<span>Nhập URL website thật ở bước 1 rồi mở trình duyệt test.</span>');
    if (ui.marker && s.running) meta.push(`<span>Mốc <b>${esc(clock(new Date(ui.marker).toISOString()))}</b></span>`);
    const metaHtml = meta.join(''); if ($('session-meta').innerHTML !== metaHtml) $('session-meta').innerHTML = metaHtml;

    const primary = $('bar-primary'), secondary = $('bar-secondary');
    const action = {
      idle: [ui.hooks.startLabel || 'Mở trình duyệt test', 'start', 'primary'], finished: ['Mở phiên mới', 'start', 'primary'],
      running: explore ? ['⚑ Đặt mốc rồi thao tác', 'set-marker', 'primary'] : [`▶ Bắt đầu bước${caseById(ui.selectedCase) ? `: ${caseById(ui.selectedCase).name}` : ''}`, 'step-start', 'primary'],
      recording: ['■ Hoàn tất bước', 'step-complete', 'rec'], loading: ['…', null, 'primary'], closing: ['Đang tắt…', null, 'primary'],
    }[phase];
    primary.textContent = ui.busy ? 'Đang xử lý…' : action[0]; primary.dataset.action = action[1] || ''; primary.className = `btn ${action[2]}`;
    primary.disabled = !!ui.busy || !action[1] || (action[1] === 'step-start' && !ui.selectedCase);
    const second = { running: ['Kết thúc & xuất', 'finish'], recording: ['Dừng phiên', 'stop-session'] }[phase];
    secondary.classList.toggle('hidden', !second);
    if (second) { secondary.textContent = second[0]; secondary.dataset.action = second[1]; secondary.disabled = !!ui.busy && second[1] !== 'stop-session'; }
  }
  function tickTimers() { for (const el of $$('[data-elapsed]')) el.textContent = duration(Date.now() - Date.parse(el.dataset.elapsed)); }

  // ---- results ----------------------------------------------------------
  function issueHtml(issue) {
    const rows = [];
    if (issue.path) rows.push(`<span>Trường</span><code>${esc(issue.path)}</code>`);
    if (issue.expected !== undefined) rows.push(`<span>Mong đợi</span><code>${esc(short(issue.expected))}</code>`);
    if (issue.actual !== undefined) rows.push(`<span>Thực tế</span><code>${esc(short(issue.actual))}</code>`);
    return `<div class="issue"><b>${esc(ISSUE_TEXT[issue.code] || issue.code || 'Lệch')}</b> <small class="hint">${esc(issue.code || '')}</small><div class="diff">${rows.join('')}</div>
      ${issue.evidence_id ? `<button type="button" class="evlink" data-evidence="${esc(issue.evidence_id)}">${esc(issue.evidence_id)}</button>` : ''}</div>`;
  }
  function renderResults(s) {
    const host = $('results'); if (!host) return;
    const sig = JSON.stringify([s.results, s.cases.map(c => [c.id, c.name])]); if (sig === ui.sig.results) return; ui.sig.results = sig;
    const executed = s.results.filter(r => r.step_id).reverse();
    const pending = s.results.filter(r => !r.step_id);
    const steps = new Map((s.steps || []).map(step => [step.id, step]));
    const notRun = pending.length ? `<p class="hint">Chưa chạy:</p><div class="not-run">${pending.map(r => `<span class="pill">${esc(caseById(r.test_case_id)?.name || r.test_case_id)}</span>`).join('')}</div>` : '';
    if (!executed.length) {
      host.innerHTML = (s.cases.length
        ? '<div class="empty"><strong>Chưa có kết quả</strong>Chọn test case, bấm <b>Bắt đầu bước</b>, thao tác trên website rồi bấm <b>Hoàn tất bước</b>.</div>'
        : '<div class="empty"><strong>Chưa có rule để đối chiếu</strong>Mở tab <b>Event trực tiếp</b>, bấm <b>Tạo rule</b> trên event thật, hoặc nhập file đặc tả ở bước 2.</div>') + notRun;
      return;
    }
    host.innerHTML = executed.map(result => {
      const testCase = caseById(result.test_case_id); const step = steps.get(result.step_id);
      const rows = (result.results || []).map(rule => `<tr><td><b>${esc(rule.event_name)}</b><br><small class="hint">${esc(rule.source || '')}</small></td>
        <td><span class="pill layer">${esc(LAYER_TEXT[rule.layer] || rule.layer)}</span></td>
        <td><span class="pill ${esc(rule.verdict)}">${esc(VERDICT_TEXT[rule.verdict] || rule.verdict)}</span></td>
        <td>${(rule.issues || []).map(issueHtml).join('') || `<span class="hint">Khớp ${(rule.checks || []).length} kiểm tra</span>${(rule.evidence_ids || []).slice(0, 1).map(id => `<br><button type="button" class="evlink" data-evidence="${esc(id)}">${esc(id)}</button>`).join('')}`}</td></tr>`).join('');
      return `<article class="result ${esc(result.verdict)}"><div class="result-head"><div class="name"><strong>${esc(testCase?.name || result.test_case_id)}</strong>
        <small>${esc(result.test_case_id)} · ${esc(clock(step?.started_at))}${step?.status && step.status !== 'COMPLETED' ? ` · ${esc(step.status)}` : ''}</small></div>
        ${result.warning ? '<span class="pill warn">Bước chưa hoàn tất</span>' : ''}<span class="pill ${esc(result.verdict)}">${esc(VERDICT_TEXT[result.verdict] || result.verdict)}</span></div>
        <div class="table-scroll"><table class="checks"><thead><tr><th>Event</th><th>Tầng</th><th>Kết quả</th><th>Chi tiết / bằng chứng</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="hint">Case chưa có rule.</td></tr>'}</tbody></table></div>
        ${result.ai_note ? `<p class="ai-note"><b>Gợi ý AI${result.ai_routing?.model ? ` · ${esc(result.ai_routing.model)}` : ''}</b>${esc(result.ai_note)}</p>` : ''}</article>`;
    }).join('') + notRun;
  }

  // ---- event detail ---------------------------------------------------------
  // Where an event's business parameters live, per vendor and layer. The base is the path
  // prefix the specification uses for the same fields.
  function eventParams(e) {
    const p = e.payload && typeof e.payload === 'object' ? e.payload : {};
    if (e.source === 'INSIDER' && e.layer === 'JS_QUEUE') {
      if (p.type === 'custom_event') return { base: 'value.0.event_parameters', params: p.value?.[0]?.event_parameters ?? {} };
      return { base: 'value', params: p.value && typeof p.value === 'object' && !Array.isArray(p.value) ? p.value : p.value !== undefined ? { value: p.value } : {} };
    }
    if (e.source === 'INSIDER' && e.layer === 'TRACKING_REQUEST' && p.event_params) return { base: 'event_params', params: p.event_params };
    const { event: _event, ...rest } = p;
    return { base: '', params: rest };
  }
  const isObjectList = value => Array.isArray(value) && value.length > 0 && value.every(item => item && typeof item === 'object' && !Array.isArray(item));
  // Flattens parameters to dotted paths; lists of objects (items, products) are kept whole for a table.
  function paramRows(params, prefix = '', out = [], depth = 0) {
    for (const [key, value] of Object.entries(params)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isObjectList(value)) out.push({ path, list: value });
      else if (value && typeof value === 'object' && !Array.isArray(value) && depth < 4 && Object.keys(value).length) paramRows(value, path, out, depth + 1);
      else out.push({ path, value });
    }
    return out;
  }
  const formatValue = value => value === null ? '<span class="hint">null</span>' : value === undefined ? '<span class="hint">—</span>'
    : typeof value === 'string' ? (value === '' ? '<span class="hint">(rỗng)</span>' : esc(short(value, 160)))
    : Array.isArray(value) ? `<code>${esc(short(value, 160))}</code>` : `<code>${esc(String(value))}</code>`;
  function specMark(specPath, spec) {
    if (!spec) return '';
    const issue = spec.issues.find(i => i.path === specPath);
    if (issue) return `<span class="pill ${issue.verdict === 'FAIL' ? 'FAIL' : 'REVIEW'}">${esc(ISSUE_TEXT[issue.code] || issue.code)}</span>${issue.expected !== undefined && issue.code !== 'MISSING_FIELD' ? `<br><small class="hint">Mong đợi: ${esc(short(issue.expected, 60))}</small>` : ''}`;
    const op = spec.fields?.[specPath];
    if (op === 'ignore') return '<span class="hint">bỏ qua</span>';
    if (op) return '<span class="pill PASS">✓ Đúng</span>';
    return '<span class="hint">ngoài đặc tả</span>';
  }
  const FIRING_STATUS = { PASS: ['PASS', '✓'], WARN: ['REVIEW', '⚠'], FAIL: ['FAIL', '✗'] };
  const RULE_TEXT = { INSIDER_INIT: 'Insider: init sau dữ liệu trang', DELIVERED: 'Đã gửi lên server', CUSTOM_EVENT_SHAPE: 'Cấu trúc custom_event', DATE_PAIR: 'Cặp ngày ISO + _str',
    DESTINATION_PAIR: 'destination + destination_id', DUPLICATE: 'Không bắn trùng', ECOMMERCE_RESET: 'ecommerce: null trước event', ECOMMERCE_ITEMS: 'items đủ item_id/item_name', COUPON_ACTION: 'coupon action hợp lệ' };
  function firingHtml(checks) {
    if (!checks?.length) return '';
    const ordered = [...checks].sort((a, b) => ['FAIL', 'WARN', 'PASS'].indexOf(a.status) - ['FAIL', 'WARN', 'PASS'].indexOf(b.status));
    return `<div class="list-title"><b>Cách bắn</b></div><table class="params"><tbody>${ordered.map(check => { const [cls, icon] = FIRING_STATUS[check.status]; return `<tr><td><span class="pill ${cls}">${icon} ${esc(RULE_TEXT[check.rule] || check.rule)}</span></td><td>${esc(check.message)}${check.evidence_id ? ` <button type="button" class="evlink" data-evidence="${esc(check.evidence_id)}">xem</button>` : ''}</td></tr>`; }).join('')}</tbody></table>`;
  }
  function eventDetailHtml(e, spec, firing) {
    const { base, params } = spec?.comparison_format === 'default_custom_parameters' ? { base: '', params: spec.observed || {} } : eventParams(e);
    const rows = paramRows(params).filter(row => !/^gtm\./.test(row.path));
    const full = path => base ? `${base}.${path}` : path;
    const pageUrl = (() => { try { const u = new URL(e.page?.url); return u.host + u.pathname; } catch { return e.page?.url || ''; } })();
    const head = `<div class="ev-head"><div><span class="ev-title">${esc(e.event_name)}</span>
        <span class="pill layer">${esc(LAYER_TEXT[e.layer] || e.layer)}</span> <span class="pill">${esc(e.source)}</span>
        <div class="hint">${esc(clock(e.captured_at))} · ${esc(pageUrl)}${e.network?.status ? ` · HTTP ${esc(e.network.status)}` : ''}</div></div>
      ${spec ? `<div class="ev-spec"><span class="pill ${spec.verdict}">${spec.verdict === 'PASS' ? 'Khớp đặc tả' : spec.verdict === 'FAIL' ? 'Lệch đặc tả' : 'Cần xem'}</span><div class="hint">Đặc tả #${esc(spec.stt)} · ${esc(spec.flow)}</div></div>`
        : (ui.state?.cases.length ? '<div class="ev-spec"><span class="pill warn">Ngoài đặc tả</span></div>' : '')}</div>`;
    const scalar = rows.filter(row => !row.list);
    const lists = rows.filter(row => row.list);
    const scalarHtml = scalar.length ? `<table class="params"><thead><tr><th>Tham số</th><th>Giá trị</th>${spec ? '<th>So với đặc tả</th>' : ''}</tr></thead><tbody>${scalar.map(row => `<tr><td><code>${esc(row.path)}</code></td><td>${formatValue(row.value)}</td>${spec ? `<td>${specMark(full(row.path), spec)}</td>` : ''}</tr>`).join('')}</tbody></table>`
      : '<p class="hint">Event không có tham số.</p>';
    const listHtml = lists.map(({ path, list }) => {
      const columns = [...new Set(list.slice(0, 20).flatMap(item => Object.keys(item)))].slice(0, 16);
      const header = columns.map(column => { const mark = spec ? spec.issues.find(i => i.path === full(`${path}.0.${column}`)) : null; return `<th${mark ? ' class="bad"' : ''}>${esc(column)}${mark ? ' ⚠' : ''}</th>`; }).join('');
      // Judged on every key of the first item, not on the columns that fit in the table.
      const firstKeys = new Set(Object.keys(list[0]));
      const missing = spec ? Object.keys(spec.fields || {}).filter(p => p.startsWith(full(`${path}.0.`)) && !firstKeys.has(p.slice(full(`${path}.0.`).length)) && !p.slice(full(`${path}.0.`).length).includes('.')) : [];
      const title = `<div class="list-title"><code>${esc(path)}</code> · ${list.length} mục${missing.length ? ` · <span class="pill FAIL">Thiếu ${missing.map(m => esc(m.split('.').at(-1))).join(', ')}</span>` : ''}</div>`;
      // A few items (cart, checkout) read best one field per line; long lists stay a scrollable table.
      if (list.length <= 3) return title + list.map((item, index) => `<table class="params"><thead><tr><th>Mục ${index + 1}</th><th>Giá trị</th>${spec ? `<th>${index === 0 ? 'So với đặc tả' : ''}</th>` : ''}</tr></thead><tbody>${paramRows(item).map(row => `<tr><td><code>${esc(row.path)}</code></td><td>${row.list ? `<code>${esc(short(row.list, 160))}</code>` : formatValue(row.value)}</td>${spec ? `<td>${index === 0 ? specMark(full(`${path}.0.${row.path}`), spec) : ''}</td>` : ''}</tr>`).join('')}</tbody></table>`).join('');
      return `${title}
        <div class="table-scroll"><table class="params items"><thead><tr><th>#</th>${header}</tr></thead><tbody>${list.slice(0, 20).map((item, index) => `<tr><td>${index + 1}</td>${columns.map(column => `<td>${formatValue(item[column] && typeof item[column] === 'object' ? JSON.stringify(item[column]) : item[column])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${list.length > 20 ? `<p class="hint">+${list.length - 20} mục khác (xem JSON gốc)</p>` : ''}`;
    }).join('');
    // Fields the specification expects but the event does not carry at all.
    const absent = spec ? spec.issues.filter(i => i.code === 'MISSING_FIELD' && !rows.some(row => full(row.path) === i.path) && !/\.0\./.test(i.path)) : [];
    const absentHtml = absent.length ? `<div class="list-title"><span class="pill FAIL">Thiếu so với đặc tả</span> ${absent.map(i => `<code>${esc(base && i.path.startsWith(`${base}.`) ? i.path.slice(base.length + 1) : i.path)}</code>`).join(', ')}</div>` : '';
    const note = spec?.notes ? `<p class="hint">Ghi chú đặc tả: ${esc(spec.notes)}</p>` : '';
    const contract = spec ? `<p><b>Event Name trong đặc tả:</b> ${esc(spec.event_name)} · ${esc(spec.provenance?.sheet)}!${esc(spec.provenance?.row)}<br>${esc(spec.description)}</p><button type="button" class="btn small" data-spec-detail="${esc(spec.case_id)}">Xem chi tiết đặc tả</button>` : '';
    return `${head}${contract}${firingHtml(firing)}${absentHtml}${scalarHtml}${listHtml}${note}
      <div class="row" style="margin:10px 0 0">${e.network?.phase && e.network.phase !== 'request' ? '' : `<button type="button" class="btn small primary shrink" data-build="${esc(e.evidence_id)}">Tạo rule từ event này</button>`}</div>
      <details class="raw"><summary>JSON gốc (bằng chứng đầy đủ)</summary><pre>${esc(JSON.stringify(e, null, 2))}</pre></details>`;
  }
  async function loadDetail(id) {
    if (!id || ui.details.has(id) || ui.loadingDetails.has(id)) return;
    ui.loadingDetails.add(id);
    try {
      const response = await fetch(`/api/event?id=${encodeURIComponent(id)}`);
      if (response.ok) ui.details.set(id, await response.json());
    } finally { ui.loadingDetails.delete(id); }
    if (ui.details.size > 300) ui.details.delete(ui.details.keys().next().value);
    for (const host of $$(`[data-detail="${CSS.escape(id)}"]`)) host.innerHTML = detailContent(id);
  }
  function detailContent(id) {
    const loaded = ui.details.get(id);
    if (!loaded) { loadDetail(id); return '<p class="hint">Đang tải chi tiết…</p>'; }
    return eventDetailHtml(loaded.event, loaded.spec, loaded.firing);
  }

  // ---- live evidence ------------------------------------------------------
  function activityFilterQuery() {
    return new URLSearchParams({ channel: $('activity-channel')?.value || 'network', source: $('ev-source')?.value || '',
      flow: $('activity-flow')?.value || '', spec_only: $('activity-spec-only')?.checked ? '1' : '0' }).toString();
  }
  function setupFlowFilter(s) {
    if ($('activity-flow') && s.flows) {
      const select = $('activity-flow'), options = JSON.stringify(s.flows);
      if (select.dataset.flows !== options) {
        const current = select.value;
        select.innerHTML = '<option value="">Tất cả luồng (chẩn đoán)</option>' + Object.entries(s.flows).map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`).join('');
        select.value = current; select.dataset.flows = options;
      }
    }
    const key = `${s.session?.id || ''}:${s.cases.map(c => c.id).join('|')}`;
    if (ui.flowFilterKey === key) return;
    ui.flowFilterKey = key;
    const preferred = s.sessionFlow !== 'unknown' ? s.sessionFlow : s.specFlows?.length === 1 ? s.specFlows[0] : '';
    if (preferred && $('activity-flow')) $('activity-flow').value = preferred;
    if (preferred && s.specFlows?.length && !s.specFlows.includes(preferred)) $('activity-spec-only').checked = false;
  }
  async function refreshActivity(more = false) {
    if (ui.activityLoading || !ui.state) return;
    const session = ui.state.session?.id || null;
    if (ui.activitySession !== session) {
      ui.activity = []; ui.activityNext = null; ui.activityVersion = null; ui.activityExtended = false; ui.activitySession = session;
    }
    const filters = activityFilterQuery();
    if (ui.activityFilters !== filters) { ui.activity = []; ui.activityNext = null; ui.activityVersion = null; ui.activityExtended = false; ui.activityFilters = filters; }
    const version = `${ui.state.session?.id || ''}:${ui.state.eventCount}:${filters}`;
    if (!more && version === ui.activityVersion) return;
    ui.activityLoading = true;
    try {
      const response = await fetch('/api/activity?compact=1&' + filters + (more && ui.activityNext ? `&before=${encodeURIComponent(ui.activityNext)}` : ''), { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Chưa tải được danh sách event.');
      const page = await response.json();
      if (page.session_id !== (ui.state.session?.id || null)) return;
      if (filters !== activityFilterQuery()) return;
      if (more) ui.activityExtended = true;
      if (more) ui.activity = [...ui.activity, ...page.events];
      else if (ui.activityExtended) ui.activity = [...new Map([...page.events, ...ui.activity].map(e => [e.evidence_id, e])).values()];
      else ui.activity = page.events;
      ui.activityVersion = version;
      if (more || !ui.activityExtended) ui.activityNext = page.next;
      ui.activityTotal = page.total;
      ui.sig.events = null;
      render();
    } catch (error) { showError(error.message); }
    finally { ui.activityLoading = false; }
  }
  function renderActivity(f, emptyHtml) {
    const from = $('activity-from')?.value, to = $('activity-to')?.value;
    setText('activity-scope-note', `Luồng: ${$('activity-flow')?.selectedOptions[0]?.textContent || 'Tất cả'} · Nguồn: ${$('activity-channel')?.selectedOptions[0]?.textContent || 'Request'} · ${f.source || 'Mọi vendor'}. Queue, request và SDK không ghép chung ở chế độ mặc định.`);
    const items = ui.activity.filter(e => {
      const at = new Date(e.captured_at); const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
      return (f.system || (!e.diagnostic && !SYSTEM_EVENT.test(e.event_name))) && (!f.source || e.source === f.source)
        && (!f.marked || !ui.marker || at.getTime() >= ui.marker) && (!from || day >= from) && (!to || day <= to)
        && (!f.query || JSON.stringify(e).toLowerCase().includes(f.query));
    });
    $('activity-events').innerHTML = items.length ? `<div class="activity-caption">${items.length} event đang hiển thị · ${ui.activityTotal} event trong nguồn và luồng đã chọn. Các lần bắn lặp trong cùng nguồn được giữ nguyên.</div><div class="table-scroll"><table class="checks activity-table"><thead><tr><th>Thời gian</th><th>Event / Action</th><th>Luồng</th><th>Nguồn</th><th>Tham số</th><th></th></tr></thead><tbody>${items.map(e => `<tr><td>${esc(new Date(e.captured_at).toLocaleString('vi-VN', { hour12: false }))}${e.historical ? '<br><small class="hint">Trước khi thu thập</small>' : ''}</td><td><button type="button" class="ev-toggle" data-activity-id="${esc(e.evidence_id)}"><b>${esc(e.display_name)}</b></button><br><small class="hint">${esc(e.event_name)}${e.capture?.incomplete ? ' · Thu chưa đầy đủ' : ''}</small></td><td><span class="pill">${esc(e.flow_label)}</span>${e.flow_conflict ? '<br><small class="hint">URL / payload khác luồng</small>' : ''}</td><td><span class="pill">${esc(e.source)}</span><br><small class="hint">${esc(activitySource(e))}</small></td><td><small>${e.default_count ?? Object.keys(e.json?.default_parameters || {}).length} default · ${e.custom_count ?? Object.keys(e.json?.custom_parameters || {}).length} custom</small></td><td><button type="button" class="btn small primary" data-activity-id="${esc(e.evidence_id)}">Xem JSON</button></td></tr>`).join('')}</tbody></table></div>` : emptyHtml;
    $('activity-more').classList.toggle('hidden', !ui.activityNext);
  }
  function activitySource(a) {
    if (a.observation === 'network_request') return 'Request mạng';
    if (a.observation === 'sdk_before_send') return 'SDK trước khi gửi';
    if (a.observation === 'sdk_dispatch') return 'Lệnh gọi Insider SDK';
    return a.queue_name ? `${a.queue_name}.push` : (LAYER_TEXT[a.layer] || a.layer);
  }
  async function openActivity(id) {
    const response = await fetch(`/api/event?id=${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error('Không đọc được event này.');
    const detail = await response.json(); ui.activitySelected = detail;
    const a = detail.activity, e = detail.event;
    const rawPayload = e.original_payload || e.payload;
    const parameters = (group, name) => Object.entries(group).map(([key, value]) => `<tr><td><code>${esc(key)}</code></td><td><pre>${esc(JSON.stringify(value, null, 2))}</pre><small class="hint">${esc(a.parameter_origins?.[`${name}.${key}`] || '')}</small></td></tr>`).join('') || '<tr><td colspan="2" class="hint">Nguồn thực tế không có tham số trong nhóm này.</td></tr>';
    $('activity-content').innerHTML = `<h2>${esc(a.display_name)}</h2><div class="kv"><div><span>Thời điểm</span><b>${esc(new Date(a.captured_at).toLocaleString('vi-VN', { hour12: false }))}</b></div><div><span>Nguồn bằng chứng</span><b>${esc(a.source)} · ${esc(activitySource(a))}</b></div><div><span>Luồng được nhận diện</span><b>${esc(a.flow_label)}${a.flow_conflict ? ' · URL/payload không thống nhất' : ''}</b></div></div><p class="hint">Nhóm tham số đọc từ <code>${esc(a.parameter_mapping)}</code> của event thực tế. Không dùng dữ liệu Excel để điền thiếu. Request gửi đi không xác nhận Insider đã tiếp nhận. Dữ liệu nhạy cảm được che.</p>${a.capture?.incomplete ? '<div class="banner warn">Payload thu chưa đầy đủ; không dùng bản này để kết luận PASS/FAIL của website.</div>' : ''}
      <div class="toolbar activity-actions"><button type="button" class="btn primary" id="activity-copy">Sao chép JSON</button><button type="button" class="btn" id="activity-download">Tải JSON</button></div><div class="segmented"><button type="button" data-activity-view="json" aria-pressed="true">JSON tham số</button><button type="button" data-activity-view="params" aria-pressed="false">Default / Custom</button><button type="button" data-activity-view="raw" aria-pressed="false">Payload gốc</button></div>
      <section data-activity-panel="json"><pre class="activity-json" tabindex="0">${esc(JSON.stringify(a.json, null, 2))}</pre></section><section data-activity-panel="params" class="hidden"><h3>Default Parameters</h3><table class="params"><tbody>${parameters(a.json.default_parameters, 'default_parameters')}</tbody></table><h3>Custom Parameters</h3><table class="params"><tbody>${parameters(a.json.custom_parameters, 'custom_parameters')}</tbody></table></section><section data-activity-panel="raw" class="hidden"><p class="hint">Payload đã thu, không đổi tên trường hoặc chuyển nhóm. Bằng chứng ${esc(e.evidence_id)}.</p><pre class="activity-json" tabindex="0">${esc(JSON.stringify(rawPayload, null, 2))}</pre></section>`;
    $('activity-copy').onclick = run(async () => {
      const raw = document.querySelector('[data-activity-view="raw"]')?.getAttribute('aria-pressed') === 'true';
      const value = raw ? (a.capture?.incomplete ? { _capture: a.capture, payload: rawPayload } : rawPayload) : a.json;
      try { await navigator.clipboard.writeText(JSON.stringify(value, null, 2)); toast('Đã sao chép toàn bộ JSON.', 'ok'); }
      catch { throw new Error('Trình duyệt chưa cho phép sao chép. Dùng nút Tải JSON để lấy đầy đủ dữ liệu.'); }
    });
    $('activity-download').onclick = () => {
      const raw = document.querySelector('[data-activity-view="raw"]')?.getAttribute('aria-pressed') === 'true';
      const value = raw ? (a.capture?.incomplete ? { _capture: a.capture, payload: rawPayload } : rawPayload) : a.json;
      const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${e.evidence_id}${raw ? '-raw' : ''}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    $('activity-dialog').showModal();
  }
  // SDK setup and GTM lifecycle pushes; hidden unless asked for, they are not user actions.
  const SYSTEM_EVENT = /^(?:gtm\.|gtag\.|insider_|ecommerce_reset$|QUEUE_ITEM$)/;
  const isSystem = e => e.layer === 'JS_QUEUE' && SYSTEM_EVENT.test(e.event_name);
  function eventFilters() {
    return { layer: $('ev-layer')?.value || '', source: $('ev-source')?.value || '', query: ($('ev-search')?.value || '').trim().toLowerCase(),
      marked: !!$('ev-marked')?.checked, system: !!$('ev-system')?.checked, group: ui.groupFilter };
  }
  function renderSourceFilter(s) {
    const select = $('ev-source'); if (!select) return;
    const specSources = [...new Set(s.cases.map(c => c.source).filter(Boolean))];
    const sources = [...new Set(['INSIDER', ...specSources, ...(s.eventSummary || []).map(g => g.source)])].sort();
    const specKey = s.cases.map(c => c.id).join('|');
    const changedSpec = ui.sourceSpecKey !== specKey;
    const sig = sources.join('|') + specKey; if (sig === ui.sig.sources) return; ui.sig.sources = sig;
    const current = changedSpec && specSources.length === 1 ? specSources[0] : ui.sourceSpecKey === undefined ? 'INSIDER' : select.value;
    select.innerHTML = '<option value="">Mọi nguồn</option>' + sources.map(src => `<option value="${esc(src)}">${esc(src)}</option>`).join('');
    select.value = sources.includes(current) ? current : '';
    ui.sourceSpecKey = specKey;
    if (changedSpec && $('activity-spec-only')) $('activity-spec-only').checked = s.cases.length > 0;
  }
  function renderFilterBar(f) {
    const bar = $('ev-filterbar'); if (!bar) return;
    const parts = [];
    if (f.group) parts.push(`<b>${esc(f.group.name)}</b> · ${esc(LAYER_TEXT[f.group.layer] || f.group.layer)} · ${esc(f.group.source)}`);
    else {
      if (f.layer) parts.push(esc(LAYER_TEXT[f.layer] || f.layer));
      if (f.source) parts.push(esc(f.source));
      if (f.query) parts.push(`“${esc(f.query)}”`);
    }
    if (f.marked && ui.marker) parts.push(`sau mốc ${esc(clock(new Date(ui.marker).toISOString()))}`);
    const active = parts.length > 0;
    bar.classList.toggle('hidden', !active && ui.view === 'groups');
    bar.innerHTML = `${ui.view === 'stream' ? '<button type="button" class="btn small" data-action="events-back">← Về danh sách event</button>' : ''}
      <span>${active ? `Đang xem: ${parts.join(' · ')}` : 'Tất cả event'}</span>
      ${active ? '<button type="button" class="btn ghost small" data-action="events-clear">✕ Bỏ lọc</button>' : ''}`;
  }
  function renderEvents(s) {
    renderSourceFilter(s);
    setupFlowFilter(s);
    if (ui.view === 'activity') void refreshActivity();
    const f = eventFilters();
    if ($('ev-search')) $('ev-search').placeholder = ui.view === 'activity' ? 'Tìm tên event, nguồn hoặc evidence ID…' : 'Tìm event, giá trị, evidence ID…';
    const view = JSON.stringify([f, ui.view, ui.marker, ui.expandedGroup, $('activity-from')?.value, $('activity-to')?.value, ui.activity.length]);
    const sig = JSON.stringify([s.eventCount, s.events.at(-1)?.evidence_id, view, s.cases.length]); if (sig === ui.sig.events) return;
    // Keep an expanded event steady while new evidence arrives; offer to refresh instead.
    const reading = ui.view === 'stream' && $$('#events details[open]').length > 0 && ui.sig.eventsView === view;
    if (reading) { const note = $('ev-pending'); if (note) { note.classList.remove('hidden'); note.textContent = 'Có event mới · bấm để cập nhật danh sách'; } return; }
    $('ev-pending')?.classList.add('hidden');
    ui.sig.events = sig; ui.sig.eventsView = view;
    setText('events-count', String((s.eventSummary || []).filter(g => f.system || !(g.layer === 'JS_QUEUE' && SYSTEM_EVENT.test(g.event_name))).length));
    for (const b of $$('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === ui.view));
    renderFilterBar(f);
    $('event-groups')?.classList.toggle('hidden', ui.view !== 'groups');
    $('events')?.classList.toggle('hidden', ui.view !== 'stream');
    $('activity-events')?.classList.toggle('hidden', ui.view !== 'activity');
    $('activity-filters')?.classList.toggle('hidden', ui.view !== 'activity');
    $('activity-scope-note')?.classList.toggle('hidden', ui.view !== 'activity');
    $('ev-layer')?.classList.toggle('hidden', ui.view === 'activity');
    if ($('activity-spec-only')) $('activity-spec-only').disabled = !s.cases.length;
    if ($('queues-read')) { $('queues-read').classList.toggle('hidden', ui.view !== 'activity'); $('queues-read').disabled = !s.running || s.session?.capture_queues === false || !!ui.busy; }
    if (ui.view !== 'activity') $('activity-more')?.classList.add('hidden');
    const emptyHtml = !s.session
      ? '<div class="empty"><span class="empty-art"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18m-13 6 3-3 3 5 3-3"/></svg></span><strong>Sẵn sàng cho phiên kiểm tra đầu tiên?</strong><p>Nhập website cần kiểm tra, mở trình duyệt test và thực hiện thao tác. Event thực tế sẽ xuất hiện tại đây.</p><div class="empty-actions"><button type="button" class="btn primary" data-setup-stage="session">Thiết lập website →</button><button type="button" class="btn" data-action="use-demo">Thử với demo</button></div><div class="empty-steps"><span><b>1</b>Mở website</span><span><b>2</b>Thực hiện thao tác</span><span><b>3</b>Xem event &amp; đối chiếu</span></div></div>'
      : s.eventCount ? '<div class="empty"><strong>Không có event khớp bộ lọc</strong>Bấm “Bỏ lọc”, bỏ tick “Chỉ sau mốc” hoặc tick “Hiện event hệ thống”.</div>'
      : '<div class="empty"><strong>Chưa nhận được event</strong>Thao tác trên trình duyệt test. Không thấy request? Xem tab <b>Endpoint</b> để thêm endpoint tracking của website.</div>';
    if (ui.view === 'activity') {
      renderActivity(f, emptyHtml);
    } else if (ui.view === 'groups') {
      const markerSince = ui.marker && f.marked;
      // Counts after a marker come from the buffered recent events; totals come from the server summary.
      const recentCounts = new Map();
      if (markerSince) for (const e of s.events) if (afterMarker(e) && (!e.network?.phase || e.network.phase === 'request')) { const key = [e.layer, e.source, e.event_name].join('|'); recentCounts.set(key, (recentCounts.get(key) || 0) + 1); }
      const groups = (s.eventSummary || []).filter(g => (f.system || !(g.layer === 'JS_QUEUE' && SYSTEM_EVENT.test(g.event_name))) && (!f.layer || g.layer === f.layer) && (!f.source || g.source === f.source) && (!f.query || `${g.event_name} ${g.source} ${g.pages.join(' ')}`.toLowerCase().includes(f.query)) && (!markerSince || recentCounts.has(g.key)));
      $('event-groups').innerHTML = groups.length ? `<div class="table-scroll"><table class="checks groups"><thead><tr><th>Event</th><th>Tầng · nguồn</th><th>${markerSince ? 'Sau mốc / tổng' : 'Số lần'}</th><th>Lần cuối · trang</th><th></th></tr></thead><tbody>${groups.map(g => `<tr>
        <td><button type="button" class="ev-toggle" data-expand="${esc(g.key)}" aria-expanded="${ui.expandedGroup === g.key}">${ui.expandedGroup === g.key ? '▾' : '▸'} <b>${esc(g.event_name)}</b></button>${g.failed ? ` <span class="pill FAIL">${g.failed} lỗi</span>` : ''}</td>
        <td><span class="pill layer">${esc(LAYER_TEXT[g.layer] || g.layer)}</span> <span class="pill">${esc(g.source)}</span></td>
        <td><b>${markerSince ? `${recentCounts.get(g.key)} / ` : ''}${g.count}</b>${g.bound ? `<br><small class="hint">${g.bound} trong bước</small>` : ''}</td>
        <td><small>${esc(clock(g.last_at))}</small><br><small class="hint">${esc(short(g.pages.join(', '), 60))}</small></td>
        <td class="row-actions"><button type="button" class="btn small" data-group-view="${esc(g.key)}">Tất cả ${g.count} lần</button> <button type="button" class="btn small primary" data-build="${esc(g.last_evidence_id)}">Tạo rule</button></td></tr>
        ${ui.expandedGroup === g.key ? `<tr class="detail-row"><td colspan="5"><div class="ev-detail" data-detail="${esc(g.last_evidence_id)}">${detailContent(g.last_evidence_id)}</div></td></tr>` : ''}`).join('')}</tbody></table></div>` : emptyHtml;
    } else {
      const list = s.events.slice().reverse().filter(e => (f.system || f.group || !isSystem(e))
        && (!f.group || (e.layer === f.group.layer && e.source === f.group.source && e.event_name === f.group.name))
        && (f.group || ((!f.layer || e.layer === f.layer) && (!f.source || e.source === f.source)))
        && (!f.marked || afterMarker(e)) && (!f.query || JSON.stringify(e).toLowerCase().includes(f.query)));
      // Identical consecutive pushes (a site re-firing, or repeated clicks) collapse into one row.
      const rows = [];
      for (const e of list) {
        const key = JSON.stringify([e.layer, e.source, e.event_name, e.network?.phase, e.payload]);
        const last = rows.at(-1);
        if (last && last.key === key) { last.count++; last.oldest = e; } else rows.push({ key, event: e, count: 1, oldest: e });
      }
      const firstRender = ui.seenEvents.size === 0;
      $('events').innerHTML = rows.map(({ event: e, count, oldest }) => {
        const fresh = !firstRender && !ui.seenEvents.has(e.evidence_id);
        const phase = e.network?.phase ? `${e.network.method || ''} ${e.network.phase}${e.network.status ? ` ${e.network.status}` : ''}${e.network.error ? ` ${e.network.error}` : ''}` : e.queue_name || '';
        return `<details class="event${fresh ? ' flash' : ''}" data-ev="${esc(e.evidence_id)}" ${ui.openEvents.has(e.evidence_id) ? 'open' : ''}><summary>
          <time>${esc(clock(e.captured_at))}</time><span class="ev-name">${esc(e.event_name)}</span>${count > 1 ? `<span class="pill warn" title="Từ ${esc(clock(oldest.captured_at))}">×${count} giống hệt nhau</span>` : ''}<span class="pill layer">${esc(LAYER_TEXT[e.layer] || e.layer)}</span><span class="pill">${esc(e.source)}</span>
          <span class="ev-meta">${esc(phase)} · ${e.step_id ? esc(e.test_case_id) : 'chưa gắn bước'}</span></summary>
          ${count > 1 ? `<p class="hint" style="margin:0 0 8px">Bắn ${count} lần với payload giống hệt nhau từ ${esc(clock(oldest.captured_at))} đến ${esc(clock(e.captured_at))}: website phát lặp, hoặc thao tác được bấm nhiều lần.</p>` : ''}
          <div class="ev-detail" data-detail="${esc(e.evidence_id)}">${ui.openEvents.has(e.evidence_id) ? detailContent(e.evidence_id) : ''}</div></details>`;
      }).join('') || emptyHtml;
      for (const e of s.events) ui.seenEvents.add(e.evidence_id);
    }
  }
  function showGroup(key) {
    const [layer, source, ...name] = key.split('|');
    ui.groupFilter = { layer, source, name: name.join('|') }; ui.view = 'stream';
    ui.sig.events = null; if (ui.state?.eventsCompact) void refresh(); else render();
  }
  function clearEventFilters() {
    ui.groupFilter = null;
    for (const id of ['ev-layer', 'ev-source', 'ev-search']) if ($(id)) $(id).value = '';
    if ($('ev-marked')) $('ev-marked').checked = false;
    ui.sig.events = null; render();
  }
  async function jumpToEvidence(id) {
    selectTab('events'); ui.view = 'stream'; ui.groupFilter = null;
    for (const [elId, value] of [['ev-layer', ''], ['ev-source', '']]) if ($(elId)) $(elId).value = value;
    if ($('ev-marked')) $('ev-marked').checked = false;
    if ($('ev-search')) $('ev-search').value = id; ui.openEvents.add(id); ui.sig.events = null;
    if (ui.state?.eventsCompact) await refresh(); else render();
    const target = document.querySelector(`[data-ev="${CSS.escape(id)}"]`);
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else if (id.startsWith('STEP-')) toast('Đây là bằng chứng của bước (event vắng mặt). Xem steps.jsonl trong thư mục phiên.');
    else toast('Event không nằm trong 100 bằng chứng gần nhất; xem events.jsonl trong thư mục phiên.');
  }

  // ---- specification coverage ------------------------------------------------
  const valueAt = (value, path) => {
    const parts = path.split('.'); let current = value;
    for (let i = 0; i < parts.length; i++) {
      if (current === null || typeof current !== 'object') return undefined;
      const rest = parts.slice(i).join('.');
      if (Object.hasOwn(current, rest)) return current[rest];
      current = current[parts[i]];
    }
    return current;
  };
  async function openSpecDetail(id) {
    const c = caseById(id); if (!c) return;
    const row = ui.state.specCoverage?.rows.find(r => r.case_id === id);
    const evidence = row?.last_fail_evidence_id || row?.last_evidence_id;
    const loaded = evidence ? await (await fetch(`/api/event?id=${encodeURIComponent(evidence)}`)).json() : null;
    const event = loaded?.event;
    const rule = c.rules[0];
    const comparisons = Object.entries(rule?.fields || {}).map(([path, field]) => {
      const actual = event ? valueAt(loaded?.spec?.observed || event.payload, path) : undefined;
      const issue = loaded?.spec?.issues.find(i => i.path === path);
      const verdict = !event ? 'Chưa có event' : issue ? (ISSUE_TEXT[issue.code] || issue.code) : field.op === 'ignore' ? 'Bỏ qua' : 'Đúng theo rule';
      return `<tr><td><code>${esc(path)}</code></td><td>${formatValue(valueAt(c.sample, path))}</td><td>${esc(field.op)}${field.value !== undefined ? ` · ${esc(short(field.value, 100))}` : ''}</td><td>${actual === undefined ? '<span class="hint">Chưa có / thiếu trường</span>' : formatValue(actual)}</td><td>${esc(verdict)}</td></tr>`;
    }).join('');
    $('spec-detail-content').innerHTML = `<h2>${esc(rule?.event_name || c.name)}</h2><p><b>${esc(c.provenance?.sheet)}!${esc(c.provenance?.row)}</b> · ${esc(c.flow)} · ${esc(c.source)} · ${esc(LAYER_TEXT[rule?.layer] || rule?.layer)}</p><p style="white-space:pre-wrap">${esc(c.description)}</p>
      <p class="hint">Mẫu giữ nguyên theo file. Các giá trị ví dụ không tự trở thành giá trị bắt buộc: cột Quy tắc cho biết đang kiểm kiểu, có mặt hay giá trị chính xác. Event thực tế giữ nguyên tên và payload đã thu thập.</p>
      ${event ? `<p><b>Event thực tế:</b> ${esc(event.event_name)} · ${esc(event.evidence_id)}</p>` : '<p class="banner info">Chưa thu được event đúng nguồn/tầng/tên cho dòng này. Payload mẫu bên dưới không phải bằng chứng đã bắn.</p>'}
      <div class="table-scroll"><table class="params"><thead><tr><th>Trường</th><th>Ví dụ trong đặc tả</th><th>Quy tắc hiện tại</th><th>Thực tế</th><th>Đối chiếu</th></tr></thead><tbody>${comparisons || '<tr><td colspan="5">Chưa có chi tiết payload để kiểm.</td></tr>'}</tbody></table></div>
      <div class="contract-columns"><section><h3>Chi tiết event · đặc tả</h3><pre>${esc(c.sample_text || JSON.stringify(c.sample || {}, null, 2))}</pre></section><section><h3>Tham số · thực tế</h3><pre>${esc(event ? JSON.stringify(loaded?.spec?.observed || event.payload, null, 2) : 'Chưa có event')}</pre></section></div><h3>Yêu cầu và cách fire trong file</h3><pre>${esc([c.parameter_notes, c.sdk_notes].filter(Boolean).join('\n\n') || 'Sheet không có hướng dẫn riêng; xem mô tả và sample bên trên.')}</pre>`;
    $('spec-detail-dialog').showModal();
  }
  const SPEC_STATUS = { MATCH: ['PASS', 'Khớp'], MISMATCH: ['FAIL', 'Lệch'], REVIEW: ['REVIEW', 'Cần xem'], NOT_SEEN: ['', 'Chưa thấy'] };
  function renderSpec(s) {
    const host = $('spec-table'); if (!host) return;
    const cov = s.specCoverage;
    $('spec-format-note')?.classList.toggle('hidden', !s.cases.some(c => c.payload_format === 'default_custom_parameters'));
    const f = { flow: $('spec-flow')?.value || '', platform: $('spec-platform')?.value || '', status: $('spec-status')?.value || '', query: ($('spec-search')?.value || '').trim().toLowerCase() };
    const sig = JSON.stringify([cov?.totals, cov?.rows.map(r => [r.case_id, r.seen, r.status, r.issues.length]), cov?.unmatched.length, f]); if (sig === ui.sig.spec) return; ui.sig.spec = sig;
    setText('spec-count', cov ? `${cov.totals.seen}/${cov.totals.rows}` : '0');
    if (!cov) { $('spec-totals').innerHTML = ''; host.innerHTML = '<div class="empty"><strong>Chưa có đặc tả</strong>Nhập file Excel đặc tả ở bước 2 (vd Martech_WebOTA_….xlsx). App sẽ tự gắn từng event bắt được vào đúng dòng Nền tảng · Luồng · Event Name và kiểm trường theo DataLayer Sample.</div>'; return; }
    const t = cov.totals;
    $('spec-totals').innerHTML = [['Dòng đặc tả', t.rows], ['Đã bắn', t.seen], ['Khớp', t.match], ['Lệch', t.mismatch], ['Chưa thấy', t.not_seen], ['Ngoài đặc tả', t.unmatched]].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    const flows = [...new Set(cov.rows.map(r => r.flow).filter(Boolean))];
    const select = $('spec-flow'); const flowSig = flows.join('|');
    if (select.dataset.sig !== flowSig) { const current = select.value; select.innerHTML = '<option value="">Mọi luồng</option>' + flows.map(fl => `<option>${esc(fl)}</option>`).join(''); select.value = flows.includes(current) ? current : ''; select.dataset.sig = flowSig; }
    const text = r => `${r.event_name} ${r.notes} ${r.description} ${r.flow}`.toLowerCase();
    const rows = f.status === 'UNMATCHED' ? [] : cov.rows.filter(r => (!f.flow || r.flow === f.flow) && (!f.platform || r.source === f.platform) && (!f.query || text(r).includes(f.query))
      && (!f.status || (f.status === 'FIRED' ? r.seen > 0 : r.status === f.status)))
      // Fired rows first (mismatches on top), then the rest in specification order.
      .sort((a, b) => (b.seen > 0) - (a.seen > 0) || (b.status === 'MISMATCH') - (a.status === 'MISMATCH') || 0);
    const unmatched = (!f.status || f.status === 'UNMATCHED') && !f.flow ? cov.unmatched.filter(u => (!f.platform || u.source === f.platform) && (!f.query || u.event_name.toLowerCase().includes(f.query))) : [];
    const issueText = r => r.issues.slice(0, 5).map(i => `<div class="issue"><b>${esc(ISSUE_TEXT[i.code] || i.code)}</b> <code>${esc(i.path || '')}</code>${['VALUE_MISMATCH', 'WRONG_TYPE', 'DYNAMIC_VALUE_MISMATCH'].includes(i.code) ? `<div class="diff"><span>Mong đợi</span><code>${esc(short(i.expected, 60))}</code><span>Thực tế</span><code>${esc(short(i.actual, 60))}</code></div>` : ''}</div>`).join('') + (r.issues.length > 5 ? `<small class="hint">+${r.issues.length - 5} trường khác</small>` : '');
    host.innerHTML = (rows.length || unmatched.length) ? `<div class="table-scroll"><table class="checks"><thead><tr><th>STT</th><th>Nền tảng · Luồng</th><th>Event</th><th>Trạng thái</th><th>Số lần</th><th>Trường lệch</th><th>Ghi chú đặc tả</th></tr></thead><tbody>
      ${rows.map(r => { const [cls, label] = SPEC_STATUS[r.status]; const evidence = r.last_fail_evidence_id || r.last_evidence_id; return `<tr>
        <td>${esc(r.stt || r.row || '')}</td><td><span class="pill">${esc(r.source)}</span><br><small>${esc(r.flow)}</small></td>
        <td><b>${esc(r.event_name)}</b>${r.layer === 'TRACKING_REQUEST' ? ' <span class="pill layer">Request</span>' : ''}<br><small class="hint">${esc(r.sheet)}!${esc(r.row)} · ${esc(short(r.description, 70))}</small><br><button type="button" class="evlink" data-spec-detail="${esc(r.case_id)}">Xem chi tiết đặc tả</button></td>
        <td><span class="pill ${cls}">${label}</span></td><td>${r.seen ? `<b>${r.seen}</b>${r.fail ? `<br><small class="hint">${r.fail} lệch</small>` : ''}` : '—'}</td>
        <td>${issueText(r) || (r.seen ? '<span class="hint">Đủ trường theo sample</span>' : '')}${evidence ? `<button type="button" class="evlink" data-evidence="${esc(evidence)}">Xem event</button>` : ''}</td>
        <td><small>${esc(short(r.notes, 90))}</small></td></tr>`; }).join('')}
      ${unmatched.map(u => `<tr><td>—</td><td><span class="pill">${esc(u.source)}</span></td><td><b>${esc(u.event_name)}</b></td><td><span class="pill warn">Ngoài đặc tả</span></td><td><b>${u.count}</b></td><td><button type="button" class="evlink" data-evidence="${esc(u.last_evidence_id)}">Xem event</button></td><td><small class="hint">Event bắn ra nhưng file đặc tả không có</small></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty"><strong>Không có dòng khớp bộ lọc</strong></div>';
  }

  // ---- firing checks ----------------------------------------------------------
  function renderFiring(s) {
    const host = $('firing-table'); if (!host || !s.firing) return;
    const status = $('firing-status')?.value || '';
    const sig = JSON.stringify([s.firing.summary, s.firing.problemCount, status]); if (sig === ui.sig.firing) return; ui.sig.firing = sig;
    const fails = s.firing.summary.reduce((n, r) => n + r.fail, 0), warns = s.firing.summary.reduce((n, r) => n + r.warn, 0);
    setText('firing-count', String(fails + warns));
    $('firing-summary').innerHTML = `<table class="params"><thead><tr><th>Quy tắc</th><th>Đạt</th><th>Cảnh báo</th><th>Lỗi</th></tr></thead><tbody>${s.firing.summary.map(r => `<tr><td>${esc(r.label)}</td><td>${r.pass ? `<span class="pill PASS">${r.pass}</span>` : '—'}</td><td>${r.warn ? `<span class="pill REVIEW">${r.warn}</span>` : '—'}</td><td>${r.fail ? `<span class="pill FAIL">${r.fail}</span>` : '—'}</td></tr>`).join('')}</tbody></table>`;
    const problems = s.firing.problems.filter(p => !status || p.status === status);
    host.innerHTML = problems.length ? `<div class="table-scroll"><table class="checks"><thead><tr><th>Giờ</th><th>Event</th><th>Quy tắc</th><th>Chi tiết</th></tr></thead><tbody>${problems.map(p => { const [cls, icon] = FIRING_STATUS[p.status]; return `<tr><td><small>${esc(clock(p.at))}</small></td><td><b>${esc(p.event_name)}</b><br><small class="hint">${esc(p.source)} · ${esc(LAYER_TEXT[p.layer] || p.layer)}</small></td><td><span class="pill ${cls}">${icon} ${esc(RULE_TEXT[p.rule] || p.rule)}</span></td><td>${esc(p.message)}<br><button type="button" class="evlink" data-evidence="${esc(p.id)}">Xem event</button></td></tr>`; }).join('')}</tbody></table></div>${s.firing.problemCount > s.firing.problems.length ? `<p class="hint">Hiện 200 vấn đề gần nhất / ${s.firing.problemCount}. Đầy đủ trong sheet Firing Checks của báo cáo.</p>` : ''}`
      : `<div class="empty"><strong>${s.eventCount ? 'Không có vấn đề về cách bắn' : 'Chưa có event'}</strong>${s.eventCount ? 'Mọi event đã thu đều đạt các quy tắc.' : 'Thao tác trên website để thu event.'}</div>`;
  }

  // ---- endpoints ----------------------------------------------------------
  function renderEndpoints(s) {
    const host = $('endpoints'); if (!host) return;
    const sig = JSON.stringify([s.patterns, s.discovered, s.running]); if (sig === ui.sig.endpoints) return; ui.sig.endpoints = sig;
    setText('endpoints-count', String(s.discovered?.length || 0));
    const discovered = s.discovered || [];
    host.innerHTML = `<h3 class="section-title">Endpoint nghi là tracking (chưa theo dõi)</h3>
      ${discovered.length ? `<div class="table-scroll"><table class="checks"><thead><tr><th>Host + path</th><th>Loại</th><th>Số lần</th><th></th></tr></thead><tbody>${discovered.map(d => `<tr><td><code>${esc(d.endpoint)}</code></td><td>${esc(d.method)} ${esc(d.resource_type || '')}</td><td>${d.count}</td><td><button type="button" class="btn small primary" data-add-endpoint="${esc(d.endpoint)}">Theo dõi</button></td></tr>`).join('')}</tbody></table></div>`
        : `<p class="hint">${ui.hooks.discoveryNote || (s.running ? 'Chưa thấy request nào giống tracking ngoài allowlist.' : 'Mở phiên để phát hiện endpoint tracking của website.')}</p>`}
      <h3 class="section-title">Đang theo dõi (${(s.patterns || []).length})</h3>
      <ul class="log">${(s.patterns || []).map(p => `<li><code>${esc(p)}</code></li>`).join('')}</ul>
      <p class="hint">Sửa danh sách ở bước 1 (vendor + endpoint bổ sung).${ui.mode === 'proxy' ? ' Proxy áp dụng khi mở phiên mới.' : ' Khi phiên đang chạy, bấm “Áp dụng” để theo dõi ngay từ request tiếp theo.'}</p>`;
  }
  async function addEndpoint(endpoint) {
    const pattern = `^${escapeRegex(endpoint)}$`;
    const area = $('patterns'); const lines = area.value.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.includes(pattern)) area.value = [...lines, pattern].join('\n');
    saveSite();
    if (ui.state?.running && ui.mode !== 'proxy') { await api('endpoints', { patterns: endpointPatterns() }, 'endpoints'); toast('Đã theo dõi endpoint; request mới sẽ được ghi.', 'ok'); }
    else toast('Đã thêm vào endpoint bổ sung; áp dụng khi mở phiên.', 'ok');
  }

  // ---- rule builder -------------------------------------------------------
  function flatten(value, prefix = '', depth = 0, out = []) {
    if (value && typeof value === 'object' && !Array.isArray(value) && depth < 4 && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, depth + 1, out);
    } else if (prefix) out.push([prefix, value]);
    return out;
  }
  function defaultField(path, value, event) {
    const leaf = path.split('.').at(-1);
    const protocol = event.layer === 'TRACKING_REQUEST' && event.source === 'GA4' && (GA4_PROTOCOL.has(path) || path.startsWith('_') || path.startsWith('up.'));
    const volatile = /^gtm\./.test(path) || /^(?:timestamp|ts|time|_et|event_id|eventId|uniqueEventId|session_id|client_id)$/i.test(leaf) || path === 'decode_status' || path === 'raw_hash';
    let op = 'exists', expected = '';
    // Evidence is redacted before storage, so a masked value can only be checked for presence.
    if (typeof value === 'string' && value.includes('[REDACTED')) return { path, value, include: !protocol && !volatile, op, expected, note: 'đã che dữ liệu nhạy cảm' };
    if (path === 'event' || path === 'event_name') { op = 'eq'; expected = value; }
    else if (typeof value === 'boolean') { op = 'eq'; expected = value; }
    else if (typeof value === 'number') { op = 'type'; expected = 'number'; }
    else if (Array.isArray(value)) { op = 'type'; expected = 'array'; }
    else if (typeof value === 'string') {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) { op = 'regex'; expected = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; }
      else if (value.length && value.length <= 60) { op = 'eq'; expected = value; }
    }
    return { path, value, include: !protocol && !volatile && value !== undefined, op, expected, note: protocol ? 'tham số giao thức GA4' : volatile ? 'giá trị thay đổi mỗi lần' : '' };
  }
  function slug(text) { return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toUpperCase().slice(0, 40) || 'EVENT'; }
  async function openBuilder(evidenceId) {
    const event = await fetchEvent(evidenceId);
    if (!event) return toast('Không đọc được event này.', 'error');
    if (event.payload?.decode_status === 'UNPARSED') toast('Payload không đọc được (UNPARSED): rule chỉ kiểm được số lượng event.');
    const fields = flatten(event.payload || {}).map(([path, value]) => defaultField(path, value, event));
    let id = `TC-${slug(event.event_name)}-${event.layer === 'JS_QUEUE' ? 'QUEUE' : 'REQ'}`;
    for (let n = 2; caseById(id); n++) id = `${id.replace(/-\d+$/, '')}-${n}`;
    const pairedRequest = event.layer === 'JS_QUEUE' && ui.mode !== 'proxy' && (ui.state?.eventSummary || []).some(g => g.layer === 'TRACKING_REQUEST' && g.event_name === event.event_name);
    ui.builder = { event, fields };
    const cases = ui.state?.cases || [];
    $('builder-body').innerHTML = `
      <div class="kv"><div><span>Event</span><b>${esc(event.event_name)}</b></div><div><span>Tầng · nguồn</span><b>${esc(LAYER_TEXT[event.layer] || event.layer)} · ${esc(event.source)}</b></div><div><span>Trang</span><b>${esc(short(hostOf(event.page?.url) + (() => { try { return new URL(event.page.url).pathname; } catch { return ''; } })(), 60))}</b></div></div>
      <div class="segmented" style="margin-top:12px"><button type="button" data-target-mode="new" aria-pressed="true">Case mới</button><button type="button" data-target-mode="append" aria-pressed="false" ${cases.length ? '' : 'disabled'}>Thêm vào case có sẵn</button></div>
      <div id="b-new" class="row"><div><label for="b-id">Mã case</label><input id="b-id" value="${esc(id)}"></div><div><label for="b-name">Tên case</label><input id="b-name" value="${esc(`${event.event_name} · ${LAYER_TEXT[event.layer] || event.layer}`)}"></div></div>
      <div id="b-append" class="hidden"><label for="b-case">Case</label><select id="b-case">${cases.map(c => `<option value="${esc(c.id)}" ${c.id === ui.selectedCase ? 'selected' : ''}>${esc(c.name)} (${esc(c.id)})</option>`).join('')}</select></div>
      <div class="row"><div><label for="b-min">Số lần tối thiểu</label><input id="b-min" type="number" min="0" value="1"></div><div><label for="b-max">Tối đa</label><input id="b-max" type="number" min="0" value="1"></div><div><label for="b-within">Trong vòng (ms, tuỳ chọn)</label><input id="b-within" type="number" min="0" placeholder="vd 10000"></div></div>
      <span class="label">Trường cần kiểm <span class="hint">(giá trị lấy từ event thật; đổi thành “lấy từ context” nếu giá trị thay đổi theo thao tác)</span></span>
      ${fields.length ? `<div class="table-scroll builder-table"><table class="checks"><thead><tr><th></th><th>Trường</th><th>Thực tế</th><th>Kiểm tra</th><th>Giá trị mong đợi</th></tr></thead><tbody>${fields.map((f, i) => `<tr data-field="${i}">
        <td><input type="checkbox" data-f="include" ${f.include ? 'checked' : ''} aria-label="Kiểm ${esc(f.path)}"></td>
        <td><code>${esc(f.path)}</code>${f.note ? `<br><small class="hint">${esc(f.note)}</small>` : ''}</td>
        <td><code>${esc(short(f.value, 50))}</code></td>
        <td><select data-f="op">${OPS.map(([op, label]) => `<option value="${op}" ${op === f.op ? 'selected' : ''}>${label}</option>`).join('')}</select></td>
        <td><input data-f="expected" value="${esc(typeof f.expected === 'string' ? f.expected : JSON.stringify(f.expected))}"></td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">Event không có payload để kiểm; rule kiểm số lượng event.</p>'}
      ${pairedRequest ? '<label class="check" style="margin-top:10px"><input id="b-request" type="checkbox" checked> Thêm rule tầng Request cùng tên (kiểm request tracking được gửi)</label>' : ''}
      <label class="check" style="margin-top:10px"><input id="b-approve" type="checkbox" checked> Rule đã được QC xác nhận (bỏ tick nếu cần BA duyệt; kết quả sẽ là REVIEW)</label>
      <div id="b-error" class="field-error"></div>`;
    syncBuilderInputs();
    const dialog = $('builder'); if (!dialog.open) dialog.showModal();
  }
  function syncBuilderInputs() {
    for (const row of $$('#builder [data-field]')) {
      const op = row.querySelector('[data-f="op"]').value; const input = row.querySelector('[data-f="expected"]');
      const needsValue = !['exists', 'not_exists', 'ignore'].includes(op);
      input.disabled = !needsValue;
      if (op === 'ref' && !input.value.startsWith('context.')) input.value = `context.${ui.builder.fields[row.dataset.field].path.split('.').at(-1)}`;
      if (op === 'type' && !['string', 'number', 'boolean', 'array', 'object', 'null'].includes(input.value)) input.value = Array.isArray(ui.builder.fields[row.dataset.field].value) ? 'array' : typeof ui.builder.fields[row.dataset.field].value;
      input.placeholder = { ref: 'context.ten_truong', type: 'string | number | boolean | array', regex: '^...$', one_of: '["a","b"]' }[op] || '';
    }
  }
  function parseExpected(op, raw, actual) {
    if (op === 'ref' || op === 'regex' || op === 'type') return raw;
    if (op === 'one_of') { const list = JSON.parse(raw); if (!Array.isArray(list)) throw new Error('“một trong” cần mảng JSON, ví dụ ["a","b"].'); return list; }
    if (typeof actual === 'string') return raw;
    try { return JSON.parse(raw); } catch { return raw; }
  }
  function builderCase() {
    const { event, fields } = ui.builder; const approved = $('b-approve').checked;
    const min = Number($('b-min').value), max = Number($('b-max').value);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) throw new Error('Số lần cần là số nguyên, tối thiểu ≤ tối đa.');
    const ruleFields = {};
    for (const row of $$('#builder [data-field]')) {
      if (!row.querySelector('[data-f="include"]').checked) continue;
      const field = fields[row.dataset.field]; const op = row.querySelector('[data-f="op"]').value;
      const raw = row.querySelector('[data-f="expected"]').value;
      if (op === 'ref' && !/^context\.[\w.$-]+$/.test(raw)) throw new Error(`${field.path}: giá trị context cần dạng context.ten_truong.`);
      if (op === 'regex') { try { new RegExp(raw); } catch { throw new Error(`${field.path}: regex không hợp lệ.`); } }
      ruleFields[field.path] = ['exists', 'not_exists', 'ignore'].includes(op) ? { op } : { op, value: parseExpected(op, raw, field.value) };
    }
    const within = $('b-within').value.trim();
    const rule = { event_name: event.event_name, layer: event.layer, source: event.source, count: { min, max }, ...(within ? { within_ms: Number(within) } : {}), fields: ruleFields, needs_review: !approved };
    const rules = [rule];
    if ($('b-request')?.checked) rules.push({ event_name: event.event_name, layer: 'TRACKING_REQUEST', source: event.source, count: { min, max }, fields: {}, needs_review: !approved });
    const appending = document.querySelector('[data-target-mode="append"]')?.getAttribute('aria-pressed') === 'true';
    if (appending) {
      const base = structuredClone(caseById($('b-case').value));
      base.rules = [...(base.rules || []), ...rules]; base.needs_review = caseNeedsReview(base) || !approved;
      return base;
    }
    const id = $('b-id').value.trim(), name = $('b-name').value.trim();
    if (!id || !name) throw new Error('Nhập mã và tên case.');
    if (caseById(id)) throw new Error(`Đã có case ${id}; đổi mã hoặc chọn “Thêm vào case có sẵn”.`);
    return { id, name, source: event.source, flow: hostOf(event.page?.url) || undefined, description: `Tạo từ event thật ${event.evidence_id}.`, needs_review: !approved, rules };
  }
  async function saveBuilder() {
    let testCase;
    try { testCase = builderCase(); } catch (error) { $('b-error').textContent = error.message; return; }
    await api('save-case', { case: testCase }, 'save-case');
    $('builder').close(); ui.selectedCase = null; selectCase(testCase.id, { force: true }); setStage('step', true);
    toast(ui.state?.running ? 'Đã lưu case. Bấm Bắt đầu bước rồi thao tác lại để kiểm.' : 'Đã lưu case vào imports/reviewed-cases.json.', 'ok');
  }

  // ---- log, reports, metrics ----------------------------------------------
  function renderLog(s) {
    const host = $('log'); if (!host) return;
    const sig = JSON.stringify(s.statuses); if (sig === ui.sig.log) return; ui.sig.log = sig;
    host.innerHTML = s.statuses.slice().reverse().map(x => `<li><time>${esc(clock(x.at))}</time><span>${esc(x.message)}</span></li>`).join('') || '<li><span class="hint">Ứng dụng sẵn sàng.</span></li>';
  }
  function renderReports(s) {
    const host = $('downloads'); if (!host) return;
    const sig = JSON.stringify([s.exported, s.runDir]); if (sig === ui.sig.reports) return; ui.sig.reports = sig;
    host.innerHTML = s.exported ? Object.entries(s.exported).map(([key, url]) => { const [title, note] = FILE_TEXT[key] || [key.toUpperCase(), '']; return `<a class="download" href="${esc(url)}"><strong>⬇ ${esc(title)}</strong><small>${esc(note)}</small></a>`; }).join('') : '';
    setText('run-dir', s.runDir ? `Thư mục phiên: ${s.runDir}` : '');
  }
  function renderMetrics(s) {
    setText('event-count', String(s.eventCount));
    setText('kind-count', String(s.eventSummary?.length ?? 0));
    const count = verdict => s.results.filter(r => r.verdict === verdict).length;
    setText('pass-count', String(count('PASS'))); setText('fail-count', String(count('FAIL'))); setText('review-count', String(count('REVIEW'))); setText('notrun-count', String(count('NOT_EXECUTED')));
    setText('results-count', String(s.results.filter(r => r.step_id).length));
  }
  function renderControls(s, phase) {
    const busy = !!ui.busy; const set = (id, disabled) => { if ($(id)) $(id).disabled = disabled; };
    set('start', s.running || busy || s.closing); set('import', !!s.currentStep || (s.running && s.steps?.length > 0) || busy); set('demo-spec', s.running || busy);
    set('save-case', !!s.currentStep || busy); set('delete-case', !!s.currentStep || busy || !ui.selectedCase);
    set('step-start', !s.running || !!s.currentStep || busy || !ui.selectedCase); set('step-complete', !s.currentStep || busy);
    set('finish', !s.running || !!s.currentStep || busy); set('export', !s.session || busy); set('stop-session', !s.running || s.closing);
    $('apply-endpoints')?.classList.toggle('hidden', !s.running || ui.mode === 'proxy');
    $('recorder')?.classList.toggle('hidden', phase !== 'recording');
    $('step-idle')?.classList.toggle('hidden', phase === 'recording');
    if ($('context')) $('context').readOnly = phase === 'recording';
    for (const el of $$('[data-lock-running]')) el.disabled = s.running || busy;
    if (s.running && $('request-only')) $('request-only').checked = s.session?.capture_queues === false;
    if (ui.mode === 'proxy') for (const el of $$('[data-lock-proxy]')) el.disabled = s.running || busy;
    if (phase === 'recording') setText('rec-count', String(s.stepEventCount ?? 0));
    $('review-banner')?.classList.toggle('hidden', !caseNeedsReview(caseById(ui.selectedCase)));
    $('ev-marked')?.closest('label')?.classList.toggle('hidden', !ui.marker);
    setText('marker-label', ui.marker ? `Mốc ${clock(new Date(ui.marker).toISOString())}` : '');
  }

  function render() {
    const s = ui.state; if (!s || ui.stopped) return;
    const phase = phaseOf(s);
    const indicator = $('board-capture-status');
    if (indicator) { indicator.textContent = s.running ? (s.session?.capture_queues === false ? 'Chỉ bắt request' : 'Đang thu thập') : s.session ? 'Đã kết thúc phiên' : 'Chưa mở phiên'; indicator.classList.toggle('active', !!s.running); }
    const casesKey = JSON.stringify([s.specSource, s.cases.length, s.cases.at(-1)?.id]);
    if (casesKey !== ui.casesKey) { ui.casesKey = casesKey; ui.details.clear(); ui.sig.events = null; }
    renderVendors(s); renderCases(s); renderFlow(s, phase); renderBar(s, phase); renderMetrics(s); renderControls(s, phase);
    if (Date.now() < ui.holdUntil) { clearTimeout(ui.holdTimer); ui.holdTimer = setTimeout(render, ui.holdUntil - Date.now() + 50); }
    else { renderResults(s); renderEvents(s); renderSpec(s); renderFiring(s); renderEndpoints(s); }
    renderLog(s); renderReports(s);
    ui.hooks.render?.(s, phase, ui);
  }

  // ---- tabs ---------------------------------------------------------------
  function selectTab(name) {
    ui.tab = name;
    for (const tab of $$('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    for (const panel of $$('.tabpanel')) panel.classList.toggle('hidden', panel.dataset.panel !== name);
    const names = { events: 'Event trực tiếp', spec: 'Đối chiếu đặc tả', results: 'Kết quả kiểm tra', firing: 'Kiểm tra cách bắn', endpoints: 'Endpoint tracking', log: 'Nhật ký phiên' };
    setText('board-title', names[name] || 'Event trực tiếp');
    for (const link of $$('[data-workspace-tab]')) {
      if (link.dataset.workspaceTab === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  function toggleSetup(collapsed = !document.body.classList.contains('setup-collapsed')) {
    document.body.classList.toggle('setup-collapsed', collapsed);
    $('setup-toggle')?.setAttribute('aria-expanded', String(!collapsed));
    const label = $('setup-toggle')?.querySelector('span'); if (label) label.textContent = collapsed ? 'Thiết lập phiên' : 'Ẩn thiết lập';
  }
  function revealSetup(stage) {
    toggleSetup(false);
    for (const item of $$('[data-stage]')) setStage(item.dataset.stage, item.dataset.stage === stage);
    document.querySelector(`[data-stage="${stage}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (stage === 'session') $('url')?.focus({ preventScroll: true });
  }

  // ---- actions ------------------------------------------------------------
  function startPayload() {
    let url = $('url')?.value.trim(); if (!url) { $('url')?.focus(); throw new Error('Nhập URL website cần test, ví dụ www.website.vn'); }
    // People type "site.com/vi"; assume https when no scheme is given.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url.replace(/^\/+/, '')}`;
    let parsed; try { parsed = new URL(url); } catch { throw new Error('URL chưa hợp lệ. Ví dụ: www.website.vn hoặc https://www.website.vn/'); }
    $('url').value = parsed.toString();
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('URL cần dùng http hoặc https.');
    return { url: parsed.toString(), browser: $('browser')?.value || 'chrome', debugPort: Number($('debug-port')?.value) || undefined, captureQueues: !$('request-only')?.checked, endpointPatterns: endpointPatterns(), ...(ui.hooks.startPayload?.() || {}) };
  }
  const actions = {
    'queues-read': async () => {
      const result = await api('queues/read');
      $('queues-content').innerHTML = '<p class="hint">Đọc trực tiếp queue hiện đang có trên trang. Không bắn lại event, không tính lần đọc là event mới. Đây là trạng thái lúc đọc; dữ liệu có thể khác lúc push nếu SDK đã sửa/xóa phần tử. Dữ liệu nhạy cảm được che.</p>' + (result.snapshots.map(s => `<h3>${esc(s.title || s.url)}</h3><p class="hint">${esc(s.url)} · ${esc(s.read_at)}</p>${Object.entries(s.queues).map(([name, q]) => `<details open><summary><b>${esc(name)}</b> · ${esc(q.status)}${q.length !== undefined ? ` · ${q.length} phần tử` : ''}${q.capture?.incomplete ? ' · Thu chưa đầy đủ' : ''}</summary><pre>${esc(JSON.stringify(q.item ?? q.items, null, 2))}</pre></details>`).join('')}`).join('') || '<p>Chưa đọc được queue trong frame hiện tại. Đợi website tải xong rồi đọc lại.</p>');
      $('queues-dialog').showModal();
    },
    start: async () => {
      const payload = startPayload(); saveSite();
      await api('start', payload, 'start'); ui.marker = null; selectTab('events');
      if (ui.state?.navigationError) return showError(`${ui.state.navigationError} Phiên vẫn mở: sửa URL ngay trong cửa sổ test, hoặc dừng phiên và nhập lại.`);
      toast(ui.state?.cases.length ? 'Đã mở trình duyệt test. Đăng nhập nếu cần, rồi chọn case và bấm Bắt đầu bước.' : 'Đã mở trình duyệt test. Đăng nhập nếu cần và thao tác; event hiện ở tab Event trực tiếp.', 'ok');
    },
    'step-start': async () => {
      const parsed = validateContext(); if (!parsed.ok) throw new Error('Context JSON chưa hợp lệ.');
      if (!ui.selectedCase) throw new Error('Chọn test case trước.');
      ui.contexts.set(ui.selectedCase, $('context').value);
      await api('step/start', { testCaseId: ui.selectedCase, context: parsed.value }, 'step-start');
      ui.marker = Date.parse(ui.state.currentStep.started_at);
      toast('Đang ghi bước. Sang trình duyệt test để thao tác.', 'ok');
    },
    'step-complete': async () => {
      const result = await api('step/complete', {}, 'step-complete');
      const last = (result.results || []).filter(r => r.step_id).at(-1);
      if (last) toast(`Kết quả: ${VERDICT_TEXT[last.verdict] || last.verdict}`, last.verdict === 'PASS' ? 'ok' : last.verdict === 'FAIL' ? 'error' : '');
      selectTab('results');
    },
    'set-marker': () => {
      ui.marker = Date.now(); if ($('ev-marked')) $('ev-marked').checked = true;
      selectTab('events'); ui.sig.events = null; render();
      toast('Đã đặt mốc. Thao tác trên website; chỉ event mới được hiển thị.', 'ok');
    },
    'clear-marker': () => { ui.marker = null; if ($('ev-marked')) $('ev-marked').checked = false; ui.sig.events = null; render(); },
    'apply-endpoints': async () => { saveSite(); await api('endpoints', { patterns: endpointPatterns() }, 'endpoints'); toast('Đã cập nhật allowlist cho request mới.', 'ok'); },
    'use-demo': async () => {
      $('url').value = `${location.origin}/demo`;
      if (!ui.state?.running) await api('demo-spec', {}, 'demo-spec');
      resetSelection(); setStage('session', true); toast('Đã chọn trang demo nội bộ và 3 case mẫu.', 'ok');
    },
    finish: async () => { await api('finish', {}, 'finish'); toast('Đã kết thúc phiên và xuất báo cáo.', 'ok'); },
    export: async () => { await api('export', {}, 'export'); toast('Đã xuất báo cáo hiện tại.', 'ok'); },
    'stop-session': async () => {
      if (ui.state?.currentStep && !confirm('Bước đang ghi sẽ được giữ REVIEW. Dừng phiên?')) return;
      await api('stop-session', {}, 'stop-session'); toast('Đã dừng phiên và lưu bằng chứng.');
    },
    import: async () => {
      const file = $('spec-path').value.trim().replace(/^"(.*)"$/, '$1'); if (!file) throw new Error('Nhập đường dẫn file XLSX hoặc JSON.');
      $('spec-path').value = file; const result = await api('import', { path: file, sheet: $('sheet')?.value.trim() }, 'import');
      if ($('spec-file-status')) $('spec-file-status').textContent = `Đã nhập ${result.cases.length} dòng. ` + (result.cases.some(c => c.payload_format === 'default_custom_parameters') ? 'Mẫu AppOTA: xem lưu ý cấu trúc và bảng chi tiết.' : 'Mở tab Đối chiếu đặc tả để xem chi tiết từng event.');
      resetSelection(); selectTab('spec'); toast(`Đã nhập ${ui.state?.cases.length ?? ''} dòng đặc tả. Event bắt được sẽ tự đối chiếu ở tab Đối chiếu đặc tả.`, 'ok');
    },
    'demo-spec': async () => { await api('demo-spec', {}, 'demo-spec'); resetSelection(); toast('Đã nạp 3 case demo.', 'ok'); },
    'save-case': async () => {
      const parsed = parseJson('case-json', 'case-json-error'); if (!parsed.ok) throw new Error('Rule JSON chưa hợp lệ.');
      const testCase = parsed.value; const approved = !!$('approve')?.checked;
      testCase.needs_review = !approved; for (const rule of testCase.rules || []) rule.needs_review = !approved;
      await api('save-case', { case: testCase }, 'save-case'); ui.selectedCase = testCase.id; loadRuleEditor(caseById(testCase.id));
      toast(approved ? 'Đã lưu rule đã duyệt.' : 'Đã lưu rule (vẫn cần duyệt).', 'ok');
    },
    'delete-case': async () => {
      if (!ui.selectedCase || !confirm(`Xoá case ${ui.selectedCase}?`)) return;
      await api('delete-case', { id: ui.selectedCase }, 'delete-case'); resetSelection(); toast('Đã xoá case.', 'ok');
    },
    'builder-save': () => saveBuilder(),
    'builder-json': () => {
      let testCase; try { testCase = builderCase(); } catch (error) { $('b-error').textContent = error.message; return; }
      $('builder').close(); window.EventQA.loadIntoRuleEditor(testCase);
    },
    'builder-close': () => $('builder').close(),
    'events-back': () => { ui.view = 'groups'; clearEventFilters(); },
    'events-clear': () => clearEventFilters(),
    'events-refresh': () => { ui.openEvents.clear(); ui.sig.events = null; render(); },
    shutdown: async () => {
      if (!confirm(ui.state?.running ? 'Phiên đang chạy sẽ được lưu rồi tắt ứng dụng. Tiếp tục?' : 'Tắt ứng dụng?')) return;
      const result = await api('shutdown', {}, 'shutdown'); ui.stopped = true;
      document.body.innerHTML = `<div class="stopped-screen"><h1>Đã tắt EventQA</h1><p>${esc(result.message || '')}</p><p class="hint">Có thể đóng tab này. Báo cáo nằm trong thư mục <code>runs</code>. Chạy lại file <code>start.cmd</code> để mở lại.</p></div>`;
    },
  };

  function bindCommon() {
    $('queues-close')?.addEventListener('click', () => $('queues-dialog').close());
    $('activity-close')?.addEventListener('click', () => $('activity-dialog').close());
    $('activity-more')?.addEventListener('click', run(() => refreshActivity(true)));
    for (const id of ['activity-from', 'activity-to', 'activity-channel', 'activity-spec-only', 'activity-flow']) $(id)?.addEventListener('input', () => {
      if (id === 'activity-flow' && $('activity-flow').value && ui.state?.specFlows?.length && !ui.state.specFlows.includes($('activity-flow').value)) {
        $('activity-spec-only').checked = false; toast('Luồng đã chọn khác sheet hiện tại. Đã tắt lọc theo sheet; nhập sheet của luồng này để đối chiếu.');
      }
      ui.sig.events = null; render();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
    $('setup-toggle')?.addEventListener('click', () => toggleSetup());
    $('spec-detail-close')?.addEventListener('click', () => $('spec-detail-dialog').close());
    $('sheet-select')?.addEventListener('change', () => { $('sheet').value = $('sheet-select').value; });
    $('spec-file')?.addEventListener('change', run(async () => {
      const file = $('spec-file').files[0]; if (!file) return;
      if (file.size > 3 * 1024 * 1024) throw new Error('Chọn file nhỏ hơn 3 MB.');
      const content = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = reject; reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file); });
      const uploaded = await api('spec-upload', { name: file.name, content }, 'spec-upload');
      $('spec-path').value = uploaded.path;
      const names = uploaded.sheets.map(s => s.name);
      const selected = names.includes('R1511') ? 'R1511' : names.includes('Tổng hợp Event tracking') ? 'Tổng hợp Event tracking' : names[0] || '';
      $('sheet-select').innerHTML = names.map(name => `<option>${esc(name)}</option>`).join('') || '<option>JSON — không có sheet</option>';
      $('sheet-select').disabled = !names.length; $('sheet-select').value = selected;
      $('sheet-list').innerHTML = names.map(name => `<option value="${esc(name)}"></option>`).join('');
      $('sheet').value = selected;
      $('spec-file-status').textContent = `${file.name} · ${names.length} sheet. Đã chọn ${selected || 'JSON'}; bấm Nhập file để áp dụng.`;
    }));
    document.addEventListener('pointerdown', event => { if (event.target.closest('.board')) ui.holdUntil = Date.now() + 700; }, true);
    $('ev-pending')?.addEventListener('click', () => { ui.openEvents.clear(); for (const d of $$('#events details[open]')) d.open = false; ui.sig.events = null; render(); });
    document.addEventListener('click', event => {
      const target = event.target.closest('[data-action], [data-case], [data-evidence], .stage-head, .tab, [data-browser], [data-url], [data-view], [data-build], [data-group-view], [data-add-endpoint], [data-target-mode], [data-expand], [data-spec-detail], [data-workspace-tab], [data-setup-stage], [data-activity-id], [data-activity-view]');
      if (!target || target.disabled) return;
      const d = target.dataset;
      if (d.activityId) return run(() => openActivity(d.activityId))();
      if (d.activityView) {
        for (const button of $$('[data-activity-view]')) button.setAttribute('aria-pressed', String(button === target));
        for (const panel of $$('[data-activity-panel]')) panel.classList.toggle('hidden', panel.dataset.activityPanel !== d.activityView);
        return;
      }
      if (d.workspaceTab) { selectTab(d.workspaceTab); if (d.workspaceTab === 'spec' && !ui.state?.cases.length) revealSetup('spec'); return; }
      if (d.setupStage) return revealSetup(d.setupStage);
      if (d.specDetail) return run(() => openSpecDetail(d.specDetail))();
      if (d.action && actions[d.action]) return run(actions[d.action])();
      if (d.action && ui.hooks.actions?.[d.action]) return run(ui.hooks.actions[d.action])();
      if (d.case) return selectCase(d.case);
      if (d.evidence) return jumpToEvidence(d.evidence);
      if (d.build) return run(() => openBuilder(d.build))();
      if (d.groupView) return showGroup(d.groupView);
      if (d.expand) { ui.expandedGroup = ui.expandedGroup === d.expand ? null : d.expand; ui.sig.events = null; return render(); }
      if (d.addEndpoint) return run(() => addEndpoint(d.addEndpoint))();
      if (d.view) { ui.view = d.view; ui.sig.events = null; if (d.view === 'stream' && ui.state?.eventsCompact) return void refresh(); return render(); }
      if (d.url) { $('url').value = d.url; ui.hooks.urlChanged?.(); return; }
      if (d.browser) return setBrowser(d.browser);
      if (d.targetMode) {
        for (const b of $$('[data-target-mode]')) b.setAttribute('aria-pressed', String(b === target));
        $('b-new').classList.toggle('hidden', d.targetMode !== 'new'); $('b-append').classList.toggle('hidden', d.targetMode === 'new'); return;
      }
      if (target.classList.contains('stage-head')) { const stage = target.closest('[data-stage]'); return setStage(stage.dataset.stage, !stage.classList.contains('open')); }
      if (target.classList.contains('tab')) return selectTab(d.tab);
    });
    $('builder')?.addEventListener('change', event => { if (event.target.matches('[data-f="op"]')) syncBuilderInputs(); });
    $('context')?.addEventListener('input', () => { validateContext(); if (ui.selectedCase) ui.contexts.set(ui.selectedCase, $('context').value); });
    $('case-json')?.addEventListener('input', () => parseJson('case-json', 'case-json-error'));
    $('context-format')?.addEventListener('click', () => { const parsed = validateContext(); if (parsed.ok) { $('context').value = JSON.stringify(parsed.value, null, 2); ui.contexts.set(ui.selectedCase, $('context').value); } });
    $('context-reset')?.addEventListener('click', () => { ui.contexts.delete(ui.selectedCase); selectCase(ui.selectedCase, { force: true }); });
    $('rule-reset')?.addEventListener('click', () => loadRuleEditor(caseById(ui.selectedCase)));
    for (const id of ['ev-layer', 'ev-source', 'ev-search', 'ev-marked', 'ev-system']) $(id)?.addEventListener('input', () => { if (id !== 'ev-marked' && id !== 'ev-system') ui.groupFilter = null; ui.sig.events = null; render(); });
    for (const id of ['spec-flow', 'spec-platform', 'spec-status', 'spec-search']) $(id)?.addEventListener('input', () => { ui.sig.spec = null; render(); });
    $('firing-status')?.addEventListener('input', () => { ui.sig.firing = null; render(); });
    $('events')?.addEventListener('toggle', event => {
      const id = event.target.dataset?.ev; if (!id) return;
      if (event.target.open) { ui.openEvents.add(id); const host = event.target.querySelector(`[data-detail="${CSS.escape(id)}"]`); if (host && !host.innerHTML.trim()) host.innerHTML = detailContent(id); }
      else ui.openEvents.delete(id);
    }, true);
    $('spec-path')?.addEventListener('keydown', event => { if (event.key === 'Enter') run(actions.import)(); });
    $('url')?.addEventListener('keydown', event => { if (event.key === 'Enter' && !ui.state?.running) run(actions.start)(); });
    $('url')?.addEventListener('input', () => ui.hooks.urlChanged?.());
    $('vendors')?.addEventListener('change', saveSite);
    $('patterns')?.addEventListener('change', saveSite);
  }

  window.EventQA = {
    boot({ token, mode, hooks = {} }) {
      ui.token = token; ui.mode = mode; ui.hooks = hooks;
      bindCommon(); selectTab('events'); restoreSite();
      refresh(); setInterval(refresh, 1500); setInterval(tickTimers, 1000);
    },
    api, toast, showError, esc, short, run, selectTab, refresh, get state() { return ui.state; }, get selectedCase() { return ui.selectedCase; },
    loadIntoRuleEditor(testCase) {
      if (!$('case-json')) return;
      toggleSetup(false);
      $('case-json').value = JSON.stringify(testCase, null, 2); if ($('approve')) $('approve').checked = !testCase.needs_review;
      if ($('rule-title')) $('rule-title').textContent = `${testCase.id || ''} (chưa lưu)`;
      setStage('step', true); $('with-cases')?.classList.remove('hidden'); $('rule-editor').open = true; $('case-json').scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
  };
})();
