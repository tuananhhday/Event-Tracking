// Build-time only: combine pure JavaScript dependencies for fast Windows extraction.
// Usage: node scripts/bundle-portable-deps.mjs ESBUILD_MODULE OUTPUT_DIRECTORY
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const [modulePath, outputPath] = process.argv.slice(2);
if (!modulePath || !outputPath) throw Error('Supply the esbuild module and output directory.');
const { build, version } = await import(pathToFileURL(path.resolve(modulePath)));
if (version !== '0.25.12') throw Error('Use esbuild 0.25.12 for the portable build.');
const require = createRequire(path.join(root, 'package.json'));
const output = path.resolve(outputPath);
await fs.mkdir(output, { recursive: true });
if ((await fs.readdir(output)).length) throw Error('Use an empty output directory so old dependency files cannot be included.');
for (const name of ['exceljs', 'ajv', 'json5', 'jszip']) {
  const directory = path.join(output, name);
  await fs.mkdir(directory, { recursive: true });
  await build({ entryPoints: [require.resolve(name)], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: path.join(directory, 'index.cjs'), legalComments: 'inline', logLevel: 'info' });
  const original = JSON.parse(await fs.readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version: original.version, main: 'index.cjs', license: original.license }));
}
const licenses = [];
// Playwright loads its driver and assets by relative paths. Keep the runtime
// layout, omitting editor types, source maps and documentation for development.
const playwrightRoot = path.join(root, 'node_modules', 'playwright-core');
await fs.cp(playwrightRoot, path.join(output, 'playwright-core'), { recursive: true, filter: source => {
  const relative = path.relative(playwrightRoot, source).split(path.sep).join('/');
  if (relative === 'lib/tools/skills' || relative.startsWith('lib/tools/skills/')) return false;
  const name = path.basename(source);
  if (/^(?:licen[cs]e|copying|notice|thirdpartynotices)(?:[.-].*)?$/i.test(name)) return true;
  return !/(?:\.d\.ts|\.map|\.md|\.markdown)$/i.test(name);
} });
async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.isSymbolicLink()) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (/^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(entry.name)) licenses.push(`\n===== ${path.relative(root, file)} =====\n${await fs.readFile(file, 'utf8')}`);
  }
}
await walk(path.join(root, 'node_modules'));
await fs.writeFile(path.join(output, 'THIRD_PARTY_LICENSES.txt'), licenses.join('\n'));
await fs.writeFile(path.join(output, 'eventqa-deps.json'), JSON.stringify({ schema_version: 1, esbuild: version,
  lockfile_sha256: createHash('sha256').update(await fs.readFile(path.join(root, 'package-lock.json'))).digest('hex'),
  modules: ['exceljs', 'ajv', 'json5', 'jszip', 'playwright-core'] }, null, 2));
console.log('Bundled dependencies:', output);
