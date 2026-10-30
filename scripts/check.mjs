import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
async function walk(dir) { const entries = await fs.readdir(dir, { withFileTypes: true }); return (await Promise.all(entries.map(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : /\.(mjs|js)$/.test(entry.name) ? [path.join(dir, entry.name)] : []))).flat(); }
const files = (await Promise.all(['src', 'scripts', 'tests'].map(async dir => { try { return await walk(dir); } catch { return []; } }))).flat();
let failed = false;
for (const file of files) { const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true }); if (result.status !== 0) { failed = true; console.error(file, result.stderr); } }
console.log(`${files.length} JavaScript files checked.`); if (failed) process.exitCode = 1;
