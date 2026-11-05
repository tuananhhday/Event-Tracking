// Reproduce a startup profile with an existing onboarding-like page. The app
// must create/navigate a different top-level page and leave that page untouched.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser, closeOwnedBrowser } from '../src/browser/launcher.mjs';
import { CDPConnection, listTargets } from '../src/collectors/cdp.mjs';
process.env.EVENTQA_HEADLESS = '1';
const { createApp } = await import('../src/server.mjs');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-start-'));
const site = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<html><head><title>${req.url === '/onboarding' ? 'Startup dialog fixture' : 'Full test page'}</title></head><body><h1>${req.url === '/onboarding' ? 'ONBOARDING' : 'FULL_TEST_PAGE'}</h1></body></html>`); });
const app = await createApp({ port: 0, initialCases: [], runsDir: path.join(directory, 'runs') });
let browser, connection;
try {
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const base = await app.listen();
  browser = await launchBrowser({ port: 19561, headless: true, url: origin + '/onboarding', profileDir: path.join(directory, 'profile') });
  let before;
  for (let attempt = 0; attempt < 30 && !before; attempt++) {
    before = (await listTargets(19561)).find(target => target.url === origin + '/onboarding');
    if (!before) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(before);
  const response = await fetch(base + '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EventQA-Token': app.csrf }, body: JSON.stringify({ url: origin + '/website', debugPort: 19561, browser: 'chrome' }) });
  const state = await response.json(); assert.equal(response.status, 200, JSON.stringify(state)); assert.equal(state.running, true);
  const targets = await listTargets(19561);
  assert.equal(targets.find(target => target.id === before.id)?.url, origin + '/onboarding', 'the startup dialog must not be navigated');
  const page = targets.find(target => target.url === origin + '/website'); assert.ok(page); assert.notEqual(page.id, before.id);
  connection = new CDPConnection(page.webSocketDebuggerUrl); await connection.connect();
  const { frameTree } = await connection.send('Page.getFrameTree');
  assert.equal(frameTree.frame.url, origin + '/website');
  const { result } = await connection.send('Runtime.evaluate', { expression: 'JSON.stringify({text:document.body.innerText,framed:self!==top,width:innerWidth,height:innerHeight})', returnByValue: true });
  const observed = JSON.parse(result.value);
  assert.equal(observed.framed, false); assert.ok(observed.text.includes('FULL_TEST_PAGE')); assert.ok(observed.width >= 700);
  console.log(JSON.stringify({ passed: true, original_page_unchanged: true, navigation_in_top_level_page: true, ...observed }, null, 2));
} finally {
  connection?.close(); await app.close(); if (browser) await closeOwnedBrowser(browser);
  await new Promise(resolve => site.close(resolve)); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
