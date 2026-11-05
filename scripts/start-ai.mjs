import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aiProcessConfig } from '../src/ai/runtime.mjs';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || major === 24 && minor < 5) {
  console.error('Bản AI cần Node.js 24.5 trở lên để hỗ trợ proxy. Dùng runtime có sẵn trong gói Windows FULL hoặc cập nhật Node.js.');
  process.exitCode = 1;
} else {
  try {
    const config = aiProcessConfig(fileURLToPath(new URL('../', import.meta.url)), process.argv.slice(2));
    const child = spawn(config.command, config.args, config.options);
    let requestedSignal = null;
    const forward = signal => {
      requestedSignal = signal;
      // In an interactive console Ctrl+C already reaches the child. Sending
      // SIGINT again can kill it before the app finishes graceful shutdown.
      if (child.exitCode === null && !(signal === 'SIGINT' && process.stdin.isTTY)) child.kill(signal);
    };
    process.once('SIGINT', () => forward('SIGINT')); process.once('SIGTERM', () => forward('SIGTERM'));
    child.once('error', () => { console.error('Không khởi động được bản AI. Kiểm tra runtime và cấu hình mạng rồi thử lại.'); process.exitCode = 1; });
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal && signal !== requestedSignal ? 1 : 0); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
