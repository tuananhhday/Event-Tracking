// Local browser test: real workbook, private fake key, no OpenRouter requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/server.mjs';
import { CDPConnection, listTargets } from '../src/collectors/cdp.mjs';
import { launchBrowser, closeOwnedBrowser } from '../src/browser/launcher.mjs';

if (!process.argv[2]) throw new Error('Pass the local WebOTA workbook path.');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-portable-ai-'));
const configFile = path.join(dir, '.env');
const fakeKey = 'sk-or-v1-browser-test-only-1234567890';
const app = await createApp({ mode: 'cdp-ai', port: 0, runsDir: dir, aiConfigPath: configFile, initialCases: [] });
let browser, cdp;
const errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ev = async expression => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
async function wait(expression) {
  for (let i = 0; i < 180; i++) { if (await ev(expression)) return; await delay(50); }
  throw new Error('Timeout: ' + expression);
}
try {
  const base = await app.listen();
  browser = await launchBrowser({ port: 9489, headless: true, url: base, profileDir: path.join(dir, 'browser') });
  cdp = new CDPConnection((await listTargets(9489))[0].webSocketDebuggerUrl); await cdp.connect();
  cdp.on('event', message => { if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails); });
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await wait('!!document.getElementById("spec-file")');
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#spec-file' });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [path.resolve(process.argv[2])] });
  await wait('document.getElementById("sheet-select").value === "Tổng hợp Event tracking"');
  await ev('document.getElementById("import").click()');
  await wait('document.querySelectorAll("#ai-spec-case option").length === 168');
  await ev('document.querySelector("[data-tab=ai]").click()');
  await ev('document.getElementById("ai-spec-case").value = [...document.querySelectorAll("#ai-spec-case option")].find(o => o.textContent.includes("Golf") && o.textContent.includes("INSIDER")).value; document.querySelector("[data-action=ai-use-spec]").click()');
  const input = JSON.parse(await ev('document.getElementById("ai-input").value'));
  assert.equal(input.flow, 'Golf'); assert.equal(input.source, 'INSIDER');
  assert.equal(input.provenance.sheet, 'Tổng hợp Event tracking');
  assert.ok(input.description && input.sample_text);
  await ev(`document.getElementById("ai-api-key").value = ${JSON.stringify(fakeKey)}; document.querySelector("[data-action=ai-save-key]").click()`);
  await wait('document.getElementById("ai-chip").textContent.includes("đã cấu hình") && document.getElementById("ai-api-key").value === ""');
  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.ai.max_free_attempts, 0); assert.equal(state.ai.configured_key_count, 1);
  assert.ok(!JSON.stringify(state).includes(fakeKey));
  assert.ok((await fs.readFile(configFile, 'utf8')).includes(fakeKey));
  const moduleUrl = new URL('../src/ai/openrouter.mjs', import.meta.url).href;
  const restarted = spawnSync(process.execPath, ['--env-file=' + configFile, '--input-type=module', '-e', `import {OpenRouterClient} from ${JSON.stringify(moduleUrl)};process.stdout.write(JSON.stringify(new OpenRouterClient().diagnostics()));`], { encoding: 'utf8', windowsHide: true });
  assert.equal(restarted.status, 0);
  assert.equal(JSON.parse(restarted.stdout).configured_key_count, 1);
  assert.ok(!restarted.stdout.includes(fakeKey));
  await fs.mkdir('runs/portable-ai-smoke', { recursive: true });
  await fs.writeFile('runs/portable-ai-smoke/web-spec-ai.png', Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  assert.equal(await ev('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', webEvents: 168, aiUsesImportedRequirement: true, keySavedLocally: true, keyNotInResponses: true, restartKeepsSettings: true, browserErrors: 0 }));
} finally {
  cdp?.close(); if (browser) await closeOwnedBrowser(browser); await app.close();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
