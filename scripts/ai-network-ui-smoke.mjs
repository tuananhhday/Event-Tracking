// Exercise the same connection-check and session-review buttons as the user.
// Provider transport failures are simulated; the app and browser run normally.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../src/server.mjs';
import { OpenRouterClient } from '../src/ai/openrouter.mjs';
import { findBrowser } from '../src/browser/launcher.mjs';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-network-ui-'));
let app, browser;
try {
  let failure = 'tls';
  const client = new OpenRouterClient({ enabled: true, apiKey: 'PRIVATE_TEST_KEY', maxRetries: 0, fetch: async () => {
    if (failure === 'tls') throw new TypeError('PRIVATE_PROXY_URL', { cause: Object.assign(new Error('PRIVATE_CERT_DETAIL'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }) });
    throw new TypeError('fetch failed', { cause: new Error(`Proxy response (${failure}) !== 200 when HTTP Tunneling`) });
  } });
  app = await createApp({ mode: 'cdp-ai', port: 0, runsDir: path.join(directory, 'runs'), envPath: path.join(directory, '.env'), aiClient: client });
  const base = await app.listen();
  app.manager.start({ environment: 'LOCAL_NETWORK_UI_FIXTURE' });
  app.manager.emit({ source: 'GA4', layer: 'JS_QUEUE', event_name: 'search_submit', payload: { event: 'search_submit', service: 'hotel' } });
  browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const page = await browser.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.getByRole('tab', { name: /Trợ lý AI/ }).click();
  await page.getByRole('button', { name: 'Kiểm tra kết nối AI', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('ai-check').textContent.includes('chứng chỉ'));
  await page.evaluate(() => EventQA.refresh());
  assert.ok((await page.locator('#ai-status').textContent()).includes('AI chưa kết nối được'));
  await page.locator('#ai-review').click();
  await page.waitForFunction(() => document.getElementById('ai-review-output').textContent.includes('chứng chỉ'));
  for (const status of ['407', '403']) {
    failure = status;
    await page.getByRole('button', { name: 'Kiểm tra kết nối AI', exact: true }).click();
    await page.waitForFunction(code => document.getElementById('ai-check').textContent.includes(code), status);
  }
  const text = await page.locator('body').textContent();
  for (const secret of ['PRIVATE_TEST_KEY', 'PRIVATE_PROXY_URL', 'PRIVATE_CERT_DETAIL']) assert.equal(text.includes(secret), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', provider: 'SIMULATED_FAILURES', connectionCheck: true, sessionReview: true, tlsExplained: true, proxy403Explained: true, proxy407Explained: true, noSecretsDisplayed: true }, null, 2));
} finally {
  await browser?.close(); await app?.close();
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(directory).startsWith('eventqa-network-ui-'));
  await fs.rm(directory, { recursive: true, force: true });
}
