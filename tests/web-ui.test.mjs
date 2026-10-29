import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function fixture(t, mode) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-ui-'));
  const app = await createApp({ mode, port: 0, runsDir: dir, aiClient: { diagnostics: () => ({ enabled: false, keys: [] }), close() {} } });
  const base = await app.listen();
  t.after(async () => { await app.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { app, base };
}

const screens = { cdp: { mark: '>01<', unique: 'data-attach', absent: 'id="mitmdump"' }, 'cdp-ai': { mark: '>02<', unique: 'data-panel="ai"', absent: 'id="mitmdump"' }, proxy: { mark: '>03<', unique: 'id="mitmdump"', absent: 'data-attach' } };

for (const [mode, expected] of Object.entries(screens)) {
  test(`${mode} serves its own screen with the session token and a strict page policy`, async t => {
    const { app, base } = await fixture(t, mode);
    const response = await fetch(base);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.ok(html.includes(`data-mode="${mode}"`));
    assert.ok(html.includes(expected.mark) && html.includes(expected.unique));
    assert.ok(!html.includes(expected.absent), `${mode} must not show controls of another mode`);
    assert.ok(!html.includes('__CSRF__'));
    // scripts/stop-apps.mjs reads the token with this exact pattern.
    assert.equal(html.match(/const token='([a-f0-9]{48})'/)?.[1], app.csrf);
    for (const id of ['event-count', 'browser', 'debug-port', 'url', 'error', 'sessionbar', 'cases', 'results', 'events']) assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  });
}

test('shared assets are served with their content types and unknown assets are not', async t => {
  const { base } = await fixture(t, 'cdp');
  const css = await fetch(`${base}/assets/eventqa.css`);
  assert.equal(css.status, 200); assert.match(css.headers.get('content-type'), /^text\/css/);
  const js = await fetch(`${base}/assets/eventqa.js`);
  assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /^text\/javascript/);
  assert.match(await js.text(), /window\.EventQA/);
  assert.equal((await fetch(`${base}/assets/../server.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/assets/other.js`)).status, 404);
});

test('state exposes the active step event count for the live recorder', async t => {
  const { app, base } = await fixture(t, 'cdp');
  app.manager.start({ environment: 'UI_FIXTURE' });
  const step = app.manager.startStep(app.manager.cases[0].id, {});
  app.manager.emit({ source: 'GA4', layer: 'JS_QUEUE', event_name: 'search_submit', payload: { event: 'search_submit' } });
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.currentStep.id, step.id);
  assert.equal(state.stepEventCount, 1);
  assert.equal(state.runDir, app.manager.runDir);
  app.manager.completeStep(); app.manager.finish();
});
