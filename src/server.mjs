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
import { specCoverage } from './core/catalog.mjs';
import { importSpec, validateTestCase } from './spec/import.mjs';
import { exportReports } from './report/export.mjs';
import { CDPCollector, CDPConnection, listTargets } from './collectors/cdp.mjs';
import { launchBrowser, closeOwnedBrowser } from './browser/launcher.mjs';
import { ProxyCollector, proxyCaSpki } from './collectors/proxy.mjs';
import { OpenRouterClient } from './ai/openrouter.mjs';
import { loadDemoCases } from './demo.mjs';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const readWeb = name => fs.readFile(new URL(`./web/${name}`, import.meta.url), 'utf8');
// Each mode has its own screen; styling and client logic are shared assets.
const MODE_PAGES = { cdp: 'cdp.html', 'cdp-ai': 'cdp-ai.html', proxy: 'proxy.html' };
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
// One CA for all proxy sessions, so the test browser trusts a single stable key.
const proxyConfDir = path.join(rootDir, 'profiles', 'mitmproxy');

/** Counts per event name/layer/source over all evidence, for exploring a site without a specification. */
function summarize(events) {
  const groups = new Map();
  for (const event of events) {
    const phase = event.network?.phase;
    const key = [event.layer, event.source, event.event_name].join('|');
    let group = groups.get(key);
    if (!group) groups.set(key, group = { key, event_name: event.event_name, layer: event.layer, source: event.source, count: 0, bound: 0, failed: 0, first_at: event.captured_at, last_at: event.captured_at, last_evidence_id: null, pages: [] });
    if (phase === 'failed' || (phase === 'response' && Number(event.network?.status) >= 400)) group.failed++;
    if (phase && phase !== 'request') continue;
    group.count++; if (event.step_id) group.bound++;
    group.last_at = event.captured_at; group.last_evidence_id = event.evidence_id;
    let page = ''; try { const url = new URL(event.page?.url); page = url.host + url.pathname; } catch {}
    if (page && !group.pages.includes(page) && group.pages.length < 3) group.pages.push(page);
  }
  return [...groups.values()].filter(group => group.count).sort((a, b) => b.last_at.localeCompare(a.last_at));
}

export async function createApp({ mode = 'cdp', runsDir = path.join(rootDir, 'runs'), port = 4173, aiClient, initialCases = 'demo' } = {}) {
  if (!['cdp', 'cdp-ai', 'proxy'].includes(mode)) throw new Error('Mode must be cdp, cdp-ai or proxy.');
  const csrf = randomBytes(24).toString('hex');
  const bundledProxy = path.join(rootDir, '.venv-proxy', process.platform === 'win32' ? 'Scripts/mitmdump.exe' : 'bin/mitmdump');
  const defaultProxyCommand = await fs.access(bundledProxy).then(() => bundledProxy, () => 'mitmdump');
  // 'auto' (CLI) resumes reviewed rules or starts empty for a real site; tests keep the demo default.
  let specSource = 'demo', cases;
  if (Array.isArray(initialCases)) { cases = initialCases; specSource = initialCases.length ? 'file' : 'none'; }
  else if (initialCases === 'auto') {
    try { cases = JSON.parse(await fs.readFile(reviewedSpecPath, 'utf8')).cases.map(validateTestCase); specSource = 'reviewed'; }
    catch { cases = []; specSource = 'none'; }
  } else cases = await loadDemoCases();
  const manager = new SessionManager({ mode, runsDir, cases });
  let activePatterns = [...DEFAULT_ENDPOINT_PATTERNS], proxyCa = null, navigationError = null;
  // Event-to-specification matches, reset whenever the cases change.
  let coverageCases = null, coverageCache = new Map();
  const coverage = events => {
    if (!manager.cases.length) return null;
    if (coverageCases !== manager.cases) { coverageCases = manager.cases; coverageCache = new Map(); }
    return specCoverage(manager.cases, events, coverageCache);
  };
  const statuses = []; let collector = null, browserHandle = null, exported = null, mutating = false;
  let closing = false, closePromise = null, stoppingSession = null, captureEpoch = 0;
  const status = message => { statuses.push({ at: new Date().toISOString(), message: redact(String(message && typeof message === 'object' ? message.message ?? JSON.stringify(message) : message)) }); if (statuses.length > 40) statuses.shift(); };
  let ai = aiClient ?? new OpenRouterClient();
  const state = () => {
    const snapshot = manager.snapshot();
    return { application: 'event-tracking-qa', mode, process_id: process.pid, closing, defaultProxyCommand, ai: mode === 'cdp-ai' ? ai.diagnostics?.() : undefined, running: manager.session?.status === 'RUNNING', session: manager.session || null,
      specSource, navigationError, patterns: activePatterns, vendors: VENDOR_ENDPOINTS, discovered: collector?.discovered ? [...collector.discovered.values()].sort((a, b) => b.count - a.count) : [], proxyCa,
      eventSummary: summarize(snapshot.events), specCoverage: coverage(snapshot.events), currentStep: manager.currentStep, stepEventCount: manager.currentStep ? snapshot.events.filter(event => event.step_id === manager.currentStep.id).length : 0, runDir: manager.runDir || null, cases: manager.cases, results: snapshot.results, steps: manager.steps,
      events: snapshot.events.slice(-100), eventCount: snapshot.events.length, statuses, exported: exported ? Object.fromEntries(Object.entries(exported).map(([k, p]) => [k, `/download/${path.basename(p)}`])) : null };
  };
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
      // ProxyCollector owns only the mitmdump child it launched.
      if (current instanceof ProxyCollector) current.process?.kill();
      status('Collector đã dừng sau giới hạn thời gian chờ.');
    }
  }
  // A test window left open from an earlier run still owns its profile and debug port:
  // reuse it (keeping the login) instead of failing to launch a second one.
  async function openTestBrowser(options) {
    let targets = null;
    try { targets = await listTargets(options.port); } catch { /* nothing listening */ }
    if (targets) {
      if (!targets.length) await fetch(`http://127.0.0.1:${options.port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(3000) });
      status(`Dùng lại cửa sổ trình duyệt test đang mở (cổng ${options.port}); app sẽ không tự đóng cửa sổ này.`);
      return { reused: true };
    }
    try { browserHandle = await launchBrowser(options); return { reused: false }; }
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
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, state());
      if (req.method === 'GET' && url.pathname === '/api/event') {
        const id = url.searchParams.get('id');
        const event = manager.snapshot().events.find(candidate => candidate.evidence_id === id);
        return event ? send(res, 200, { event }) : send(res, 404, { error: 'Không có event này trong phiên.' });
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
        if (url.pathname === '/api/import') {
          // A specification can arrive after exploring the site, as long as no step depends on the old one.
          if (manager.session?.status === 'RUNNING' && manager.steps.length) throw new Error('Phiên đã có bước dùng đặc tả hiện tại; kết thúc phiên trước khi đổi file đặc tả.');
          if (!['.xlsx', '.json'].includes(path.extname(String(data.path)).toLowerCase())) throw new Error('Chỉ nhận XLSX hoặc JSON.');
          const imported = await importSpec(path.resolve(String(data.path)), { sheet: data.sheet || undefined });
          if (!imported.cases.length) throw new Error('Không tìm thấy test case hợp lệ.');
          manager.cases = imported.cases; specSource = 'file';
          if (manager.session?.status === 'RUNNING') manager.store.saveExpected(sanitizeCases(manager.cases));
          status(`Đã nhập ${imported.cases.length} test case. ${imported.warnings.join(' ')}`);
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
          if (mode === 'proxy' && manager.session?.status === 'RUNNING') throw new Error('Proxy nhận allowlist khi khởi động; dừng phiên rồi mở phiên mới để áp dụng.');
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
          const debugPort = Number(data.debugPort || ({ cdp: 9222, 'cdp-ai': 9223, proxy: 9224 }[mode]));
          const endpointPatterns = Array.isArray(data.endpointPatterns) ? data.endpointPatterns.filter(p => typeof p === 'string' && p.length < 500) : [...DEFAULT_ENDPOINT_PATTERNS];
          if (targetUrl.hostname === '127.0.0.1' && targetUrl.pathname === '/demo') endpointPatterns.push('/demo/g/collect', '/demo/insider/events');
          activePatterns = endpointPatterns;
          // A failed lookup is a warning only: the test browser may still reach it through a system proxy.
          navigationError = null;
          if (!['127.0.0.1', 'localhost'].includes(targetUrl.hostname)) {
            try { await dns.lookup(targetUrl.hostname); }
            catch (error) { navigationError = navigationHint(targetUrl.hostname, error.code || 'ENOTFOUND'); }
          }
          manager.start({ browser, environment: targetUrl.origin, target_url: targetUrl.toString() }); exported = null;
          const epoch = ++captureEpoch;
          const emit = event => epoch === captureEpoch ? manager.emit(event) : null;
          try {
            if (mode === 'proxy') {
              collector = new ProxyCollector({ onEvent: emit, onStatus: status, port: Number(data.proxyPort || 8080), runDir: manager.runDir,
                endpointPatterns, command: data.proxyCommand || defaultProxyCommand, confDir: proxyConfDir });
              await collector.start({ ...manager.session, runDir: manager.runDir });
              const trustCa = data.trustProxyCa !== false;
              const ca = await proxyCaSpki(proxyConfDir);
              proxyCa = { cert_path: ca.file.replace(/.pem$/, '.cer'), trusted_in_test_browser: trustCa };
              if (closing || epoch !== captureEpoch) return send(res, 200, state());
              const opened = await openTestBrowser({ browser, port: debugPort, headless, url: targetUrl.toString(), profileDir: path.join(rootDir, 'profiles', `proxy-${browser}`), proxyServer: `http://127.0.0.1:${Number(data.proxyPort || 8080)}`, trustSpki: trustCa ? ca.spki : undefined });
              if (opened.reused) {
                const [page] = await listTargets(debugPort);
                const connection = new CDPConnection(page.webSocketDebuggerUrl);
                try { await connection.connect(); const navigation = await connection.send('Page.navigate', { url: targetUrl.toString() }); if (navigation.errorText) navigationError = navigationHint(targetUrl.hostname, navigation.errorText); }
                finally { connection.close(); }
              }
              status(trustCa ? 'Proxy sẵn sàng. Trình duyệt test chỉ tin CA proxy cục bộ này; HTTPS dùng được.' : 'Proxy sẵn sàng. Chưa tin CA proxy: website HTTPS sẽ báo lỗi chứng chỉ.');
              if (navigationError) status(navigationError);
            } else {
              if (!data.attach) await openTestBrowser({ browser, port: debugPort, headless, url: 'about:blank', profileDir: path.join(rootDir, 'profiles', `${mode}-${browser}`) });
              if (closing || epoch !== captureEpoch) { await releaseBrowser(); return send(res, 200, state()); }
              collector = new CDPCollector({ port: debugPort, targetId: data.targetId || undefined, onEvent: emit, onStatus: status, endpointPatterns });
              await collector.start(manager.session);
              if (!data.attach) {
                const first = [...collector.connections.values()][0];
                const navigation = await first.connection.send('Page.navigate', { url: targetUrl.toString() });
                if (navigation.errorText) navigationError = navigationHint(targetUrl.hostname, navigation.errorText);
              }
              status(navigationError || 'Collector đã sẵn sàng. Chọn test case và bắt đầu bước trước khi thao tác.');
            }
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
        } else if (url.pathname === '/api/ai-draft') {
          if (mode !== 'cdp-ai') throw new Error('Chức năng AI chỉ có trong phương án 2.');
          if (!data.input || typeof data.input !== 'object' || Array.isArray(data.input)) throw new Error('AI input cần là JSON object chứa đặc tả.');
          const draft = await ai.draftCase(data.input); return send(res, 200, draft);
        } else if (url.pathname === '/api/ai-models') {
          if (mode !== 'cdp-ai') throw new Error('Chức năng AI chỉ có trong phương án 2.');
          return send(res, 200, { ...await ai.listRoutingCandidates({ task: 'spec' }), diagnostics: ai.diagnostics() });
        } else if (url.pathname === '/api/ai-test') {
          if (mode !== 'cdp-ai') throw new Error('Chức năng AI chỉ có trong phương án 2.');
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
