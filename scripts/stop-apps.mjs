import path from 'node:path';
import { pathToFileURL } from 'node:url';

const defaults = [{ mode: 'cdp', port: 4173 }, { mode: 'cdp-ai', port: 4174 }, { mode: 'proxy', port: 4175 }];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Discover the actual local app; no stale PID manifest or process-wide kill. */
export async function shutdownApps({ apps = defaults, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const results = [];
  for (const app of apps) {
    const base = `http://127.0.0.1:${app.port}`;
    let state;
    try { const response = await fetchImpl(`${base}/api/state`, { signal: AbortSignal.timeout(1500) }); state = await response.json(); }
    catch { results.push({ ...app, status: 'OFFLINE', message: `${app.mode}: đã tắt.` }); continue; }
    if (state.application !== 'event-tracking-qa' || state.mode !== app.mode || !Number.isInteger(state.process_id)) {
      results.push({ ...app, status: 'UNRECOGNIZED', message: `${app.mode}: bỏ qua dịch vụ khác ở cổng ${app.port}.` }); continue;
    }
    try {
      const html = await (await fetchImpl(base, { signal: AbortSignal.timeout(2000) })).text();
      const token = html.match(/const token='([a-f0-9]{48})'/)?.[1];
      if (!token) throw new Error('Không đọc được token dừng ứng dụng.');
      const response = await fetchImpl(`${base}/api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EventQA-Token': token }, body: '{}', signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`Lệnh dừng trả HTTP ${response.status}.`);
      const deadline = Date.now() + timeoutMs;
      let stopped = false;
      while (Date.now() < deadline) {
        try {
          const current = await (await fetchImpl(`${base}/api/state`, { signal: AbortSignal.timeout(800) })).json();
          if (current.process_id !== state.process_id) { stopped = true; break; }
        } catch { stopped = true; break; }
        await sleep(150);
      }
      if (!stopped) throw new Error('Đã gửi lệnh dừng; ứng dụng vẫn đang lưu/đóng. Kiểm tra thư mục runs.');
      results.push({ ...app, status: 'STOPPED', message: `Đã lưu phiên và tắt ${app.mode}.` });
    } catch (error) { results.push({ ...app, status: 'ERROR', message: `${app.mode}: ${error.message}` }); }
  }
  return results;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const results = await shutdownApps();
  for (const result of results) console.log(result.message);
  if (results.some(result => result.status === 'ERROR')) process.exitCode = 1;
}
