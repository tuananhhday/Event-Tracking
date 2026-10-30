// Build-time only: combine pure JavaScript dependencies for fast Windows extraction.
// Usage: node scripts/bundle-portable-deps.mjs ESBUILD_MODULE OUTPUT_DIRECTORY
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const [modulePath, outputPath] = process.argv.slice(2);
if (!modulePath || !outputPath) throw Error('Supply the esbuild module and output directory.');
const { build } = await import(pathToFileURL(path.resolve(modulePath)));
const require = createRequire(path.join(root, 'package.json'));
const output = path.resolve(outputPath);
await fs.mkdir(output, { recursive: true });
for (const name of ['exceljs', 'ajv', 'json5', 'jszip']) {
  const directory = path.join(output, name);
  await fs.mkdir(directory, { recursive: true });
  await build({ entryPoints: [require.resolve(name)], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: path.join(directory, 'index.cjs'), legalComments: 'inline', logLevel: 'info' });
  const original = JSON.parse(await fs.readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8'));
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version: original.version, main: 'index.cjs', license: original.license }));
}
const licenses = [];
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
console.log('Bundled dependencies:', output);
