import { parseArgs } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createApp } from './server.mjs';
import { runDemo } from './demo.mjs';
import { importSpec } from './spec/import.mjs';
import { loadRun } from './core/session.mjs';
import { exportReports } from './report/export.mjs';
import { validateCase } from './core/rules.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  mode: { type: 'string', default: 'cdp' }, port: { type: 'string' }, 'runs-dir': { type: 'string', default: 'runs' },
  spec: { type: 'string' }, sheet: { type: 'string' }, out: { type: 'string' }, run: { type: 'string' },
  failure: { type: 'boolean', default: false }, open: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' }
} });
// Opens the local dashboard in the user's default browser, not the test profile.
function openInBrowser(url) {
  const [command, args] = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch {}
}
const command = positionals[0] || 'serve';
async function main() {
  if (values.help) { console.log('EventQA (Node.js 24+)\n  node src/cli.mjs serve --mode cdp|cdp-ai|proxy [--port 4173] [--open]\n  node src/cli.mjs demo [--failure]\n  node src/cli.mjs import --spec file.xlsx [--sheet name] --out rules.json\n  node src/cli.mjs report --run runs/S-... --spec rules.json'); return; }
  if (command === 'serve') {
    const port = Number(values.port || ({ cdp: 4173, 'cdp-ai': 4174, proxy: 4175 }[values.mode]));
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be 1024..65535.');
    const app = await createApp({ mode: values.mode, port, runsDir: values['runs-dir'], initialCases: 'auto' });
    const address = await app.listen();
    console.log(`EventQA · ${values.mode}\nMở ${address}\nDừng ứng dụng: Ctrl+C`);
    if (values.open) openInBrowser(address);
    let stopping = false; const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } else if (command === 'demo') {
    const { snapshot, files } = await runDemo({ runsDir: values['runs-dir'], failure: values.failure });
    console.log(JSON.stringify({ session: snapshot.session.id, results: snapshot.results.map(r => ({ case: r.test_case_id, verdict: r.verdict })), files }, null, 2));
  } else if (command === 'import') {
    if (!values.spec || !values.out) throw new Error('Cần --spec và --out.');
    const imported = await importSpec(path.resolve(values.spec), { sheet: values.sheet });
    await fs.writeFile(path.resolve(values.out), JSON.stringify(imported, null, 2)); console.log(`Đã nhập ${imported.cases.length} test case.\n${imported.warnings.join('\n')}`);
  } else if (command === 'report') {
    if (!values.run) throw new Error('Cần --run.');
    const snapshot = loadRun(values.run); if (values.spec) snapshot.cases = (await importSpec(values.spec)).cases;
    if (!snapshot.cases.length) throw new Error('Phiên cũ chưa có expected.json; hãy cung cấp --spec.');
    for (const step of snapshot.steps) if (!snapshot.cases.some(c => c.id === step.test_case_id)) throw new Error(`Specification không có case ${step.test_case_id} của phiên này.`);
    snapshot.results = snapshot.steps.map(s => validateCase(snapshot.cases.find(c => c.id === s.test_case_id), snapshot.events, s));
    for (const c of snapshot.cases) if (!snapshot.steps.some(s => s.test_case_id === c.id)) snapshot.results.push(validateCase(c, [], { id: null, test_case_id: c.id, status: 'NOT_EXECUTED', context: {} }));
    console.log(JSON.stringify(await exportReports(snapshot, values.out || values.run), null, 2));
  } else throw new Error(`Unknown command: ${command}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
