import http from 'node:http';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SessionManager } from './core/session.mjs';
import { redact } from './core/privacy.mjs';
import { DEFAULT_ENDPOINT_PATTERNS, VENDOR_ENDPOINTS } from './core/decoder.mjs';
import { sanitizeCases } from './spec/sanitize.mjs';
import { specCoverage, matchTracked } from './core/catalog.mjs';
import { linkDeliveries, deliveryStatus, notForwarded, isRequest } from './core/delivery.mjs';
import { eventKind } from './core/event-kind.mjs';
import { firingChecks } from './core/firing.mjs';
import { activityEvent, activityEntries } from './core/activity.mjs';
import { importSpec, specSheets, validateTestCase } from './spec/import.mjs';
import { exportReports } from './report/export.mjs';
import { CDPCollector, listTargets } from './collectors/cdp.mjs';
import { launchBrowser, closeOwnedBrowser, createTestPage } from './browser/launcher.mjs';
import { OpenRouterClient } from './ai/openrouter.mjs';
import { loadDemoCases } from './demo.mjs';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const readWeb = name => fs.readFile(new URL(`./web/${name}`, import.meta.url), 'utf8');
// Each mode has its own screen; styling and client logic are shared assets.
const MODE_PAGES = { cdp: 'cdp.html', 'cdp-ai': 'cdp-ai.html' };
const ASSETS = { '/assets/eventqa.css': ['shared/eventqa.css', 'text/css; charset=utf-8'], '/assets/eventqa.js': ['shared/eventqa.js', 'text/javascript; charset=utf-8'] };
const PAGE_POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Smoke tests only: run the test browser without a window.
const headless = process.env.EVENTQA_HEADLESS === '1';
// Chrome network errors when the test website cannot be opened, explained for QC.
function navigationHint(host, code) {
  if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/.test(code)) return `Không tìm thấy tên miền ${host}. Kiểm tra chính tả; website nội bộ/staging cần bật VPN hoặc mạng công ty (hoặc khai báo trong file hosts).`;
  if (/CONNECTION_REFUSED|CONNECTION_TIMED_OUT|TIMED_OUT|ADDRESS_UNREACHABLE|CONNECTION_RESET/.test(code)) return `Máy chủ ${host} không phản hồi (${code}). Kiểm tra website có đang chạy và mạng/VPN.`;
  if (/CERT|SSL/.test(code)) return `Lỗi chứng chỉ HTTPS khi mở ${host} (${code}).`;
  return `Không mở được ${host} (${code}).`;
}
const reviewedSpecPath = path.join(rootDir, 'imports', 'reviewed-cases.json');

/** Counts per event name/layer/source over all evidence, for exploring a site without a specification. */
function summarize(events, links, now = Date.now()) {
  const groups = new Map();
  for (const event of events) {
    const phase = event.network?.phase;
    const key = [event.layer, event.source, event.event_name].join('|');
    let group = groups.get(key);
    if (!group) groups.set(key, group = { key, event_name: event.event_name, layer: event.layer, source: event.source, count: 0, bound: 0, failed: 0, not_sent: 0, first_at: event.captured_at, last_at: event.captured_at, last_evidence_id: null, pages: [] });
    if (phase === 'failed' || (phase === 'response' && Number(event.network?.status) >= 400)) group.failed++;
    if (phase && phase !== 'request') continue;
    group.count++; if (event.step_id) group.bound++;
    if (deliveryStatus(event, links, now) === 'not_sent') group.not_sent++;
    group.last_at = event.captured_at; group.last_evidence_id = event.evidence_id;
    let page = ''; try { const url = new URL(event.page?.url); page = url.host + url.pathname; } catch {}
    if (page && !group.pages.includes(page) && group.pages.length < 3) group.pages.push(page);
  }
  return [...groups.values()].filter(group => group.count).sort((a, b) => b.last_at.localeCompare(a.last_at));
}

// Writes the OpenRouter key entered on the AI screen into .env (excluded from Git and the portable
// package) and turns AI on; other settings in the file are kept.
async function saveAiKey(envPath, key) {
  const current = await fs.readFile(envPath, 'utf8')
    .catch(() => fs.readFile(path.join(rootDir, '.env.example'), 'utf8'))
    .catch(() => '');
  const lines = current.split(/\r?\n/).filter((line, index, all) => line || index < all.length - 1);
  for (const [name, value] of [['AI_ENABLED', 'true'], ['OPENROUTER_API_KEY', key]]) {
    const index = lines.findIndex(line => line.startsWith(`${name}=`));
    if (index === -1) lines.push(`${name}=${value}`); else lines[index] = `${name}=${value}`;
  }
  await fs.writeFile(envPath, `${lines.join('\n')}\n`, { mode: 0o600 });
}

export async function createApp({ mode = 'cdp', runsDir = path.join(rootDir, 'runs'), port = 4173, aiClient, initialCases = 'demo', envPath = path.join(rootDir, '.env') } = {}) {
  if (!['cdp', 'cdp-ai'].includes(mode)) throw new Error('Mode must be cdp or cdp-ai.');
  const csrf = randomBytes(24).toString('hex');
  // 'auto' (CLI) resumes reviewed rules or starts empty for a real site; tests keep the demo default.
  let specSource = 'demo', cases;
  if (Array.isArray(initialCases)) { cases = initialCases; specSource = initialCases.length ? 'file' : 'none'; }
  else if (initialCases === 'auto') {
    try { cases = JSON.parse(await fs.readFile(reviewedSpecPath, 'utf8')).cases.map(validateTestCase); specSource = 'reviewed'; }
    catch { cases = []; specSource = 'none'; }
  } else cases = await loadDemoCases();
  const manager = new SessionManager({ mode, runsDir, cases });
  let activePatterns = [...DEFAULT_ENDPOINT_PATTERNS], navigationError = null;
  // Firing checks over all evidence; recomputed only when evidence grows.
  let firingCache = { count: -1, result: null };
  const firingResult = events => { if (firingCache.count !== events.length) firingCache = { count: events.length, result: firingChecks(events) }; return firingCache.result; };
  const firingState = events => {
    const { byEvent, summary } = firingResult(events);
    const byId = new Map(events.map(event => [event.evidence_id, event]));
    const problems = [...byEvent.entries()].flatMap(([id, checks]) => checks.filter(check => check.status !== 'PASS').map(check => ({ ...check, id, event_name: byId.get(id)?.event_name, source: byId.get(id)?.source, layer: byId.get(id)?.layer, at: byId.get(id)?.captured_at })));
    return { summary, problems: problems.slice(-200).reverse(), problemCount: problems.length };
  };
  // Which push each vendor hit sent; recomputed only when evidence grows.
  let linkCache = { count: -1, links: null };
  const deliveryLinks = events => { if (linkCache.count !== events.length) linkCache = { count: events.length, links: linkDeliveries(events) }; return linkCache.links; };
  // Events Google/Insider received (one per vendor hit, named as the website pushed them), and pushes
  // no request carried (yet).
  const deliveryCounts = events => {
    const links = deliveryLinks(events), now = Date.now(), counts = { sent: 0, kinds: 0, not_sent: 0, pending: 0 }, kinds = new Set();
    for (const event of events) {
      const status = deliveryStatus(event, links, now);
      if (status === 'not_sent' || status === 'pending') counts[status]++;
      else if (isRequest(event) && eventKind(event) === 'business') {
        counts.sent++; kinds.add(`${event.source}|${links.pushOf.get(event.evidence_id)?.event_name ?? event.event_name}`);
      }
    }
    return { ...counts, kinds: kinds.size };
  };
  // Event-to-specification matches, reset whenever the cases change.
  let coverageCases = null, coverageCache = new Map();
  const coverage = events => {
    if (!manager.cases.length) return null;
    if (coverageCases !== manager.cases) { coverageCases = manager.cases; coverageCache = new Map(); }
    return specCoverage(manager.cases, events, coverageCache, { links: deliveryLinks(events) });
  };
  const statuses = []; let collector = null, browserHandle = null, exported = null, mutating = false;
  let closing = false, closePromise = null, stoppingSession = null, captureEpoch = 0;
  const status = message => { statuses.push({ at: new Date().toISOString(), message: redact(String(message && typeof message === 'object' ? message.message ?? JSON.stringify(message) : message)) }); if (statuses.length > 40) statuses.shift(); };
  let ai = aiClient ?? new OpenRouterClient();
  const state = ({ compact = false } = {}) => {
    const snapshot = manager.snapshot();
    return { application: 'event-tracking-qa', mode, process_id: process.pid, closing, ai: mode === 'cdp-ai' ? ai.diagnostics?.() : undefined, running: manager.session?.status === 'RUNNING', session: manager.session || null,
      specSource, navigationError, patterns: activePatterns, vendors: VENDOR_ENDPOINTS, discovered: collector?.discovered ? [...collector.discovered.values()].sort((a, b) => b.count - a.count) : [],
      eventSummary: summarize(snapshot.events, deliveryLinks(snapshot.events)), delivery: deliveryCounts(snapshot.events), specCoverage: coverage(snapshot.events), firing: firingState(snapshot.events), currentStep: manager.currentStep, stepEventCount: manager.currentStep ? snapshot.events.filter(event => event.step_id === manager.currentStep.id).length : 0, runDir: manager.runDir || null, cases: manager.cases, results: snapshot.results, steps: manager.steps,
      events: snapshot.events.slice(-100).map(e => compact ? { evidence_id: e.evidence_id, source: e.source, layer: e.layer, event_name: e.event_name, captured_at: e.captured_at, historical: e.historical, page: e.page, network: e.network, step_id: e.step_id, test_case_id: e.test_case_id } : e), eventsCompact: compact, eventCount: snapshot.events.length, statuses, exported: exported ? Object.fromEntries(Object.entries(exported).map(([k, p]) => [k, `/download/${path.basename(p)}`])) : null };
  };
  // One captured event with the specification row it matched (field-by-field outcome), its firing
  // checks, and its delivery: the website push, the vendor hit that sent it, and for GA4 the pushed
  // fields Google did not receive.
  function eventDetail(id) {
    const events = manager.snapshot().events;
    const event = events.find(candidate => candidate.evidence_id === id);
    if (!event) return null;
    const links = deliveryLinks(events);
    const match = manager.cases.length ? matchTracked(manager.cases, event, { links }) : null;
    const testCase = match && manager.cases.find(c => c.id === match.case_id);
    const spec = match ? { ...match, event_name: testCase?.rules?.[0]?.event_name, stt: testCase?.stt ?? '', flow: testCase?.flow ?? '', description: testCase?.description ?? '', notes: testCase?.notes ?? '', provenance: testCase?.provenance, sample: testCase?.sample, sample_text: testCase?.sample_text } : null;
    const push = event.layer === 'JS_QUEUE' ? event : links.pushOf.get(event.evidence_id) ?? null;
    const hit = event.layer === 'TRACKING_REQUEST' ? event : links.sentBy.get(event.evidence_id) ?? null;
    const delivery = { status: deliveryStatus(push ?? event, links), push, hit, not_forwarded: push && hit?.source === 'GA4' ? notForwarded(push, hit) : [] };
    return { event, spec, firing: firingResult(events).byEvent.get(event.evidence_id) ?? [], delivery };
  }
  // What the AI reads to review a session: the QC's requirement, the specification rows the session is
  // about (rows with evidence and the unseen rows of the same flows), the tool's verdict per row, what
  // reached Google/Insider, pushes never sent, events outside the specification and firing problems.
  function sessionReviewInput(events, requirement) {
    const links = deliveryLinks(events), now = Date.now();
    const rows = activityEntries(events, { links, now }).filter(row => row.event_kind === 'business');
    const covered = coverage(events);
    const flows = new Set(covered?.rows.filter(row => row.seen || row.not_sent).map(row => row.flow));
    const relevant = covered ? covered.rows.filter(row => row.status !== 'NOT_SEEN' || !flows.size || flows.has(row.flow)).slice(0, 80) : [];
    const caseById = new Map(manager.cases.map(testCase => [testCase.id, testCase]));
    const where = url => { try { const parsed = new URL(url); return parsed.pathname + parsed.search.slice(0, 80); } catch { return ''; } };
    return {
      requirement: requirement || null,
      specification: relevant.map(row => ({ event: row.event_name, vendor: row.source, flow: row.flow, when_fired: String(row.description ?? '').slice(0, 220), notes: String(row.notes ?? '').slice(0, 160),
        expected_fields: Object.keys(caseById.get(row.case_id)?.rules?.[0]?.fields ?? {}).slice(0, 30), sheet_row: `${row.sheet ?? ''}!${row.row ?? ''}` })),
      coverage: relevant.map(row => ({ event: row.event_name, flow: row.flow, status: row.status, times_sent: row.seen, not_sent: row.not_sent,
        issues: row.issues.slice(0, 6).map(issue => ({ code: issue.code, field: issue.path, expected: issue.expected, actual: issue.actual })) })),
      sent_events: rows.filter(row => row.delivery === 'sent').slice(-120).map(row => ({ at: row.captured_at.slice(11, 19), vendor: row.source, event: row.display_name, page: where(row.page?.url),
        ...(row.measurement_id ? { ga4_property: row.measurement_id } : {}), ...(row.repeat ? { repeat_after_s: Number((row.repeat.after_ms / 1000).toFixed(1)) } : {}) })),
      not_sent: rows.filter(row => row.delivery === 'not_sent').slice(-40).map(row => ({ at: row.captured_at.slice(11, 19), vendor: row.source, event: row.event_name, page: where(row.page?.url) })),
      outside_spec: covered?.unmatched.slice(0, 30).map(item => ({ vendor: item.source, event: item.event_name, count: item.count })) ?? [],
      firing_problems: firingState(events).problems.slice(0, 40).map(problem => ({ rule: problem.rule, level: problem.status, event: problem.event_name, message: problem.message })),
    };
  }
  // The AI writes the words; which rows are correct, wrong or missing is the tool's verdict. The three
  // lists are rebuilt from it, keeping the AI's sentence for a row only when it names that row's event
  // and no other event of the review (page_view is not named by "listing_page_view").
  function alignReview(review, rows) {
    const literal = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const named = [...new Set(rows.map(row => row.event))].map(event => [event, new RegExp(`(?:^|\\W)${literal(event)}(?:\\W|$)`)]);
    const used = new Set();
    const sentence = (items, row) => {
      const item = items.find(text => !used.has(text) && named.every(([event, pattern]) => pattern.test(text) === (event === row.event)));
      if (item) used.add(item);
      return item;
    };
    const issues = row => row.issues.slice(0, 3).map(issue => [issue.code, issue.field].filter(Boolean).join(' ')).join(', ');
    return { ...review,
      correct: rows.filter(row => row.status === 'MATCH').map(row => `${row.event} · ${row.flow}`),
      wrong: rows.filter(row => row.status === 'MISMATCH').map(row => sentence(review.wrong, row) ?? `${row.event} · ${row.flow}: ${issues(row)}`),
      missing: rows.filter(row => row.status === 'NOT_SEEN' || row.status === 'NOT_SENT')
        .map(row => sentence(review.missing, row) ?? `${row.event} · ${row.flow}: ${row.status === 'NOT_SENT' ? 'có push nhưng không gửi lên server' : 'chưa thấy'}`) };
  }
  async function bounded(promise, milliseconds) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cleanup deadline exceeded')), milliseconds); })]); }
    finally { clearTimeout(timer); }
  }
  async function stopCapture() {
    captureEpoch++;
    const current = collector; collector = null;
    if (!current) return;
    try { await bounded(current.stop(), 4500); }
    catch {
      current.forceStop?.();
      status('Collector đã dừng sau giới hạn thời gian chờ.');
    }
  }
  // A test window left open from an earlier run still owns its profile and debug port:
  // reuse it (keeping the login) instead of failing to launch a second one.
  async function openTestBrowser(options) {
    let targets = null;
    try { targets = await listTargets(options.port); } catch { /* nothing listening */ }
    if (targets) {
      status(`Dùng lại cửa sổ trình duyệt test đang mở (cổng ${options.port}); app sẽ không tự đóng cửa sổ này.`);
      return { reused: true, targetId: await createTestPage({ port: options.port, headless: options.headless }) };
    }
    try {
      browserHandle = await launchBrowser({ ...options, url: 'about:blank' });
      return { reused: false, targetId: await createTestPage({ port: options.port, headless: options.headless }) };
    }
    catch (error) {
      if (/exited before the debug endpoint was ready (code 21)/.test(error.message)) throw new Error('Cửa sổ trình duyệt test cũ vẫn đang mở với profile này nhưng không còn kết nối được. Đóng hết cửa sổ Chrome/Edge test rồi bấm lại.');
      throw error;
    }
  }
  async function releaseBrowser() {
    const current = browserHandle; browserHandle = null;
    if (!current) return;
    try { await bounded(closeOwnedBrowser(current), 2000); }
    catch { status('Đã ngừng thu thập; có thể đóng cửa sổ trình duyệt test còn lại.'); }
  }
  async function stopSession() {
    if (stoppingSession) return stoppingSession;
    if (!manager.session || manager.session.status !== 'RUNNING') return { snapshot: manager.snapshot(), files: exported, interrupted: manager.session?.status === 'INTERRUPTED' };
    const pending = (async () => {
      // Cancel remote work immediately; shutdown never waits for AI routing/retries.
      captureEpoch++;
      ai.close?.();
      if (!closing && !aiClient) ai = new OpenRouterClient();
      await stopCapture();
      const interrupted = Boolean(manager.currentStep);
      if (interrupted) manager.abort(); else manager.finish();
      const snapshot = manager.snapshot();
      try { exported = await exportReports(snapshot, manager.runDir); }
      catch (error) { status(`Bằng chứng đã lưu; xuất báo cáo gặp lỗi: ${error.message}`); }
      await releaseBrowser();
      status(interrupted ? 'Đã dừng phiên; bước đang làm được giữ REVIEW.' : 'Đã kết thúc và lưu báo cáo.');
      return { snapshot, files: exported, interrupted };
    })();
    stoppingSession = pending;
    try { return await pending; }
    finally { if (stoppingSession === pending) stoppingSession = null; }
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    ai.close?.();
    closePromise = (async () => {
      try { await stopSession(); }
      finally {
        await stopCapture(); await releaseBrowser();
        if (server.listening) {
          const closed = new Promise(resolve => server.close(resolve));
          server.closeIdleConnections?.();
          try { await bounded(closed, 1000); }
          catch { server.closeAllConnections?.(); await bounded(closed, 1000).catch(() => {}); }
        }
      }
    })();
    return closePromise;
  }
  const send = (res, code, data, contentType = 'application/json; charset=utf-8', headers = {}) => { res.writeHead(code, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers }); res.end(contentType.startsWith('application/json') ? JSON.stringify(data) : data); };
  async function body(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 5 * 1024 * 1024) throw new Error('Request vượt 5 MB.'); chunks.push(chunk); }
    const raw = Buffer.concat(chunks).toString('utf8'); return raw ? JSON.parse(raw) : {};
  }
  const server = http.createServer(async (req, res) => {
    try {
      const addresses = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!addresses.has(req.headers.host)) return send(res, 403, { error: 'Localhost Host header required.' });
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, (await readWeb(MODE_PAGES[mode])).replaceAll('__CSRF__', csrf), 'text/html; charset=utf-8', { 'Content-Security-Policy': PAGE_POLICY });
      if (req.method === 'GET' && ASSETS[url.pathname]) return send(res, 200, await readWeb(ASSETS[url.pathname][0]), ASSETS[url.pathname][1]);
      if (req.method === 'GET' && url.pathname === '/demo') return send(res, 200, await readWeb('demo.html'), 'text/html; charset=utf-8');
      if (req.method === 'POST' && ['/demo/g/collect', '/demo/insider/events'].includes(url.pathname)) {
        await bodyForDiscard(req); res.writeHead(204); return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, state({ compact: url.searchParams.get('compact') === '1' }));
      if (req.method === 'GET' && url.pathname === '/api/activity') {
        const events = manager.snapshot().events;
        const entries = activityEntries(events, { links: deliveryLinks(events) });
        const before = url.searchParams.get('before');
        const end = before ? entries.findIndex(e => e.evidence_ids.includes(before)) : entries.length;
        if (end < 0) return send(res, 400, { error: 'Mốc event không thuộc phiên hiện tại.' });
        const start = Math.max(0, end - 100);
        const page = entries.slice(start, end).reverse().map(activity => url.searchParams.get('compact') === '1'
          ? { ...activity, json: undefined, default_count: Object.keys(activity.json.default_parameters).length, custom_count: Object.keys(activity.json.custom_parameters).length } : activity);
        return send(res, 200, { events: page, total: entries.length, next: start > 0 ? entries[start].evidence_id : null, session_id: manager.session?.id || null });
      }
      if (req.method === 'GET' && url.pathname === '/api/pushes') {
        // dataLayer / InsiderQueue as F12 shows them: one row per array element (a custom_event push
        // carrying several events is one element), with whether it reached the vendor.
        const events = manager.snapshot().events, links = deliveryLinks(events), now = Date.now();
        const pushes = events.filter(event => event.layer === 'JS_QUEUE' && !(event.queue_batch_index > 0));
        return send(res, 200, { total: pushes.length, session_id: manager.session?.id || null, pushes: pushes.slice(-300).reverse().map(event => ({
          evidence_id: event.evidence_id, captured_at: event.captured_at, queue_name: event.queue_name, queue_index: event.queue_index, event_name: event.event_name,
          event_kind: eventKind(event), historical: Boolean(event.historical), page: event.page, payload: event.queue_payload ?? event.payload,
          delivery: deliveryStatus(event, links, now), sent_by: links.sentBy.get(event.evidence_id)?.evidence_id ?? null })) });
      }
      if (req.method === 'GET' && url.pathname === '/api/spec/export') return send(res, 200, { schema_version: '1.0', kind: 'specification', cases: sanitizeCases(manager.cases) }, 'application/json; charset=utf-8', { 'Content-Disposition': 'attachment; filename="event-catalogue.json"' });
      if (req.method === 'GET' && url.pathname === '/api/event') {
        const detail = eventDetail(url.searchParams.get('id'));
        if (!detail) return send(res, 404, { error: 'Không có event này trong phiên.' });
        const events = manager.snapshot().events;
        return send(res, 200, { ...detail, activity: activityEntries(events, { links: deliveryLinks(events) }).find(row => row.evidence_ids.includes(detail.event.evidence_id)) ?? activityEvent(detail.event) });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/download/')) {
        if (!exported || !manager.runDir) return send(res, 404, { error: 'Chưa có report.' });
        const name = decodeURIComponent(url.pathname.slice('/download/'.length));
        const match = Object.values(exported).find(p => path.basename(p) === name);
        if (!match || path.dirname(path.resolve(match)) !== path.resolve(manager.runDir)) return send(res, 404, { error: 'Không có file này.' });
        res.writeHead(200, { 'Content-Type': name.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : name.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'X-Content-Type-Options': 'nosniff' }); return res.end(await fs.readFile(match));
      }
      if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
      const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
      if (req.headers['x-eventqa-token'] !== csrf || (req.headers.origin && !origins.includes(req.headers.origin))) return send(res, 403, { error: 'Local request token required.' });
      // Stop commands remain available during a slow capture, export or AI request.
      if (url.pathname === '/api/shutdown') {
        req.resume();
        closing = true;
        res.once('finish', () => { setImmediate(() => close().catch(error => status(error.message))); });
        return send(res, 200, { stopping: true, message: 'Đang lưu bằng chứng và tắt ứng dụng.' });
      }
      if (url.pathname === '/api/stop-session') {
        req.resume();
        const result = await stopSession();
        return send(res, 200, { ...state(), stopped: true, interrupted: result.interrupted });
      }
      if (closing || stoppingSession) return send(res, 503, { error: 'Ứng dụng đang dừng; bằng chứng đang được lưu.' });
      if (mutating) return send(res, 409, { error: 'Đang xử lý thao tác trước.' });
      mutating = true;
      try {
        const data = await body(req);
        if (url.pathname === '/api/spec-upload') {
          if (manager.currentStep) throw new Error('Hoàn tất bước trước khi chọn file.');
          const ext = path.extname(String(data.name)).toLowerCase();
          if (!['.xlsx', '.json'].includes(ext) || typeof data.content !== 'string') throw new Error('Chỉ nhận XLSX hoặc JSON.');
          const bytes = Buffer.from(data.content, 'base64');
          if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw new Error('File phải nhỏ hơn 3 MB.');
          const dir = path.join(rootDir, 'imports', 'uploads');
          await fs.mkdir(dir, { recursive: true });
          const file = path.join(dir, `${randomBytes(12).toString('hex')}${/insider/i.test(String(data.name)) ? '-Insider' : ''}${ext}`);
          await fs.writeFile(file, bytes, { flag: 'wx' });
          try {
            const sheets = ext === '.xlsx' ? await specSheets(file) : [];
            return send(res, 200, { path: file, sheets });
          } catch (error) { await fs.rm(file, { force: true }); throw error; }
        } else if (url.pathname === '/api/import') {
          // A specification can arrive after exploring the site, as long as no step depends on the old one.
          if (manager.session?.status === 'RUNNING' && manager.steps.length) throw new Error('Phiên đã có bước dùng đặc tả hiện tại; kết thúc phiên trước khi đổi file đặc tả.');
          if (!['.xlsx', '.json'].includes(path.extname(String(data.path)).toLowerCase())) throw new Error('Chỉ nhận XLSX hoặc JSON.');
          const imported = await importSpec(path.resolve(String(data.path)), { sheet: data.sheet || undefined });
          if (!imported.cases.length) throw new Error('Không tìm thấy test case hợp lệ.');
          manager.cases = imported.cases; specSource = 'file';
          if (manager.session?.status === 'RUNNING') manager.store.saveExpected(sanitizeCases(manager.cases));
          status(`Đã nhập ${imported.cases.length} test case. ${imported.warnings.join(' ')}`);
          return send(res, 200, { ...state(), importWarnings: imported.warnings });
        } else if (url.pathname === '/api/demo-spec') {
          if (manager.session?.status === 'RUNNING') throw new Error('Kết thúc phiên trước khi đổi specification.');
          manager.cases = await loadDemoCases(); specSource = 'demo'; status('Đã nạp 3 test case demo.');
        } else if (url.pathname === '/api/save-case') {
          // Rules may be written from evidence while the logged-in session keeps running.
          if (manager.currentStep) throw new Error('Hoàn tất bước đang ghi trước khi sửa rule.');
          const testCase = validateTestCase(data.case);
          const index = manager.cases.findIndex(c => c.id === testCase.id);
          manager.cases = index === -1 ? [...manager.cases, testCase] : manager.cases.map((c, i) => i === index ? testCase : c);
          const specDir = path.join(rootDir, 'imports'); await fs.mkdir(specDir, { recursive: true });
          await fs.writeFile(reviewedSpecPath, JSON.stringify({ cases: manager.cases }, null, 2)); specSource = 'reviewed';
          if (manager.session?.status === 'RUNNING') { manager.store.saveExpected(sanitizeCases(manager.cases)); status(`Đã lưu ${testCase.id} giữa phiên; expected.json của phiên được cập nhật.`); }
          else status('Đã lưu specification vào imports/reviewed-cases.json.');
        } else if (url.pathname === '/api/delete-case') {
          if (manager.currentStep) throw new Error('Hoàn tất bước đang ghi trước khi xoá case.');
          const id = String(data.id);
          if (manager.steps.some(step => step.test_case_id === id)) throw new Error('Case đã có bước trong phiên này nên không xoá được; xoá sau khi kết thúc phiên.');
          manager.cases = manager.cases.filter(c => c.id !== id);
          await fs.mkdir(path.dirname(reviewedSpecPath), { recursive: true });
          await fs.writeFile(reviewedSpecPath, JSON.stringify({ cases: manager.cases }, null, 2));
          if (manager.session?.status === 'RUNNING') manager.store.saveExpected(sanitizeCases(manager.cases));
          status(`Đã xoá case ${id}.`);
        } else if (url.pathname === '/api/endpoints') {
          const patterns = Array.isArray(data.patterns) ? data.patterns.filter(p => typeof p === 'string' && p.length && p.length < 500) : null;
          if (!patterns?.length) throw new Error('Cần ít nhất một endpoint.');
          for (const pattern of patterns) { try { new RegExp(pattern, 'i'); } catch { throw new Error(`Regex endpoint không hợp lệ: ${pattern}`); } }
          activePatterns = patterns; collector?.setPatterns?.(patterns);
          status(`Allowlist: ${patterns.length} endpoint${collector ? ' (áp dụng cho request mới)' : ''}.`);
        } else if (url.pathname === '/api/start') {
          if (manager.session?.status === 'RUNNING') throw new Error('Đã có phiên đang chạy.');
          const rawUrl = String(data.url || `http://127.0.0.1:${port}/demo`).trim();
          let targetUrl;
          try { targetUrl = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`); }
          catch { throw new Error('URL chưa hợp lệ. Ví dụ: www.website.vn hoặc https://www.website.vn/'); }
          if (!['http:', 'https:'].includes(targetUrl.protocol)) throw new Error('URL cần dùng http hoặc https.');
          const browser = data.browser === 'edge' ? 'edge' : 'chrome';
          const debugPort = Number(data.debugPort || ({ cdp: 9222, 'cdp-ai': 9223 }[mode]));
          const endpointPatterns = Array.isArray(data.endpointPatterns) ? data.endpointPatterns.filter(p => typeof p === 'string' && p.length < 500) : [...DEFAULT_ENDPOINT_PATTERNS];
          if (targetUrl.hostname === '127.0.0.1' && targetUrl.pathname === '/demo') endpointPatterns.push('/demo/g/collect', '/demo/insider/events');
          activePatterns = endpointPatterns;
          // A failed lookup is a warning only: the test browser may still reach it through a system proxy.
          navigationError = null;
          if (!['127.0.0.1', 'localhost'].includes(targetUrl.hostname)) {
            try { await dns.lookup(targetUrl.hostname); }
            catch (error) { navigationError = navigationHint(targetUrl.hostname, error.code || 'ENOTFOUND'); }
          }
          const captureQueues = data.captureQueues !== false;
          manager.start({ browser, environment: targetUrl.origin, target_url: targetUrl.toString(), capture_queues: captureQueues }); exported = null;
          const epoch = ++captureEpoch;
          const emit = event => epoch === captureEpoch ? manager.emit(event) : null;
          try {
            const opened = !data.attach ? await openTestBrowser({ browser, port: debugPort, headless, url: 'about:blank', profileDir: path.join(rootDir, 'profiles', `${mode}-${browser}`) }) : null;
            if (closing || epoch !== captureEpoch) { await releaseBrowser(); return send(res, 200, state()); }
            collector = new CDPCollector({ port: debugPort, targetId: data.targetId || undefined, onEvent: emit, onStatus: status, endpointPatterns, captureQueues });
            await collector.start(manager.session);
            if (!data.attach) {
              const page = collector.connections.get(opened.targetId);
              if (!page) throw new Error('Không kết nối được tab test vừa mở.');
              const { frameTree } = await page.connection.send('Page.getFrameTree');
              const navigation = await page.connection.send('Page.navigate', { url: targetUrl.toString(), frameId: frameTree.frame.id });
              if (navigation.errorText) navigationError = navigationHint(targetUrl.hostname, navigation.errorText);
            }
            status(navigationError || 'Collector đã sẵn sàng. Chọn test case và bắt đầu bước trước khi thao tác.');
            if (!captureQueues) status('Đang chỉ bắt request: không gắn hook JavaScript vào website. Tầng JS queue không được quan sát.');
            if (closing || epoch !== captureEpoch) { await stopCapture(); await releaseBrowser(); }
          } catch (error) { await stopCapture(); manager.abort(); throw error; }
        } else if (url.pathname === '/api/step/start') {
          manager.startStep(String(data.testCaseId), data.context || {}); status('Đang ghi nhận bước. Hãy thao tác trên trình duyệt test.');
        } else if (url.pathname === '/api/step/complete') {
          // Drain in-flight decoder/response callbacks before closing the scope.
          await sleep(200); const result = manager.completeStep(); status(`Kết quả bước: ${result.verdict}`);
          if (mode === 'cdp-ai' && result.verdict === 'FAIL') {
            const epoch = captureEpoch;
            const note = await ai.explain(result);
            if (closing || epoch !== captureEpoch) return send(res, 200, state());
            // Lifecycle events may have replaced this step result during the AI call.
            const latest = manager.results.find(candidate => candidate.step_id === result.step_id) || result;
            if (note.available) { latest.ai_note = note.note; latest.ai_routing = note.routing; status(`AI: ${note.routing?.model || 'completed'}`); }
            else status(`AI: ${note.reason || 'unavailable'}`);
            manager.persist();
          }
        } else if (url.pathname === '/api/finish') {
          if (!manager.session || manager.session.status !== 'RUNNING') throw new Error('Chưa có phiên đang chạy.');
          if (manager.currentStep) throw new Error('Hoàn tất bước hiện tại trước.');
          await stopSession(); status(`Đã xuất report tại ${manager.runDir}`);
        } else if (url.pathname === '/api/export') {
          if (!manager.session) throw new Error('Chưa có phiên.');
          exported = await exportReports(manager.snapshot(), manager.runDir); status('Đã xuất report hiện tại.');
        } else if (url.pathname === '/api/ai-key') {
          if (mode !== 'cdp-ai') throw new Error('Chức năng AI chỉ có trong bản AI.');
          const key = String(data.key ?? '').trim();
          if (!/^\S{20,300}$/.test(key)) throw new Error('Key chưa đúng: dán nguyên key OpenRouter (dạng sk-or-v1-…), không có khoảng trắng.');
          await saveAiKey(envPath, key);
          process.env.AI_ENABLED = 'true'; process.env.OPENROUTER_API_KEY = key;
          if (!aiClient) { ai.close?.(); ai = new OpenRouterClient(); }
          status('Đã lưu key OpenRouter vào .env và bật AI. Bấm “Kiểm tra kết nối AI” để thử.');
        } else if (url.pathname === '/api/ai-review') {
          if (mode !== 'cdp-ai') throw new Error('Chức năng AI chỉ có trong bản AI.');
          const events = manager.snapshot().events;
          if (!events.length) throw new Error('Phiên chưa có event để AI kiểm tra. Mở website và thao tác trước.');
          const input = sessionReviewInput(events, String(data.requirement ?? '').trim().slice(0, 3000));
          const result = await ai.reviewSession(input);
          if (result.available) result.review = alignReview(result.review, input.coverage);
          return send(res, 200, result);
        } else if (url.pathname === '/api/ai-explain-event') {
          if (mode !== 'cdp-ai') throw new Error('Chức năng AI chỉ có trong bản AI.');
          const detail = eventDetail(String(data.id));
          if (!detail) throw new Error('Không có event này trong phiên.');
          return send(res, 200, await ai.explainEvent({ ...detail, specLoaded: manager.cases.length > 0 }));
        } else if (url.pathname === '/api/ai-draft') {
          if (mode !== 'cdp-ai') throw new Error('Chức năng AI chỉ có trong bản AI.');
          if (!data.input || typeof data.input !== 'object' || Array.isArray(data.input)) throw new Error('AI input cần là JSON object chứa đặc tả.');
          const draft = await ai.draftCase(data.input); return send(res, 200, draft);
        } else if (url.pathname === '/api/ai-models') {
          if (mode !== 'cdp-ai') throw new Error('Chức năng AI chỉ có trong bản AI.');
          return send(res, 200, { ...await ai.listRoutingCandidates({ task: 'spec' }), diagnostics: ai.diagnostics() });
        } else if (url.pathname === '/api/ai-test') {
          if (mode !== 'cdp-ai') throw new Error('Chức năng AI chỉ có trong bản AI.');
          const result = await ai.explain({ test_case_id: 'AI-CONNECTION-DEMO', verdict: 'FAIL', issues: [{ code: 'MISSING_FIELD', path: 'destination_id', evidence_id: 'DEMO-EV-1' }] });
          return send(res, 200, { ...result, diagnostics: ai.diagnostics() });
        } else if (url.pathname === '/api/targets') return send(res, 200, { targets: await listTargets(Number(data.port || 9222)) });
        else throw new Error('API không tồn tại.');
        return send(res, 200, state());
      } finally { mutating = false; }
    } catch (error) { status(error.message); send(res, 400, { error: redact(error.message) }); }
  });
  async function bodyForDiscard(req) { let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Demo body too large.'); } }
  return { server, manager, state, csrf, stopSession, close, async listen() {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); port = server.address().port; return `http://127.0.0.1:${port}`;
  } };
}
