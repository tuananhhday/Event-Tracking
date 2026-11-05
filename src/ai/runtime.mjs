import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

/** Parse local configuration before starting Node so proxy and additional CA
 * settings take effect during runtime initialization. Never log their values. */
export function aiProcessConfig(root, args = [], baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  try {
    const file = parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8'));
    for (const [name, value] of Object.entries(file)) if (!Object.hasOwn(environment, name)) environment[name] = value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Không đọc được file .env. Kiểm tra quyền đọc và định dạng file rồi mở lại ứng dụng.');
  }
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) if (environment[name]) {
    try {
      const proxy = new URL(environment[name]);
      if (!['http:', 'https:'].includes(proxy.protocol) || proxy.pathname.toLowerCase().endsWith('.pac')) throw new Error();
      decodeURIComponent(proxy.username); decodeURIComponent(proxy.password);
    }
    catch { throw new Error(`${name} cần là địa chỉ proxy HTTP/HTTPS do IT cung cấp; không dùng URL file PAC.`); }
  }
  for (const name of ['NO_PROXY', 'no_proxy']) {
    const entries = String(environment[name] || environment[name === 'NO_PROXY' ? 'no_proxy' : 'NO_PROXY'] || '').split(',').map(value => value.trim()).filter(Boolean);
    environment[name] = [...new Set([...entries, 'localhost', '127.0.0.1', '::1', '[::1]'])].join(',');
  }
  return { command: process.execPath, args: ['--use-system-ca', '--use-env-proxy', path.join(root, 'src', 'cli.mjs'), 'serve', '--mode', 'cdp-ai', ...args], options: { cwd: root, env: environment, stdio: 'inherit' } };
}
