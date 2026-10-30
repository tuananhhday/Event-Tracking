import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { saveAISettings } from '../src/ai/settings.mjs';
import { createApp } from '../src/server.mjs';

const fakeKey = 'sk-or-v1-local-test-credential-only-123456';

test('local AI settings persist free-first configuration while preserving unrelated settings', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-key-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  await fs.writeFile(file, 'KEEP_SETTING=retained\nOPENROUTER_API_KEY=old-value\nOPENROUTER_MAX_FREE_ATTEMPTS=2\n');
  const settings = await saveAISettings(file, { apiKey: fakeKey, allowPaid: false });
  const saved = parseEnv(await fs.readFile(file, 'utf8'));
  assert.equal(saved.OPENROUTER_API_KEY, fakeKey);
  assert.equal(saved.KEEP_SETTING, 'retained');
  assert.equal(saved.AI_ENABLED, 'true');
  assert.equal(saved.OPENROUTER_MAX_FREE_ATTEMPTS, '0');
  assert.equal(saved.OPENROUTER_ALLOW_PAID, 'false');
  assert.equal(settings.maxFreeAttempts, 0);
  assert.equal(settings.requestBudgetUsd, 0.01);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await assert.rejects(saveAISettings(file, { apiKey: fakeKey + '\nOTHER=oops' }), /định dạng/);
  assert.equal(parseEnv(await fs.readFile(file, 'utf8')).OPENROUTER_API_KEY, fakeKey);
});

test('saving a key requires the local token, activates AI immediately and never exposes the key', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-key-api-'));
  const file = path.join(dir, '.env');
  const app = await createApp({ mode: 'cdp-ai', port: 0, runsDir: path.join(dir, 'runs'), aiConfigPath: file, initialCases: [] });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const post = (token, origin) => fetch(`${base}/api/ai-settings`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-eventqa-token': token, ...(origin ? { origin } : {}) }, body: JSON.stringify({ apiKey: fakeKey, allowPaid: true }) });
  assert.equal((await post('invalid-token')).status, 403);
  assert.equal((await post(app.csrf, 'https://unrelated.example')).status, 403);
  await assert.rejects(fs.access(file));
  const response = await post(app.csrf);
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.ai.enabled, true);
  assert.equal(state.ai.configured_key_count, 1);
  assert.equal(state.ai.max_free_attempts, 0);
  assert.ok(!JSON.stringify(state).includes(fakeKey));
  const freshState = await (await fetch(`${base}/api/state`)).text();
  const html = await (await fetch(base)).text();
  assert.ok(!freshState.includes(fakeKey) && !html.includes(fakeKey));
  assert.equal(parseEnv(await fs.readFile(file, 'utf8')).OPENROUTER_API_KEY, fakeKey);
});
