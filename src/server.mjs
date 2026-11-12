import http from 'node:http';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SessionManager } from './core/session.mjs';
import { redact } from './core/privacy.mjs';
import { DEFAULT_ENDPOINT_PATTERNS, VENDOR_ENDPOINTS, decodeRequest } from './core/decoder.mjs';
import { sanitizeCases } from './spec/sanitize.mjs';
import { specCoverage, matchTracked, sessionRows } from './core/catalog.mjs';
import { linkDeliveries, deliveryStatus, notForwarded, isRequest } from './core/delivery.mjs';
import { eventKind } from './core/event-kind.mjs';
import { firingChecks } from './core/firing.mjs';
import { activityEvent, activityEntries } from './core/activity.mjs';
import { priceChecks } from './core/api-prices.mjs';
import { apiLogPatterns, DEFAULT_API_LOG_PATTERNS } from './core/api-log.mjs';
import { importSpec, specSheets, validateTestCase, manualCase } from './spec/import.mjs';
import { exportReports, prepareReportData } from './report/export.mjs';
import { comparedView, comparedRecord } from './report/event-report.mjs';
import { payloadDiff, diffSentences } from './core/payload-diff.mjs';
import { CDPCollector, listTargets, queueEvents } from './collectors/cdp.mjs';
import { launchBrowser, closeOwnedBrowser, createTestPage } from './browser/launcher.mjs';
import { OpenRouterClient } from './ai/openrouter.mjs';
import { loadDemoCases } from './demo.mjs';
import { AutomationController } from './automation/controller.mjs';
import { TP2_ENDPOINTS } from './core/tp2.mjs';
import { TestLabTracker, TestLabCatalog, isTestLabCatalog, defineComparison } from './core/testlab.mjs';
import { importDefine, defineTemplate } from './spec/define.mjs';
import { Tp2MappingStore, compareTp2Event, tp2Events, fieldPaths } from './core/tp2-compare.mjs';
import { exportSelection, normalizeSelection } from './report/selection.mjs';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const readWeb = name => fs.readFile(new URL(`./web/${name}`, import.meta.url), 'utf8');
// Each mode has its own screen; styling and client logic are shared assets.
const MODE_PAGES = { cdp: 'cdp.html', 'cdp-ai': 'cdp-ai.html' };
const ASSETS = { '/assets/eventqa.css': ['shared/eventqa.css', 'text/css; charset=utf-8'], '/assets/eventqa.js': ['shared/eventqa.js', 'text/javascript; charset=utf-8'],
  '/assets/automation.css': ['shared/automation.css', 'text/css; charset=utf-8'], '/assets/automation.js': ['shared/automation.js', 'text/javascript; charset=utf-8'],
  '/assets/inspection.css': ['shared/inspection.css', 'text/css; charset=utf-8'], '/assets/inspection.js': ['shared/inspection.js', 'text/javascript; charset=utf-8'] };
const PAGE_POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const escapeHtml = value => String(value).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]);
// Help page for the F12 capture snippet: copy it, run it in the target site's Console, bring the JSON back.
function capturePage(snippet) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EventQA · Bản ghi từ F12</title><style>
:root{color-scheme:light dark;--bg:#f1f4f8;--card:#fff;--text:#13283c;--muted:#5d7184;--line:#dfe5ec;--accent:#4b3fa8}
@media(prefers-color-scheme:dark){:root{--bg:#0e1620;--card:#15202c;--text:#e4ebf2;--muted:#9db0c2;--line:#263546;--accent:#a48bff}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px}h2{font-size:17px;margin-top:28px}
ol{padding-left:22px}li{margin:6px 0}
code{background:var(--line);padding:1px 5px;border-radius:4px}
textarea{width:100%;height:150px;box-sizing:border-box;margin-top:10px;font:12px/1.5 ui-monospace,Consolas,monospace;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);padding:10px}
button{margin-top:10px;padding:10px 16px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.note{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;padding:12px 14px;margin-top:16px;color:var(--muted)}
a{color:var(--accent)}
</style></head><body><main>
<h1>Bản ghi event từ F12</h1>
<p>Dùng khi trang cần kiểm chỉ mở được trên một máy/mạng nhất định (ví dụ UAT chặn theo IP). Bắt event ngay trong trình duyệt đã mở được trang, rồi mang file về EventQA để đối chiếu — không cần cài gì trên máy đó.</p>
<h2>Cách dùng (không cần cài gì)</h2>
<ol>
<li>Trên máy <b>vào được trang cần kiểm</b>, mở trang đó trong Chrome/Edge và đăng nhập như bình thường.</li>
<li>Nhấn <b>F12</b> → tab <b>Console</b>.</li>
<li>Bấm <b>Chép đoạn mã</b> bên dưới, dán vào Console, nhấn Enter. (Nếu Console báo chặn dán, gõ <code>allow pasting</code> rồi Enter, sau đó dán lại.) Một ô nhỏ “✦ EventQA · bản ghi” hiện ở góc phải.</li>
<li>Thao tác trên trang như kịch bản test. Ô nhỏ đếm số push/request bắt được.</li>
<li>Xong thì bấm <b>Dừng &amp; tải JSON</b>. Một file <code>eventqa-capture-….json</code> được tải về.</li>
</ol>
<button id="copy" type="button">Chép đoạn mã</button>
<textarea id="snippet" readonly spellcheck="false">${escapeHtml(snippet)}</textarea>

<div class="note"><b>Khi phải tải lại trang (F5) hoặc chuyển trang có tải lại:</b> bản ghi <b>không mất</b> — nó được giữ trong tab. Sau mỗi lần tải trang, chỉ cần <b>dán lại đoạn mã</b> một lần (Console nhớ lệnh cũ: bấm mũi tên ↑ rồi Enter) là ghi tiếp, số đếm cộng dồn. Đừng đóng tab giữa chừng. Làm xong cả kịch bản mới bấm Dừng &amp; tải.</div>
<p class="hint" style="color:var(--muted)">Mẹo: nhiều trang (như VP-OTA) chuyển trang trong cùng ứng dụng khi bạn <b>bấm link/nút</b> (không tải lại) — khi đó dán một lần là đủ cho cả luồng, không cần dán lại. Chỉ khi bạn tự F5 hoặc đăng nhập chuyển sang trang khác mới cần dán lại.</p>
<p class="hint" style="color:var(--muted)">Cài được tiện ích? Có bản tự chạy mọi lần tải trang: <a href="/capture.user.js">Tampermonkey userscript</a> (cài <a href="https://www.tampermonkey.net/" target="_blank" rel="noopener">Tampermonkey</a> rồi mở link này → Install).</p>

<h2>Nhập vào EventQA</h2>
<p>Về EventQA, bước <b>Website &amp; trình duyệt test</b> → mở <b>“Trang chặn theo IP (UAT…)? Nhập bản ghi từ F12”</b> → chọn file JSON vừa tải. Event hiện lên; nạp file đặc tả để đối chiếu và xuất báo cáo như một phiên bình thường.</p>
<div class="note">Đoạn mã chỉ <b>đọc</b> dataLayer/InsiderQueue và các request GA4/Insider/TP2 của trang, không gửi dữ liệu đi đâu và không sửa gì trên trang. Dừng lại là trả trang về như cũ. File JSON là bằng chứng của bạn; chỉ mở trên EventQA của bạn.</div>
<script>
document.getElementById('copy').addEventListener('click', async () => {
  const text = document.getElementById('snippet').value, button = document.getElementById('copy');
  try { await navigator.clipboard.writeText(text); button.textContent = 'Đã chép ✓'; }
  catch { const t = document.getElementById('snippet'); t.focus(); t.select(); button.textContent = document.execCommand('copy') ? 'Đã chép ✓' : 'Hãy bôi đen và Ctrl+C'; }
  setTimeout(() => { button.textContent = 'Chép đoạn mã'; }, 2500);
});
</script>
</main></body></html>`;
}
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

export async function createApp({ mode = 'cdp', runsDir = path.join(rootDir, 'runs'), port = 4173, aiClient, initialCases = 'demo', envPath = path.join(rootDir, '.env'), reviewedPath = reviewedSpecPath, automationDir, automationOptions = {} } = {}) {
  if (!['cdp', 'cdp-ai'].includes(mode)) throw new Error('Mode must be cdp or cdp-ai.');
  const csrf = randomBytes(24).toString('hex');
  // 'auto' (CLI) resumes reviewed rules or starts empty for a real site; tests keep the demo default.
  let specSource = 'demo', cases;
  if (Array.isArray(initialCases)) { cases = initialCases; specSource = initialCases.length ? 'file' : 'none'; }
  else if (initialCases === 'auto') {
    try { cases = JSON.parse(await fs.readFile(reviewedPath, 'utf8')).cases.map(validateTestCase); specSource = 'reviewed'; }
    catch { cases = []; specSource = 'none'; }
  } else cases = await loadDemoCases();
  const manager = new SessionManager({ mode, runsDir, cases });
  const tp2Mappings = new Tp2MappingStore(path.join(runsDir, '.settings', `tp2-${mode}.json`));
  await tp2Mappings.load();
  const apiBodyCache = new Map(), tp2ComparisonCache = new Map();
  function apiBody(id) {
    if (!apiBodyCache.has(id)) { apiBodyCache.set(id, manager.apiCall(id)); if (apiBodyCache.size > 30) apiBodyCache.delete(apiBodyCache.keys().next().value); }
    return apiBodyCache.get(id);
  }
  function tp2State({ id, apiId, mappingId, q = '', status: outcome = '', page = 0 } = {}) {
    const snapshot = manager.snapshot(), all = tp2Events(snapshot.events), mappings = tp2Mappings.list();
    const version = JSON.stringify([snapshot.session?.id, snapshot.events.length, snapshot.apiCalls.length, mappings]);
    const compare = event => {
      const key = `${version}|${event.evidence_id}|${apiId || ''}|${mappingId || ''}`;
      if (!tp2ComparisonCache.has(key)) { tp2ComparisonCache.set(key, compareTp2Event(event, snapshot.apiCalls, apiBody, mappings, { apiId, mappingId })); if (tp2ComparisonCache.size > 500) tp2ComparisonCache.delete(tp2ComparisonCache.keys().next().value); }
      return tp2ComparisonCache.get(key);
    };
    if (id) {
      const event = all.find(item => item.evidence_id === id); if (!event) return null;
      const comparison = compare(event), api = comparison.api ? apiBody(comparison.api.evidence_id) : apiId ? apiBody(apiId) : null;
      return { event, comparison, api, event_paths: fieldPaths(event.payload), api_paths: fieldPaths(api?.response?.body?.json ?? {}) };
    }
    const responses = new Map();
    for (const item of snapshot.events) if (item.network?.request_id && item.network.phase === 'response') responses.set(`${item.page?.target_id ?? ''}|${item.network.request_id}`, item.network.status);
    const rows = all.map(event => ({ ...compare(event), http_status: responses.get(`${event.page?.target_id ?? ''}|${event.network?.request_id}`) ?? event.network?.status }));
    const filtered = rows.filter(row => (!outcome || row.status === outcome) && (!q || `${row.event_name} ${row.schema} ${row.page?.url}`.toLowerCase().includes(q.toLowerCase()))).reverse();
    return { session_id: snapshot.session?.id, mappings, total: rows.length, matched: filtered.length, page, events: filtered.slice(page * 100, (page + 1) * 100),
      summary: Object.fromEntries([...new Set(rows.map(row => row.status))].map(status => [status, rows.filter(row => row.status === status).length])), apis: snapshot.apiCalls.slice(-500).reverse() };
  }
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
      else if ((isRequest(event) || event.layer === 'TEST_LAB') && eventKind(event) === 'business') {
        counts.sent++; kinds.add(`${event.source}|${links.pushOf.get(event.evidence_id)?.event_name ?? event.event_name}`);
      }
    }
    return { ...counts, kinds: kinds.size };
  };
  // Sent prices against the website's API prices (api-prices.mjs); recomputed only when either grows.
  let priceCache = { key: '', result: null };
  const prices = (events, api) => {
    const key = `${events.length}|${api.length}`;
    if (priceCache.key !== key) priceCache = { key, result: priceChecks(activityEntries(events, { links: deliveryLinks(events) }), api) };
    return priceCache.result;
  };
  // Event-to-specification matches, reset whenever the cases change.
  let coverageCases = null, coverageCache = new Map();
  const coverage = events => {
    if (!manager.cases.length) return null;
    if (coverageCases !== manager.cases) { coverageCases = manager.cases; coverageCache = new Map(); }
    return specCoverage(manager.cases, events, coverageCache, { links: deliveryLinks(events) });
  };
  const statuses = []; let collector = null, browserHandle = null, testPage = null, exported = null, mutating = false;
  let closing = false, closePromise = null, stoppingSession = null, captureEpoch = 0, asking = false;
  let reportNotesCache = null, reportNotesController = null, reportExportTask = null, reportWriteTask = null, reportExportEpoch = 0;
  const status = message => { statuses.push({ at: new Date().toISOString(), message: redact(String(message && typeof message === 'object' ? message.message ?? JSON.stringify(message) : message)) }); if (statuses.length > 40) statuses.shift(); };
  let ai = aiClient ?? new OpenRouterClient();
  const state = ({ compact = false } = {}) => {
    const snapshot = manager.snapshot();
    return { application: 'event-tracking-qa', mode, process_id: process.pid, closing, ai: mode === 'cdp-ai' ? ai.diagnostics?.() : undefined, running: manager.session?.status === 'RUNNING', session: manager.session || null,
      specSource, navigationError, patterns: activePatterns, vendors: VENDOR_ENDPOINTS, discovered: collector?.discovered ? [...collector.discovered.values()].sort((a, b) => b.count - a.count) : [],
      eventSummary: summarize(snapshot.events, deliveryLinks(snapshot.events)), delivery: deliveryCounts(snapshot.events), prices: prices(snapshot.events, snapshot.api).summary, apiCalls: { total: snapshot.apiCalls.length, failed: snapshot.apiCalls.filter(call => !call.ok).length, default_patterns: DEFAULT_API_LOG_PATTERNS }, specCoverage: coverage(snapshot.events), firing: firingState(snapshot.events), currentStep: manager.currentStep, stepEventCount: manager.currentStep ? snapshot.events.filter(event => event.step_id === manager.currentStep.id).length : 0, runDir: manager.runDir || null, cases: manager.cases, results: snapshot.results, steps: manager.steps,
      events: snapshot.events.slice(-100).map(e => compact ? { evidence_id: e.evidence_id, source: e.source, layer: e.layer, event_name: e.event_name, captured_at: e.captured_at, historical: e.historical, page: e.page, network: e.network, step_id: e.step_id, test_case_id: e.test_case_id,
        ...(e.testlab ? { testlab: { status: e.testlab.status, receipt: e.testlab.receipt }, capture: e.capture } : {}) } : e), eventsCompact: compact, eventCount: snapshot.events.length, eventRevision, statuses, exported: exported ? Object.fromEntries(Object.entries(exported).map(([k, p]) => [k, `/download/${path.basename(p)}`])) : null };
  };
  // One captured event with the specification row it matched (field-by-field outcome), its firing
  // checks, and its delivery: the website push, the vendor hit that sent it, and for GA4 the pushed
  // fields Google did not receive.
  function eventDetail(id) {
    const snapshot = manager.snapshot(), events = snapshot.events;
    const event = events.find(candidate => candidate.evidence_id === id);
    if (!event) return null;
    const links = deliveryLinks(events);
    const match = manager.cases.length ? matchTracked(manager.cases, event, { links }) : null;
    const testCase = match && manager.cases.find(c => c.id === match.case_id);
    const spec = match ? { ...match, event_name: testCase?.rules?.[0]?.event_name, stt: testCase?.stt ?? '', flow: testCase?.flow ?? '', description: testCase?.description ?? '', notes: testCase?.notes ?? '', provenance: testCase?.provenance, sample: testCase?.sample, sample_text: testCase?.sample_text } : null;
    const push = event.layer === 'JS_QUEUE' ? event : links.pushOf.get(event.evidence_id) ?? null;
    const hit = event.layer === 'TRACKING_REQUEST' ? event : links.sentBy.get(event.evidence_id) ?? null;
    // The specification's sample beside the event, field by field (website events; an app event has its define comparison).
    if (spec && testCase?.sample && typeof testCase.sample === 'object' && event.layer !== 'TEST_LAB') {
      const diff = payloadDiff(testCase.sample, comparedView(comparedRecord(testCase.sample, { event, push, hit }), testCase.sample), { fields: testCase.rules?.[0]?.fields ?? {}, issues: match.issues });
      spec.diff = { rows: diff.rows, sentences: diffSentences(diff) };
    }
    const delivery = { status: deliveryStatus(push ?? event, links), push, hit, not_forwarded: push && hit?.source === 'GA4' ? notForwarded(push, hit) : [] };
    const activity = activityEntries(events, { links }).find(row => row.evidence_ids.includes(event.evidence_id)) ?? activityEvent(event);
    const priced = prices(events, snapshot.api).checks.filter(check => check.evidence_id === activity.evidence_id);
    // An app event from Test Lab beside the define row of its event, parameter by parameter.
    const define = event.layer === 'TEST_LAB' ? defineComparison(event, testCase) : null;
    return { event, spec, firing: firingResult(events).byEvent.get(event.evidence_id) ?? [], delivery, activity, prices: priced, define,
      ...(event.layer === 'TEST_LAB' ? { define_loaded: manager.cases.some(item => item.provenance?.define) } : {}) };
  }
  // What the AI reads to review a session: the QC's requirement, the specification rows the session is
  // about (rows with evidence and the unseen rows of the same flows), the tool's verdict per row, what
  // reached Google/Insider, pushes never sent, events outside the specification and firing problems.
  function sessionReviewInput(events, requirement) {
    const links = deliveryLinks(events), now = Date.now();
    const rows = activityEntries(events, { links, now }).filter(row => row.event_kind === 'business');
    const covered = coverage(events);
    const relevant = covered ? sessionRows(covered).slice(0, 80) : [];
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
      // Prices sent that differ from the website's API for the same product.
      price_mismatches: prices(events, manager.snapshot().api).checks.filter(check => check.status === 'MISMATCH').slice(-30).map(check => ({ at: check.at.slice(11, 19), vendor: check.source, event: check.event,
        field: check.field, sent: check.sent, api: check.api?.value, api_field: check.api?.path, ...(check.stale ? { matches_older_api: true } : {}) })),
    };
  }
  // What the AI reads to answer a QC question about the session: the review input (specification, the
  // tool's verdicts, what was sent, problems) plus the parameters actually sent by the events the question
  // names (otherwise the latest ones), so it can judge values, conflicts and errors. Kept under ~90 KB.
  // A question asked from one event's detail (evidenceId) is about that event: it is the focus, with the
  // events around it to compare against; otherwise the events the question names, or the latest ones.
  function sessionAskInput(events, question, history, { evidenceId } = {}) {
    const { requirement: _unused, ...review } = sessionReviewInput(events, null);
    const links = deliveryLinks(events);
    const rows = activityEntries(events, { links }).filter(row => row.event_kind === 'business');
    const where = url => { try { const parsed = new URL(url); return parsed.pathname + parsed.search.slice(0, 80); } catch { return ''; } };
    const clip = (value, max) => {
      if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
      const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
      return text.length > max ? `${text.slice(0, max)}…` : text;
    };
    const params = json => {
      const all = { ...(json?.default_parameters ?? {}), ...(json?.custom_parameters ?? {}) }, out = {};
      for (const [key, value] of Object.entries(all).slice(0, 40)) {
        if (key === 'items' && Array.isArray(value)) {
          out.items = value.slice(0, 4).map(item => item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).slice(0, 20).map(([k, v]) => [k, clip(v, 80)])) : clip(item, 80));
          if (value.length > 4) out.items_total = value.length;
        } else out[key] = clip(value, 160);
      }
      return out;
    };
    // Event names the question mentions, as whole names (page_view is not named by "listing_page_view").
    const lower = question.toLowerCase(), literal = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const names = [...new Set(rows.flatMap(row => [row.display_name, row.event_name]).filter(name => typeof name === 'string' && name.length > 2))];
    const named = names.filter(name => new RegExp(`(?:^|[^\\p{L}\\p{N}_])${literal(name.toLowerCase())}(?:[^\\p{L}\\p{N}_]|$)`, 'u').test(lower));
    const asked = evidenceId ? rows.find(row => row.evidence_ids.includes(evidenceId) || row.sent_by === evidenceId) : null;
    if (evidenceId && !asked) throw new Error('Không tìm thấy event này trong phiên hiện tại.');
    let focus = asked ? [asked] : named.length ? rows.filter(row => named.includes(row.display_name) || named.includes(row.event_name)).slice(-30) : rows.slice(-40);
    // Events around the ones asked about (±15 s, both vendors) come along marked `nearby`: the same user
    // action seen by the other vendor, and the steps before/after, are what conflicts are judged against.
    const time = row => Date.parse(row.sent_at ?? row.captured_at);
    let nearby = [];
    if (asked || named.length) {
      const chosen = new Set(focus), times = focus.map(time);
      nearby = rows.filter(row => !chosen.has(row) && times.some(at => Math.abs(time(row) - at) <= 15000)).slice(-20);
    }
    // An app event read from Insider's Test Lab: its status there and the parameters Insider marked failed.
    const byId = new Map(events.map(event => [event.evidence_id, event]));
    const testlab = row => { const t = byId.get(row.evidence_id)?.testlab; return t ? { testlab: { status: t.status, read_whole: t.complete,
      failed: (t.params ?? []).filter(p => p.status === 'failed').map(p => ({ field: p.field ?? p.key, value: p.value, ...Object.values(p.failed_detail ?? {}).find(d => d?.expected_type) })) } } : {}; };
    const detail = row => ({ id: row.evidence_id, at: row.captured_at.slice(11, 19), vendor: row.source, event: row.display_name,
      ...(row.display_name !== row.event_name ? { raw_event: row.event_name } : {}), delivery: row.delivery, page: where(row.page?.url),
      ...(row.measurement_id ? { ga4_property: row.measurement_id } : {}),
      ...(row.repeat ? { repeat_of: row.repeat.evidence_id, repeat_after_s: Number((row.repeat.after_ms / 1000).toFixed(1)) } : {}), params: params(row.json), ...testlab(row) });
    const counts = new Map();
    for (const row of rows) {
      const key = `${row.source}|${row.display_name}`, count = counts.get(key) ?? { vendor: row.source, event: row.display_name, sent: 0, not_sent: 0 };
      if (row.delivery === 'sent') count.sent++; else if (row.delivery === 'not_sent') count.not_sent++;
      counts.set(key, count);
    }
    const past = (Array.isArray(history) ? history : []).slice(-3)
      .map(turn => ({ question: String(turn?.question ?? '').slice(0, 500), answer: String(turn?.answer ?? '').slice(0, 1500) })).filter(turn => turn.question);
    const details = () => [...focus.map(detail), ...nearby.map(row => ({ ...detail(row), nearby: true }))].sort((a, b) => a.at.localeCompare(b.at));
    const focusedOn = asked ? { this_event: asked.display_name, evidence_id: asked.evidence_id } : named.length ? named : 'latest_events';
    const build = () => ({ question, history: past, focused_on: focusedOn, event_counts: [...counts.values()].slice(0, 80), event_details: details(), ...review });
    let input = build();
    while (JSON.stringify(input).length > 90000 && (nearby.length || focus.length > 5)) {
      if (nearby.length) nearby = nearby.slice(Math.ceil(nearby.length / 2)); else focus = focus.slice(Math.ceil(focus.length / 4));
      input = build();
    }
    return input;
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
  // AI version: the comment column of the report sheet is written by AI from the tool's verdicts, 20 rows per
  // request and at most 100 rows; rows it does not answer keep the tool's comment.
  async function aiReportNotes(snapshot, report, signal) {
    const client = ai;
    const diagnostics = mode === 'cdp-ai' ? client.diagnostics?.() : null;
    if (!diagnostics?.enabled || !diagnostics.configured_key_count || diagnostics.closed) return null;
    const clip = value => { const text = typeof value === 'string' ? value : JSON.stringify(value); return text && text.length > 120 ? `${text.slice(0, 120)}…` : text; };
    // Rows with a problem first: the AI comments on at most 100 rows of a long session.
    const order = { MISMATCH: 0, NOT_SENT: 1, REVIEW: 2, UNCHECKED: 3, OUTSIDE: 4, PENDING: 5, NOT_SEEN: 6, MATCH: 7, SENT: 8 };
    const rows = [...report].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.stt - b.stt).slice(0, 100), notes = {};
    const input = rows.map(row => ({ id: row.id, event: row.event_name, flow: row.flow, platform: row.platform, status: row.status, expected_fields: row.expected_fields.slice(0, 30),
      issues: row.issues.slice(0, 8).map(issue => ({ code: issue.code, field: issue.path, expected: clip(issue.expected), actual: clip(issue.actual) })), times_sent: row.seen, not_sent: row.not_sent, price_mismatches: row.price_mismatches.slice(0, 3) }));
    const key = JSON.stringify({ session: snapshot.session?.id ?? snapshot.session?.session_id, keys: rows.map(row => row.key), rows: input });
    if (reportNotesCache?.client === client && reportNotesCache.key === key) return reportNotesCache.value;
    let model, complete = true;
    // Keep at most two requests in flight, while preserving the existing 20-row/100-row limits.
    for (let start = 0; start < rows.length; start += 40) {
      if (signal.aborted) return null;
      const starts = [start, start + 20].filter(index => index < rows.length);
      const results = await Promise.all(starts.map(async index => {
        try { return await client.reportNotes(input.slice(index, index + 20)); }
        catch { return { available: false, reason: 'AI_UNAVAILABLE' }; }
      }));
      if (signal.aborted) return null;
      for (let index = 0; index < starts.length; index++) {
        const result = results[index], batch = rows.slice(starts[index], starts[index] + 20);
        if (!result.available) { complete = false; status(`AI chưa viết được nhận xét báo cáo (${result.reason}); các dòng còn lại giữ nhận xét của công cụ.`); continue; }
        model ??= result.routing?.model;
        for (const row of batch) if (result.notes.get(row.id)) notes[row.key] = result.notes.get(row.id);
      }
      if (!complete) break;
    }
    const value = Object.keys(notes).length ? { by: 'AI', model, notes } : null;
    // An unavailable or cancelled request can be retried on the next export.
    if (complete && value) reportNotesCache = { client, key, value };
    return value;
  }
  async function exportWithNotes(snapshot, { aiNotes = true, selection } = {}) {
    if (selection) selection = normalizeSelection(selection);
    const epoch = captureEpoch, exportEpoch = reportExportEpoch, controller = new AbortController();
    const pending = (async () => {
      const prepared = !selection || selection.contents.includes('events') || selection.contents.includes('insider') ? prepareReportData(snapshot) : null;
      reportNotesController = controller;
      let onAbort;
      const cancelled = new Promise(resolve => { onAbort = () => resolve(null); controller.signal.addEventListener('abort', onAbort, { once: true }); });
      let reportNotes;
      try { reportNotes = aiNotes && prepared ? await bounded(Promise.race([aiReportNotes(snapshot, prepared.report, controller.signal), cancelled]), 150000).catch(() => null) : null; }
      finally {
        controller.signal.removeEventListener('abort', onAbort);
        controller.abort();
        if (reportNotesController === controller) reportNotesController = null;
      }
      // A stopped live export must not overwrite the final report with its earlier snapshot.
      if (epoch !== captureEpoch || exportEpoch !== reportExportEpoch) return null;
      await writeReports({ ...snapshot, api_calls: manager.apiCallRecords(), ...(reportNotes ? { report_notes: reportNotes } : {}) }, { prepared, selection });
      return reportNotes;
    })();
    reportExportTask = pending;
    try { return await pending; }
    finally { if (reportExportTask === pending) reportExportTask = null; }
  }
  async function writeReports(snapshot, options) {
    const previous = reportWriteTask, outputDir = manager.runDir;
    const pending = (async () => {
      // Stop can bypass an active export request; finish writing that snapshot before the final one.
      if (previous) await previous.catch(() => {});
      const files = options?.selection ? await exportSelection(snapshot, outputDir, options.selection, { prepared: options.prepared, tp2Mappings: tp2Mappings.list() }) : await exportReports(snapshot, outputDir, options);
      const workflowResults = path.join(outputDir, 'workflow-results.json');
      if ((!options?.selection || options.selection.contents.includes('events')) && await fs.stat(workflowResults).then(stat => stat.isFile()).catch(() => false)) files.automation = workflowResults;
      exported = files;
      return files;
    })();
    reportWriteTask = pending;
    try { return await pending; }
    finally { if (reportWriteTask === pending) reportWriteTask = null; }
  }
  async function bounded(promise, milliseconds) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cleanup deadline exceeded')), milliseconds); })]); }
    finally { clearTimeout(timer); }
  }
  async function stopCapture() {
    collector?.flushApiLog?.();
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
      // The previous session's test page loads the new website instead of another window opening.
      return { reused: true, targetId: testPage = await createTestPage({ port: options.port, headless: options.headless, reuse: testPage ?? undefined }) };
    }
    try {
      browserHandle = await launchBrowser({ ...options, url: 'about:blank' });
      // The website loads in the blank page the browser starts with: one window, one tab.
      return { reused: false, targetId: testPage = await createTestPage({ port: options.port, headless: options.headless, reuse: 'startup' }) };
    }
    catch (error) {
      if (/exited before the debug endpoint was ready (code 21)/.test(error.message)) throw new Error('Cửa sổ trình duyệt test cũ vẫn đang mở với profile này nhưng không còn kết nối được. Đóng hết cửa sổ Chrome/Edge test rồi bấm lại.');
      throw error;
    }
  }
  // Insider's panel opened in the test browser (testlab.mjs): each Test Lab event becomes one event of the
  // session, completed by later readings (session.revise). The panel's own calls, WebSocket frames,
  // Console and table markup are kept in the run folder (insider-panel/), so the reader can be checked
  // against what the panel really loads; its Test Lab catalogue gives event keys and parameter types.
  const PANEL_LIMITS = { network: 3000, websocket: 5000, event_source: 3000, console: 3000, readings: 2000, reader: 200, html: 40 };
  let testLab = new TestLabTracker(), testLabCatalog = new TestLabCatalog(), testLabRefs = new Map(), panelLog = { counts: {}, announced: false, hintAt: 0 };
  // Evidence that changed in place: every view derived from the evidence is recomputed.
  let eventRevision = 0;
  const evidenceRevised = () => {
    eventRevision++;
    firingCache = { count: -1, result: null }; linkCache = { count: -1, links: null }; priceCache = { key: '', result: null }; coverageCache = new Map();
  };
  function insiderPanel(record) {
    if (!manager.runDir || manager.session?.status !== 'RUNNING') return;
    const dir = path.join(manager.runDir, 'insider-panel');
    const within = kind => (panelLog.counts[kind] = (panelLog.counts[kind] ?? 0) + 1) <= PANEL_LIMITS[kind];
    const saveHtml = name => { if (record.html && within('html')) writeFileSync(path.join(dir, `${name}-${String(panelLog.counts.html).padStart(3, '0')}.html`), String(redact(String(record.html)))); };
    const log = (file, value) => appendFileSync(path.join(dir, file), `${JSON.stringify(value)}\n`);
    try {
      mkdirSync(dir, { recursive: true });
      if (record.kind === 'table') {
        const groups = Array.isArray(record.groups) ? record.groups : [];
        saveHtml('test-results');
        if (within('readings')) log('test-results.jsonl', redact({ at: record.at, url: record.url, reader: record.reader, groups }));
        if (record.model !== undefined && within('reader')) log('reader.jsonl', redact({ at: record.at, reader: record.reader, model: record.model }));
        const ops = testLab.update(record, { url: record.url, title: record.title, targetId: record.target_id, at: record.at }, testLabCatalog);
        let fresh = 0, revised = false;
        for (const { ref, op, event } of ops) {
          if (op === 'new') { const stored = manager.emit(event); if (stored) testLabRefs.set(ref, stored.evidence_id); if (!event.historical) fresh++; }
          else if (manager.revise(testLabRefs.get(ref), event)) revised = true;
        }
        if (revised) evidenceRevised();
        const whole = record.reader === 'ag-grid-model';
        if (!panelLog.announced) {
          panelLog.announced = true;
          status(`Đang đọc Insider Test Lab (${whole ? 'đọc đủ mọi dòng của bảng' : 'đọc các dòng đang hiện trên bảng'}): ${groups.filter(group => group.name).length} event. Event mới từ app hiện ở tab Event với tầng "Test Lab".`);
        } else if (fresh) status(`Insider Test Lab: thêm ${fresh} event mới.`);
        // Rows ag-Grid has not drawn cannot be read from the page: say how to bring them into view.
        if (!whole && Date.now() - panelLog.hintAt > 60000 && groups.some(group => group.name && !group.complete)) {
          panelLog.hintAt = Date.now();
          status('Insider Test Lab: có event chưa đọc đủ tham số (đang thu gọn hoặc nằm ngoài phần bảng đang hiện). Mở rộng (▸) và cuộn tới event đó trong Test Lab để EventQA đọc nốt; event đó tạm ở trạng thái Cần xem.');
        }
        return;
      }
      if (record.kind === 'missing') {
        saveHtml('page');
        status('Đang ở trang Test Lab của Insider nhưng chưa nhận ra bảng Test Results. Đã lưu HTML trang vào thư mục phiên (insider-panel/) để chỉnh bộ đọc.');
        return;
      }
      if (record.kind === 'network' && isTestLabCatalog(record.url) && record.response_body) {
        try { testLabCatalog.add(JSON.parse(record.response_body)); } catch { /* a cut or non-JSON page of the catalogue */ }
      }
      const kind = record.kind === 'error' ? 'console' : record.kind;
      if (!Object.hasOwn(PANEL_LIMITS, kind) || ['readings', 'reader', 'html'].includes(kind) || !within(kind)) return;
      log(`${kind}.jsonl`, record.kind === 'error' ? { ...record, level: 'testlab-reader-error' } : record);
    } catch (error) { status(`Không ghi được dữ liệu panel Insider: ${error.message}`); }
  }
  async function startCapture(data, { navigate = true, profileDir } = {}) {
    if (manager.session?.status === 'RUNNING') throw new Error('Đã có phiên đang chạy.');
    const rawUrl = String(data.url || `http://127.0.0.1:${port}/demo`).trim();
    let targetUrl;
    try { targetUrl = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`); }
    catch { throw new Error('URL chưa hợp lệ. Ví dụ: www.website.vn hoặc https://www.website.vn/'); }
    if (!['http:', 'https:'].includes(targetUrl.protocol)) throw new Error('URL cần dùng http hoặc https.');
    const browser = data.browser === 'edge' ? 'edge' : 'chrome';
    const debugPort = Number(data.debugPort || ({ cdp: 9222, 'cdp-ai': 9223 }[mode]));
    const endpointPatterns = Array.isArray(data.endpointPatterns) ? data.endpointPatterns.filter(pattern => typeof pattern === 'string' && pattern.length < 500) : [...DEFAULT_ENDPOINT_PATTERNS];
    for (const pattern of TP2_ENDPOINTS) if (!endpointPatterns.includes(pattern)) endpointPatterns.push(pattern);
    if (targetUrl.hostname === '127.0.0.1' && targetUrl.pathname === '/demo') endpointPatterns.push('/demo/g/collect', '/demo/insider/events');
    activePatterns = endpointPatterns;
    navigationError = null;
    if (!['127.0.0.1', 'localhost'].includes(targetUrl.hostname)) {
      try { await dns.lookup(targetUrl.hostname); }
      catch (error) { navigationError = navigationHint(targetUrl.hostname, error.code || 'ENOTFOUND'); }
    }
    const captureQueues = data.captureQueues !== false, compareApi = data.compareApi !== false, logApi = data.logApi !== false;
    const logPatterns = logApi ? apiLogPatterns(data.apiLogPatterns) : [];
    if (logApi && targetUrl.hostname === '127.0.0.1' && targetUrl.pathname === '/demo') logPatterns.push('/demo/api/');
    manager.start({ browser, environment: targetUrl.origin, target_url: targetUrl.toString(), capture_queues: captureQueues, compare_api: compareApi, api_log: logApi, api_log_patterns: logPatterns }); exported = null;
    apiBodyCache.clear(); tp2ComparisonCache.clear();
    firingCache = { count: -1, result: null }; linkCache = { count: -1, links: null }; priceCache = { key: '', result: null }; coverageCases = null; coverageCache.clear();
    const epoch = ++captureEpoch, emit = event => epoch === captureEpoch ? manager.emit(event) : null;
    testLab = new TestLabTracker(); testLabCatalog = new TestLabCatalog(); testLabRefs = new Map(); panelLog = { counts: {}, announced: false, hintAt: 0 };
    try {
      const opened = !data.attach ? await openTestBrowser({ browser, port: debugPort, headless, url: 'about:blank', profileDir: profileDir ?? path.join(rootDir, 'profiles', `${mode}-${browser}`) }) : null;
      if (closing || epoch !== captureEpoch) { await releaseBrowser(); throw new Error('Phiên đã dừng trước khi mở trình duyệt.'); }
      collector = new CDPCollector({ port: debugPort, targetId: data.targetId || undefined, onEvent: emit, onStatus: status, endpointPatterns, captureQueues,
        onInsiderPanel: record => epoch === captureEpoch ? insiderPanel(record) : null,
        onApi: compareApi ? record => epoch === captureEpoch ? manager.emitApi(record) : null : undefined,
        ...(logApi ? { apiLogPatterns: logPatterns, onApiCall: record => epoch === captureEpoch ? manager.emitApiCall(record) : null } : {}) });
      await collector.start(manager.session);
      if (!data.attach && navigate) {
        const page = collector.connections.get(opened.targetId);
        if (!page) throw new Error('Không kết nối được tab test vừa mở.');
        const { frameTree } = await page.connection.send('Page.getFrameTree');
        const navigation = await page.connection.send('Page.navigate', { url: targetUrl.toString(), frameId: frameTree.frame.id });
        if (navigation.errorText) navigationError = navigationHint(targetUrl.hostname, navigation.errorText);
      }
      status(navigationError || 'Collector đã sẵn sàng. Chọn test case và bắt đầu bước trước khi thao tác.');
      if (!captureQueues) status('Đang chỉ bắt request: không gắn hook JavaScript vào website. Tầng JS queue không được quan sát.');
      if (closing || epoch !== captureEpoch) { await stopCapture(); await releaseBrowser(); throw new Error('Phiên đã dừng.'); }
      return { port: debugPort, targetId: opened?.targetId ?? data.targetId };
    } catch (error) { await stopCapture(); manager.abort(); throw error; }
  }
  async function releaseBrowser() {
    const current = browserHandle; browserHandle = null;
    if (!current) return;
    try { await bounded(closeOwnedBrowser(current), 2000); }
    catch { status('Đã ngừng thu thập; có thể đóng cửa sổ trình duyệt test còn lại.'); }
  }
  // keepBrowser: the test window stays open (AI exploration ends where the user can
  // see the page and keep the login); the next session reuses that window.
  async function stopSession({ exportReport = true, keepBrowser = false } = {}) {
    if (reportNotesController) {
      reportNotesController.abort(); ai.close?.();
      if (!closing && !aiClient) ai = new OpenRouterClient();
    }
    if (stoppingSession) return stoppingSession;
    if (!manager.session || manager.session.status !== 'RUNNING') return { snapshot: manager.snapshot(), files: exported, interrupted: manager.session?.status === 'INTERRUPTED' };
    const pending = (async () => {
      // Cancel remote work immediately; shutdown never waits for AI routing/retries. API calls still open are
      // logged first, while this capture's records are still accepted.
      collector?.flushApiLog?.();
      captureEpoch++;
      ai.close?.();
      if (!closing && !aiClient) ai = new OpenRouterClient();
      await stopCapture();
      const interrupted = Boolean(manager.currentStep);
      if (interrupted) manager.abort(); else manager.finish();
      const snapshot = manager.snapshot();
      if (exportReport) {
        try { await writeReports({ ...snapshot, api_calls: manager.apiCallRecords() }); }
        catch (error) { status(`Bằng chứng đã lưu; xuất báo cáo gặp lỗi: ${error.message}`); }
      }
      if (!keepBrowser) await releaseBrowser();
      status(interrupted ? 'Đã dừng phiên; bước đang làm được giữ REVIEW.' : exportReport ? 'Đã kết thúc và lưu báo cáo.' : `Đã kết thúc phiên; bằng chứng đã lưu.${keepBrowser ? ' Cửa sổ trình duyệt test vẫn mở.' : ''}`);
      return { snapshot, files: exported, interrupted };
    })();
    stoppingSession = pending;
    try { return await pending; }
    finally { if (stoppingSession === pending) stoppingSession = null; }
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    reportNotesController?.abort();
    ai.close?.();
    closePromise = (async () => {
      try { await automation?.close(); await stopSession(); }
      finally {
        if (reportExportTask) await bounded(reportExportTask, 5000).catch(() => {});
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
  async function body(req, maxBytes = 5 * 1024 * 1024) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new Error(`Request vượt ${Math.round(maxBytes / (1024 * 1024))} MB.`); chunks.push(chunk); }
    const raw = Buffer.concat(chunks).toString('utf8'); return raw ? JSON.parse(raw) : {};
  }
  // Replays a browser capture (src/web/capture.js) into a fresh session: queue pushes decode with the
  // same queueEvents() the live collector uses, requests with the same decodeRequest(); events replay in
  // time order so repeat detection and the timeline match a real run.
  function importCapture(capture) {
    if (!capture || typeof capture !== 'object' || capture.app !== 'eventqa-capture') throw new Error('File không phải bản ghi EventQA từ F12 (thiếu app: "eventqa-capture").');
    const pushes = Array.isArray(capture.pushes) ? capture.pushes : [];
    const requests = Array.isArray(capture.requests) ? capture.requests : [];
    if (pushes.length + requests.length === 0) throw new Error('Bản ghi rỗng: không có push hay request nào.');
    if (pushes.length + requests.length > 60000) throw new Error('Bản ghi quá lớn (trên 60.000 mục).');
    const events = [];
    for (const record of pushes) {
      if (!record || typeof record !== 'object' || typeof record.queue !== 'string') continue;
      try { for (const event of queueEvents(record)) events.push(event); } catch { /* skip a malformed push */ }
    }
    for (const request of requests) {
      if (!request || typeof request !== 'object' || typeof request.url !== 'string') continue;
      try {
        for (const event of decodeRequest({ url: request.url, body: typeof request.body === 'string' ? request.body : '', contentType: request.content_type || '',
          method: request.method || 'POST', requestId: `IMP-${events.length}`, capturedAt: request.ts ? new Date(request.ts).toISOString() : undefined, pageUrl: request.page_url })) events.push(event);
      } catch { /* skip a malformed request */ }
    }
    if (!events.length) throw new Error('Không giải mã được event nào từ bản ghi.');
    events.sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at));
    manager.start({ environment: 'IMPORTED_CAPTURE', source: 'f12_capture', imported_at: new Date().toISOString(), captured_page: capture.page?.url ?? null });
    for (const event of events) manager.emit(event);
    return events.length;
  }
  const automation = mode === 'cdp-ai' ? new AutomationController({ directory: automationDir ?? path.join(runsDir, '.automation'), manager,
    getAi: () => ai, onStatus: status, isAvailable: () => !mutating && !closing && !stoppingSession,
    capture: automationOptions.capture ?? (workflow => startCapture({ url: workflow.url, browser: workflow.browser,
      debugPort: automationOptions.debugPort ?? (workflow.browser === 'edge' ? 9225 : 9223) }, { navigate: false, profileDir: automationOptions.profileDir })),
    openInspection: async ({ browser }) => {
      const debugPort = automationOptions.debugPort ?? (browser === 'edge' ? 9225 : 9223);
      const opened = await openTestBrowser({ browser, port: debugPort, headless, url: 'about:blank', profileDir: automationOptions.profileDir ?? path.join(rootDir, 'profiles', `${mode}-${browser}`) });
      return { port: debugPort, targetId: opened.targetId };
    },
    finish: options => stopSession({ exportReport: false, keepBrowser: options?.keepBrowser === true }),
    exportReport: async options => { await exportWithNotes(manager.snapshot(), options); return Object.fromEntries(Object.entries(exported ?? {}).map(([key, file]) => [key, `/download/${path.basename(file)}`])); },
    ...(automationOptions.connectDriver ? { connectDriver: automationOptions.connectDriver } : {}),
    ...(automationOptions.listTargets ? { listTargets: automationOptions.listTargets } : {}),
    ...(automationOptions.now ? { now: automationOptions.now } : {}), ...(automationOptions.intervalMs ? { intervalMs: automationOptions.intervalMs } : {}) }) : null;
  await automation?.load();
  const server = http.createServer(async (req, res) => {
    try {
      const addresses = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!addresses.has(req.headers.host)) return send(res, 403, { error: 'Localhost Host header required.' });
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, (await readWeb(MODE_PAGES[mode])).replace('__INSPECTION__', await readWeb('shared/inspection.html')).replaceAll('__CSRF__', csrf), 'text/html; charset=utf-8', { 'Content-Security-Policy': PAGE_POLICY });
      if (req.method === 'GET' && ASSETS[url.pathname]) return send(res, 200, await readWeb(ASSETS[url.pathname][0]), ASSETS[url.pathname][1]);
      // The browser-capture snippet and a page explaining how to use it (for testing a site that only a
      // whitelisted machine can open): run the snippet there, bring the JSON back here to import.
      if (req.method === 'GET' && url.pathname === '/capture.js') return send(res, 200, await readWeb('capture.js'), 'text/javascript; charset=utf-8');
      // Tampermonkey userscript: same capture, but it runs on every page load and keeps the record across
      // reloads/navigations, so a multi-page flow (with logins or F5) ends in one file. Edit @match for
      // another site. Tampermonkey offers to install when a .user.js URL is opened.
      if (req.method === 'GET' && url.pathname === '/capture.user.js') {
        const header = ['// ==UserScript==', '// @name         EventQA · Bản ghi event', '// @namespace    eventqa', '// @version      1.0',
          '// @description  Ghi dataLayer/InsiderQueue + request GA4/Insider/TP2 qua các lần tải trang, để nhập vào EventQA',
          '// @match        https://*.vinpearlota.com/*', '// @match        https://vinpearlota.com/*', '// @run-at       document-start', '// @grant        none', '// ==/UserScript==', ''].join('\n');
        return send(res, 200, `${header}window.__eventqaCapturePersist = true;\n${await readWeb('capture.js')}`, 'text/javascript; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/capture') {
        const snippet = await readWeb('capture.js');
        return send(res, 200, capturePage(snippet), 'text/html; charset=utf-8', { 'Content-Security-Policy': PAGE_POLICY });
      }
      if (req.method === 'GET' && url.pathname === '/demo') return send(res, 200, await readWeb('demo.html'), 'text/html; charset=utf-8');
      // The demo product API whose price the demo page's tracking is checked against.
      if (req.method === 'GET' && url.pathname.startsWith('/demo/api/products/')) return send(res, 200, { data: { id: decodeURIComponent(url.pathname.slice('/demo/api/products/'.length)), name: 'Phòng Deluxe hướng biển', currency: 'VND', price: 1000000, originalPrice: 1200000 } });
      if (req.method === 'POST' && ['/demo/g/collect', '/demo/insider/events', '/demo/tp2'].includes(url.pathname)) {
        await bodyForDiscard(req); res.writeHead(204); return res.end();
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, state({ compact: url.searchParams.get('compact') === '1' }));
      if (req.method === 'GET' && url.pathname === '/api/tp2') return send(res, 200, tp2State({ q: (url.searchParams.get('q') || '').slice(0, 200), status: url.searchParams.get('status') || '', page: Math.max(0, Math.min(10000, Number(url.searchParams.get('page')) || 0)) }));
      if (req.method === 'GET' && url.pathname === '/api/tp2/detail') {
        if (!url.searchParams.get('id')) return send(res, 400, { error: 'Chọn một event TP2 để xem chi tiết.' });
        const detail = tp2State({ id: url.searchParams.get('id'), apiId: url.searchParams.get('api_id'), mappingId: url.searchParams.get('mapping_id') });
        return detail ? send(res, 200, detail) : send(res, 404, { error: 'Không tìm thấy event TP2.' });
      }
      if (req.method === 'GET' && url.pathname === '/api/automation/state') return automation
        ? send(res, 200, automation.state()) : send(res, 404, { error: 'Luồng tự động có trong bản AI.' });
      if (req.method === 'GET' && url.pathname === '/api/activity') {
        const snapshot = manager.snapshot(), events = snapshot.events;
        const entries = activityEntries(events, { links: deliveryLinks(events) });
        // Each row shows its prices: the value sent and the value the website API gave for the product.
        const priced = new Map();
        for (const check of prices(events, snapshot.api).checks) priced.set(check.evidence_id, [...priced.get(check.evidence_id) ?? [], { field: check.field, sent: check.sent, api: check.api?.value ?? null, times: check.api?.times, status: check.status }]);
        const before = url.searchParams.get('before');
        const end = before ? entries.findIndex(e => e.evidence_ids.includes(before)) : entries.length;
        if (end < 0) return send(res, 400, { error: 'Mốc event không thuộc phiên hiện tại.' });
        const start = Math.max(0, end - 100);
        const page = entries.slice(start, end).reverse().map(activity => ({ ...(url.searchParams.get('compact') === '1'
          ? { ...activity, json: undefined, default_count: Object.keys(activity.json.default_parameters).length, custom_count: Object.keys(activity.json.custom_parameters).length } : activity),
          ...(priced.has(activity.evidence_id) ? { prices: priced.get(activity.evidence_id) } : {}) }));
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
      if (req.method === 'GET' && url.pathname === '/api/prices') {
        const snapshot = manager.snapshot(), { checks, summary } = prices(snapshot.events, snapshot.api);
        const order = { MISMATCH: 0, NO_API: 1, MATCH_PAGE: 2, MATCH: 3 };
        // The prices the website API returned, newest response first, whether or not an event sent them.
        const returned = snapshot.api.slice(-20).reverse().map(record => ({ captured_at: record.captured_at, url: record.url, method: record.method, total: record.prices.length,
          prices: record.prices.slice(0, 80).map(entry => ({ path: entry.path, value: entry.value, name: entry.name, ids: entry.ids?.slice(0, 3), currency: entry.currency })) }));
        return send(res, 200, { summary, session_id: manager.session?.id || null, checks: checks.slice(-400).reverse().sort((a, b) => order[a.status] - order[b.status]), api_prices: returned });
      }
      if (req.method === 'GET' && url.pathname === '/api/api-calls') {
        // The website API calls of the session (api-log.mjs), newest first, filtered by text and outcome.
        const all = manager.snapshot().apiCalls, q = String(url.searchParams.get('q') || '').trim().toLowerCase(), outcome = url.searchParams.get('status') || '';
        const calls = all.filter(call => (!q || `${call.method} ${call.host}${call.path} ${call.status ?? ''}`.toLowerCase().includes(q))
          && (!outcome || (outcome === 'failed' ? !call.ok : outcome === 'ok' ? call.ok : true)));
        return send(res, 200, { total: all.length, matched: calls.length, session_id: manager.session?.id || null, enabled: manager.session ? manager.session.api_log !== false : true,
          patterns: manager.session?.api_log_patterns ?? DEFAULT_API_LOG_PATTERNS, calls: calls.slice(-400).reverse() });
      }
      if (req.method === 'GET' && url.pathname === '/api/api-call') {
        // One call in full, with the tracking events sent from 5 s before it started to 5 s after it finished.
        const record = manager.apiCall(String(url.searchParams.get('id') || ''));
        if (!record) return send(res, 404, { error: 'Không có lời gọi API này trong phiên.' });
        const events = manager.snapshot().events, links = deliveryLinks(events);
        const from = Date.parse(record.captured_at) - 5000, to = Date.parse(record.finished_at ?? record.captured_at) + 5000;
        const nearby = activityEntries(events, { links }).filter(row => row.event_kind === 'business' && Date.parse(row.captured_at) >= from && Date.parse(row.captured_at) <= to)
          .slice(-40).map(row => ({ evidence_id: row.evidence_id, captured_at: row.captured_at, source: row.source, name: row.display_name ?? row.event_name, delivery: row.delivery }));
        return send(res, 200, { call: record, nearby });
      }
      if (req.method === 'GET' && url.pathname === '/api/define-template') {
        return send(res, 200, Buffer.from(await defineTemplate()), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { 'Content-Disposition': 'attachment; filename="eventqa-define-mau.xlsx"' });
      }
      if (req.method === 'GET' && url.pathname === '/api/spec/export') return send(res, 200, { schema_version: '1.0', kind: 'specification', cases: sanitizeCases(manager.cases) }, 'application/json; charset=utf-8', { 'Content-Disposition': 'attachment; filename="event-catalogue.json"' });
      if (req.method === 'GET' && url.pathname === '/api/event') {
        const detail = eventDetail(url.searchParams.get('id'));
        if (!detail) return send(res, 404, { error: 'Không có event này trong phiên.' });
        return send(res, 200, detail);
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
        if (automation?.busy) { automation.cancel(); reportNotesController?.abort(); await automation.wait(); }
        const result = await stopSession();
        return send(res, 200, { ...state(), stopped: true, interrupted: result.interrupted });
      }
      if (url.pathname === '/api/automation/cancel') {
        req.resume();
        if (!automation) return send(res, 404, { error: 'Luồng tự động có trong bản AI.' });
        automation.cancel(); reportNotesController?.abort();
        return send(res, 200, automation.state());
      }
      // The user finished logging in (or solving a CAPTCHA) while AI exploration waits.
      if (url.pathname === '/api/automation/resume') {
        req.resume();
        if (!automation) return send(res, 404, { error: 'Luồng tự động có trong bản AI.' });
        return send(res, 200, automation.resume());
      }
      const finishData = url.pathname === '/api/finish' ? await body(req) : null;
      if (finishData?.exportReport === false) {
        reportExportEpoch++;
        if (automation?.busy) { automation.cancel({ exportReport: false }); reportNotesController?.abort(); await automation.wait(); }
        else {
          if (!manager.session) throw new Error('Chưa có phiên đang chạy.');
          await stopSession({ exportReport: false });
        }
        exported = null; status('Đã kết thúc phiên và lưu bằng chứng. Có thể xuất báo cáo sau.');
        return send(res, 200, state());
      }
      if (finishData && automation?.busy) return send(res, 409, { error: 'Luồng tự động đang chạy; dùng Kết thúc để dừng trước khi xuất.' });
      if (closing || stoppingSession) return send(res, 503, { error: 'Ứng dụng đang dừng; bằng chứng đang được lưu.' });
      // A question about the captured events only reads the session, so it runs beside capture, steps and
      // automation instead of holding the lock other actions wait on. One question at a time.
      if (url.pathname === '/api/ai-ask') {
        if (mode !== 'cdp-ai') { req.resume(); return send(res, 404, { error: 'Chức năng AI chỉ có trong bản AI.' }); }
        if (asking) { req.resume(); return send(res, 409, { error: 'AI đang trả lời câu hỏi trước; đợi xong rồi hỏi tiếp.' }); }
        asking = true;
        try {
          const data = await body(req), question = String(data.question ?? '').trim();
          if (!question) throw new Error('Nhập câu hỏi cho AI trước.');
          if (question.length > 1000) throw new Error('Câu hỏi dài quá 1000 ký tự; hỏi ngắn gọn hơn.');
          const events = manager.snapshot().events;
          if (!events.some(event => eventKind(event) === 'business')) throw new Error('Phiên chưa có event để AI xem. Mở website và thao tác trước.');
          const evidenceId = typeof data.evidence_id === 'string' && data.evidence_id ? data.evidence_id.slice(0, 120) : undefined;
          return send(res, 200, await ai.askSession(sessionAskInput(events, question, data.history, { evidenceId })));
        } finally { asking = false; }
      }
      if (automation?.busy && !['/api/export', '/api/ai-review', '/api/ai-explain-event', '/api/tp2/mapping'].includes(url.pathname)) return send(res, 409, { error: 'Luồng tự động đang chạy. Dừng luồng trước khi thay đổi phiên hoặc kịch bản.' });
      if (mutating) return send(res, 409, { error: 'Đang xử lý thao tác trước.' });
      mutating = true;
      try {
        const data = finishData ?? await body(req, url.pathname === '/api/import-capture' ? 20 * 1024 * 1024 : undefined);
        if (url.pathname === '/api/tp2/mapping') {
          if (data.deleteId) await tp2Mappings.delete(String(data.deleteId)); else await tp2Mappings.save(data.mapping);
          tp2ComparisonCache.clear(); return send(res, 200, tp2State());
        } else if (url.pathname.startsWith('/api/automation/')) {
          if (!automation) return send(res, 404, { error: 'Luồng tự động có trong bản AI.' });
          const action = url.pathname.slice('/api/automation/'.length);
          if (action === 'open-browser') return send(res, 200, await automation.openBrowser(data));
          if (action === 'explore') return send(res, 202, await automation.explore({ name: data.name, url: data.url, browser: data.browser, instructions: data.instructions,
            variables: data.variables ?? {}, allowIrreversible: data.allowIrreversible === true, waitForLogin: data.waitForLogin === true }));
          if (action === 'save') return send(res, 200, await automation.save(data.workflow));
          if (action === 'delete') return send(res, 200, await automation.delete(data.id));
          if (action === 'run') return send(res, 202, await automation.enqueue(data.ids, { variables: data.variables ?? {}, aiNotes: data.aiNotes === true }));
          throw new Error('Không có thao tác luồng tự động này.');
        } else if (url.pathname === '/api/spec-upload') {
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
          // Events typed in the app stay next to the imported file.
          manager.cases = [...imported.cases, ...manager.cases.filter(testCase => testCase.provenance?.manual || testCase.provenance?.define)]; specSource = 'file';
          if (manager.session?.status === 'RUNNING') manager.store.saveExpected(sanitizeCases(manager.cases));
          status(`Đã nhập ${imported.cases.length} test case. ${imported.warnings.join(' ')}`);
          return send(res, 200, { ...state(), importWarnings: imported.warnings });
        } else if (url.pathname === '/api/import-define') {
          // The app's define sits beside the website's specification: a new define replaces only the old define.
          if (!['.xlsx', '.json'].includes(path.extname(String(data.path)).toLowerCase())) throw new Error('File define cần là XLSX hoặc JSON.');
          const imported = await importDefine(path.resolve(String(data.path)), { name: data.name });
          const taken = new Set(manager.cases.filter(testCase => !testCase.provenance?.define).map(testCase => testCase.id));
          const cases = imported.cases.map(testCase => taken.has(testCase.id) ? { ...testCase, id: `DEFINE-${testCase.id}` } : testCase);
          manager.cases = [...manager.cases.filter(testCase => !testCase.provenance?.define), ...cases];
          if (specSource === 'none' || specSource === 'demo') specSource = 'file';
          if (manager.session?.status === 'RUNNING') manager.store.saveExpected(sanitizeCases(manager.cases));
          evidenceRevised();
          status(`Đã nạp define app: ${cases.length} event${imported.sheet ? ` (sheet ${imported.sheet})` : ''}. Event Test Lab được so từng tham số trong phần chi tiết event.`);
          return send(res, 200, { ...state(), define: { events: cases.length, sheet: imported.sheet, format: imported.format, names: cases.map(testCase => testCase.rules?.[0]?.event_name).slice(0, 60) } });
        } else if (url.pathname === '/api/demo-spec') {
          if (manager.session?.status === 'RUNNING') throw new Error('Kết thúc phiên trước khi đổi specification.');
          manager.cases = await loadDemoCases(); specSource = 'demo'; status('Đã nạp 3 test case demo.');
        } else if (url.pathname === '/api/save-case') {
          // Rules may be written from evidence while the logged-in session keeps running.
          if (manager.currentStep) throw new Error('Hoàn tất bước đang ghi trước khi sửa rule.');
          const testCase = validateTestCase(data.case);
          const index = manager.cases.findIndex(c => c.id === testCase.id);
          manager.cases = index === -1 ? [...manager.cases, testCase] : manager.cases.map((c, i) => i === index ? testCase : c);
          await fs.mkdir(path.dirname(reviewedPath), { recursive: true });
          await fs.writeFile(reviewedPath, JSON.stringify({ cases: manager.cases }, null, 2)); specSource = 'reviewed';
          if (manager.session?.status === 'RUNNING') { manager.store.saveExpected(sanitizeCases(manager.cases)); status(`Đã lưu ${testCase.id} giữa phiên; expected.json của phiên được cập nhật.`); }
          else status('Đã lưu specification vào imports/reviewed-cases.json.');
        } else if (url.pathname === '/api/manual-case') {
          // An expected event typed in the app (name, platform, flow, pasted sample) joins the specification like an Excel row.
          if (manager.currentStep) throw new Error('Hoàn tất bước đang ghi trước khi thêm event.');
          const { testCase, warnings } = manualCase(data, manager.cases);
          manager.cases = [...manager.cases, testCase];
          await fs.mkdir(path.dirname(reviewedPath), { recursive: true });
          await fs.writeFile(reviewedPath, JSON.stringify({ cases: manager.cases }, null, 2)); specSource = 'reviewed';
          if (manager.session?.status === 'RUNNING') manager.store.saveExpected(sanitizeCases(manager.cases));
          status(`Đã thêm ${testCase.rules[0].event_name} (nhập tay) vào đặc tả.`);
          return send(res, 200, { ...state(), manualCase: { id: testCase.id, event_name: testCase.rules[0].event_name, flow: testCase.flow, source: testCase.source, fields: Object.keys(testCase.rules[0].fields), warnings } });
        } else if (url.pathname === '/api/delete-case') {
          if (manager.currentStep) throw new Error('Hoàn tất bước đang ghi trước khi xoá case.');
          const id = String(data.id);
          if (manager.steps.some(step => step.test_case_id === id)) throw new Error('Case đã có bước trong phiên này nên không xoá được; xoá sau khi kết thúc phiên.');
          manager.cases = manager.cases.filter(c => c.id !== id);
          await fs.mkdir(path.dirname(reviewedPath), { recursive: true });
          await fs.writeFile(reviewedPath, JSON.stringify({ cases: manager.cases }, null, 2));
          if (manager.session?.status === 'RUNNING') manager.store.saveExpected(sanitizeCases(manager.cases));
          status(`Đã xoá case ${id}.`);
        } else if (url.pathname === '/api/endpoints') {
          const patterns = Array.isArray(data.patterns) ? data.patterns.filter(p => typeof p === 'string' && p.length && p.length < 500) : null;
          if (!patterns?.length) throw new Error('Cần ít nhất một endpoint.');
          for (const pattern of patterns) { try { new RegExp(pattern, 'i'); } catch { throw new Error(`Regex endpoint không hợp lệ: ${pattern}`); } }
          activePatterns = [...new Set([...patterns, ...TP2_ENDPOINTS])]; collector?.setPatterns?.(activePatterns);
          status(`Allowlist: ${activePatterns.length} endpoint${collector ? ' (áp dụng cho request mới)' : ''}.`);
        } else if (url.pathname === '/api/import-capture') {
          if (manager.session?.status === 'RUNNING') throw new Error('Đang có phiên chạy. Kết thúc phiên trước khi nhập bản ghi.');
          const count = importCapture(data.capture);
          status(`Đã nhập ${count} event từ bản ghi F12. Nạp file đặc tả để đối chiếu, hoặc bấm Kết thúc & xuất báo cáo.`);
        } else if (url.pathname === '/api/start') {
          await startCapture(data);
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
          const selection = data.selection ? normalizeSelection(data.selection) : undefined;
          if (manager.currentStep) throw new Error('Hoàn tất bước hiện tại trước.');
          await stopSession({ exportReport: false });
          if (await exportWithNotes(manager.snapshot(), { aiNotes: data.aiNotes !== false, selection })) status('AI đã viết cột nhận xét của sheet Báo cáo event.');
          if (exported) status(`Đã xuất report tại ${manager.runDir}`);
        } else if (url.pathname === '/api/export') {
          if (!manager.session) throw new Error('Chưa có phiên.');
          status(await exportWithNotes(manager.snapshot(), { aiNotes: data.aiNotes !== false, selection: data.selection }) ? 'Đã xuất report hiện tại; AI đã viết cột nhận xét của sheet Báo cáo event.' : 'Đã xuất report hiện tại.');
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
  return { server, manager, state, csrf, stopSession, close, automation, async listen() {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); port = server.address().port;
    automation?.startScheduler();
    return `http://127.0.0.1:${port}`;
  } };
}
