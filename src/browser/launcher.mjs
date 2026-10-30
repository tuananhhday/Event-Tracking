import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { CDPConnection } from '../collectors/cdp.mjs';

// Ownership cannot be forged by passing an attached tab/port or copying a handle.
const ownedBrowsers = new WeakMap();

function browserEndpoint(value, port) {
  try {
    const url = new URL(value);
    return ['ws:', 'wss:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      && Number(url.port) === port && url.pathname.startsWith('/devtools/browser/') ? value : null;
  } catch { return null; }
}

function executableExists(path) {
  try { return !!path && existsSync(path) && statSync(path).isFile(); } catch { return false; }
}

export function findBrowser(browser = 'chrome') {
  if (!['chrome', 'edge'].includes(browser)) throw new Error('Browser must be chrome or edge.');
  const local = process.env.LOCALAPPDATA || '';
  const roots = [process.env.PROGRAMFILES || 'C:\\Program Files', process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', local];
  const suffix = browser === 'chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
  const candidates = process.platform === 'win32' ? roots.map(root => join(root, ...suffix)) : browser === 'chrome'
    ? ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/microsoft-edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  const found = candidates.find(executableExists);
  if (!found) throw new Error(`Cannot find ${browser}. Supply an absolute executablePath or install Chrome/Edge.`);
  return found;
}

export function checkEdgeDebugPolicy() {
  if (process.platform !== 'win32') return;
  for (const hive of ['HKLM', 'HKCU']) {
    const result = spawnSync('reg.exe', ['query', `${hive}\\SOFTWARE\\Policies\\Microsoft\\Edge`, '/v', 'RemoteDebuggingAllowed'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (/RemoteDebuggingAllowed\s+REG_DWORD\s+0x0\b/i.test(result.stdout || '')) {
      throw new Error('Edge RemoteDebuggingAllowed policy is disabled. Contact IT or use the proxy collector; policy is not bypassed.');
    }
  }
}

function validateProfile(path) {
  const candidate = resolve(path);
  const defaults = [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data')].filter(Boolean);
  if (defaults.some(value => resolve(value).toLowerCase() === candidate.toLowerCase())) {
    throw new Error('Use a dedicated test profile, not the default Chrome/Edge User Data directory.');
  }
  return candidate;
}

export async function launchBrowser({ browser = 'chrome', port = 9222, url = 'about:blank', profileDir,
  executablePath, proxyServer, trustSpki, headless = false, startupTimeoutMs = 15000 } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Debug port must be an integer from 1024 to 65535.');
  if (browser === 'edge') checkEdgeDebugPolicy();
  if (!['chrome', 'edge'].includes(browser)) throw new Error('Browser must be chrome or edge.');
  if (!/^(https?:\/\/|about:blank$)/i.test(url)) throw new Error('Browser URL must use HTTP or HTTPS, or be about:blank.');
  if (proxyServer && !/^(?:http:\/\/)?(?:127\.0\.0\.1|localhost):\d{2,5}$/i.test(proxyServer)) {
    throw new Error('Test proxy must be a localhost HTTP proxy.');
  }
  // Trusts only certificates carrying this one public key (the local proxy CA), not any certificate.
  if (trustSpki && (!proxyServer || !/^[A-Za-z0-9+/]{43}=$/.test(trustSpki))) throw new Error('trustSpki needs a local proxy and a SHA-256 SPKI hash.');
  const executable = executablePath || findBrowser(browser);
  if (!isAbsolute(executable) || !executableExists(executable)) throw new Error('executablePath must point to an existing absolute browser executable.');
  const profile = validateProfile(profileDir || resolve('.profiles', browser));
  try {
    const existing = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    if (existing.ok) throw Object.assign(new Error(`Debug port ${port} is already in use. Attach explicitly or choose another port.`), { code: 'PORT_IN_USE' });
  } catch (error) { if (error.code === 'PORT_IN_USE') throw error; }
  mkdirSync(profile, { recursive: true });
  const args = [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--new-window'];
  if (!headless) args.push('--start-maximized');
  if (proxyServer) args.push(`--proxy-server=${proxyServer}`, '--proxy-bypass-list=<-loopback>');
  if (trustSpki) args.push(`--ignore-certificate-errors-spki-list=${trustSpki}`);
  if (headless) args.push('--headless=new');
  args.push(url);
  const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' });
  let startupError;
  child.once('error', error => { startupError = error; });
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (startupError) throw new Error(`Cannot launch ${browser}: ${startupError.message}`);
    if (child.exitCode !== null && child.exitCode !== 0) throw new Error(`${browser} exited before the debug endpoint was ready (code ${child.exitCode}).`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(700) });
      const version = response.ok ? await response.json() : null;
      const browserWebSocketUrl = browserEndpoint(version?.webSocketDebuggerUrl, port);
      if (browserWebSocketUrl) {
        const handle = { process: child, port, profileDir: profile, executablePath: executable, browserWebSocketUrl, owned: true };
        ownedBrowsers.set(handle, { process: child, port, browserWebSocketUrl });
        return handle;
      }
    } catch { /* Browser may take a few seconds to start. */ }
    await delay(150);
  }
  if (child.exitCode === null) child.kill();
  throw new Error(`Cannot connect to ${browser} on localhost:${port}. A browser may already hold this test profile, or remote debugging may be blocked by policy.`);
}

/** Create a known top-level page rather than navigating the first discovered
 * target, which can be an Edge onboarding/sign-in dialog on a fresh profile. */
export async function createTestPage({ port, headless = false } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid browser debug port.');
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error('Cannot read test browser identity.');
  const endpoint = browserEndpoint((await response.json()).webSocketDebuggerUrl, port);
  if (!endpoint) throw new Error('Invalid test browser identity.');
  const connection = new CDPConnection(endpoint);
  try {
    await connection.connect();
    const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank', newWindow: !headless, background: false });
    if (!targetId) throw new Error('Browser did not create a test page.');
    if (!headless) {
      // Some window managers do not implement bounds changes; page identity is
      // still deterministic and must not fall back to another target.
      try {
        const { windowId } = await connection.send('Browser.getWindowForTarget', { targetId });
        await connection.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
      } catch { /* Window bounds are optional on this platform. */ }
    }
    await connection.send('Target.activateTarget', { targetId });
    return targetId;
  } finally { connection.close(); }
}

/** Close only the browser launched for this exact handle; never follow a reused port. */
export async function closeOwnedBrowser(handle, { timeoutMs = 1500 } = {}) {
  const owned = handle && typeof handle === 'object' ? ownedBrowsers.get(handle) : null;
  if (!owned) return { closed: false, reason: 'not_owned' };
  const child = owned.process;
  if (child.exitCode !== null || child.signalCode != null || child.killed) return { closed: true, reason: 'already_exited' };
  const budget = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 3000)) : 1500;
  const controller = new AbortController();
  let connection, timer;
  const operation = (async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${owned.port}/json/version`, { signal: controller.signal });
      if (!response.ok) return { closed: false, reason: 'endpoint_unavailable' };
      const version = await response.json();
      if (version.webSocketDebuggerUrl !== owned.browserWebSocketUrl) return { closed: false, reason: 'browser_identity_changed' };
      if (child.exitCode !== null || child.signalCode != null || child.killed) return { closed: true, reason: 'already_exited' };
      connection = new CDPConnection(owned.browserWebSocketUrl, { timeoutMs: budget });
      await connection.connect();
      try { await connection.send('Browser.close'); }
      catch (error) { if (!connection.closed) throw error; }
      return { closed: true, reason: 'close_requested' };
    } catch {
      return { closed: false, reason: controller.signal.aborted ? 'timeout' : 'endpoint_unavailable' };
    }
  })();
  try {
    return await Promise.race([operation, new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); connection?.close(); resolve({ closed: false, reason: 'timeout' }); }, budget);
    })]);
  } finally { clearTimeout(timer); controller.abort(); connection?.close(); }
}
