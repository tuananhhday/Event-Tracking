// Browser smoke for AI exploration against local fixtures only: a scripted stand-in
// for the AI chooses elements from real page snapshots, the recorded workflow is then
// replayed by Playwright, and a changed button is repaired at run time.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser, createTestPage, closeOwnedBrowser } from '../src/browser/launcher.mjs';
import { connectAutomationBrowser } from '../src/automation/playwright.mjs';
import { runWorkflow } from '../src/automation/runner.mjs';
import { resolveWorkflow } from '../src/automation/schema.mjs';
import { WorkflowExplorer, STEP_SCHEMA } from '../src/automation/explorer.mjs';
import { OpenRouterClient } from '../src/ai/openrouter.mjs';
import Ajv from 'ajv';

// EVENTQA_SMOKE_AI=openrouter drives the same local fixtures with the configured
// OpenRouter model instead of the scripted stand-in (uses credits; run with --env-file=.env).
const realAi = process.env.EVENTQA_SMOKE_AI === 'openrouter' ? new OpenRouterClient() : null;

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-explore-'));
const browserName = process.env.EVENTQA_SMOKE_BROWSER || 'chrome';
let bookings = 0, variant = 'v1', browser, driver;
const page = (title, body) => `<!doctype html><html lang="vi"><meta charset="utf-8"><title>${title}</title><body>${body}</body></html>`;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  response.setHeader('content-type', 'text/html; charset=utf-8');
  // Like the real site: without a session the home page redirects to the login page.
  if (url.pathname === '/' && !/(^|;\s*)auth=1/.test(request.headers.cookie || '')) { response.writeHead(302, { location: '/account/auth/login?redirectUrl=%2F' }); response.end(); }
  else if (url.pathname === '/account/auth/login') response.end(page('Đăng nhập', `<h1>Đăng nhập</h1><input type="password" aria-label="Mật khẩu">
    <button onclick="document.cookie='auth=1; path=/'; location.href='/'">Đăng nhập</button>`));
  else if (url.pathname === '/') response.end(page('Trang chủ', `
    <style>#intro{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center}#intro div{background:#fff;padding:20px}.sugg{cursor:pointer;padding:4px}</style>
    <div id="intro"><div><p>Chào mừng bạn</p><button aria-label="Đóng">×</button></div></div>
    <header><input placeholder="Tìm kiếm nhanh" aria-label="Tìm trên thanh điều hướng"></header>
    <section><label for="dest">Bạn muốn đi đâu?</label><input id="dest" autocomplete="off"><div id="list"></div><button id="go">Tìm kiếm</button></section>
    <script>
      document.querySelector('#intro button').onclick = () => document.getElementById('intro').remove();
      const input = document.getElementById('dest'), list = document.getElementById('list'); let chosen = '';
      input.addEventListener('input', () => { list.innerHTML = ''; if (input.value.length < 2) return;
        for (const [name, type] of [[input.value + ' (Địa điểm)', 'loc'], ['Khách sạn ' + input.value, 'hotel']]) {
          const item = document.createElement('div'); item.className = 'sugg'; item.textContent = name;
          item.onclick = () => { chosen = type === 'loc' ? input.value : ''; input.value = name.replace(' (Địa điểm)', ''); list.innerHTML = ''; }; list.appendChild(item); } });
      document.getElementById('go').onclick = () => { if (chosen) location.href = '/listing?dest=' + encodeURIComponent(chosen); };
    </script>`));
  else if (url.pathname === '/listing') response.end(page('Danh sách', `<h1>Khách sạn tại ${url.searchParams.get('dest')}</h1>
    ${['Vinpearl Resort', 'Hòn Tằm Resort', 'Melia Nha Trang'].map(name => `<div class="card"><h3>${name}</h3><p>Nha Trang</p><a href="/detail?h=${encodeURIComponent(name)}" target="_blank">Xem chi tiết</a></div>`).join('')}`));
  else if (url.pathname === '/detail') {
    const label = variant === 'v1' ? 'Đặt ngay' : 'Chọn phòng';
    response.end(page(url.searchParams.get('h'), `<h1>${url.searchParams.get('h')}</h1><div class="room"><h2>Deluxe</h2>
      <div class="rate"><p>Giá tiêu chuẩn</p><p>2.000.000 đ</p><button onclick="location.href='/checkout?r=std'">${label}</button></div>
      <div class="rate"><p>[VGRBIZ] Ưu đãi CBNV Vingroup công tác</p><p>1.599.000 đ</p><button onclick="location.href='/checkout?r=vgr'">${label}</button></div></div>`));
  } else if (url.pathname === '/checkout') response.end(page('Thanh toán', `<h1>Thanh toán</h1><p id="plan">Gói: ${url.searchParams.get('r')}</p>
    <label>Họ và tên<input name="fullname"></label><label>Email<input type="email" name="email"></label><label>Số điện thoại<input name="phone"></label>
    <div><label><input type="radio" name="pm" value="card" style="opacity:0;position:absolute"> Thẻ quốc tế</label><label><input type="radio" name="pm" value="cash" style="opacity:0;position:absolute"> Tiền mặt</label></div>
    <button id="confirm">Xác nhận đặt phòng</button><p id="err"></p>
    <script>document.getElementById('confirm').onclick = async () => {
      const value = name => document.querySelector('[name=' + name + ']').value, pm = document.querySelector('[name=pm]:checked')?.value;
      if (!value('fullname') || !value('email').includes('@') || !value('phone') || pm !== 'cash') { document.getElementById('err').textContent = 'Thiếu thông tin'; return; }
      await fetch('/book', { method: 'POST', body: JSON.stringify({ plan: '${url.searchParams.get('r')}', email: value('email') }) }); location.href = '/success';
    };</script>`));
  else if (url.pathname === '/book' && request.method === 'POST') { for await (const chunk of request) void chunk; bookings++; response.end('ok'); }
  else if (url.pathname === '/calendar') response.end(page('Lịch', `<button id="open" aria-expanded="false">Ngày đi</button>
    ${Array.from({ length: 40 }, (_, index) => `<a href="/footer/${index}">Liên kết ${index}</a>`).join(' ')}
    <script>document.getElementById('open').onclick = () => { const grid = document.createElement('table'); grid.setAttribute('role', 'grid');
      grid.innerHTML = '<tr>' + Array.from({ length: 30 }, (_, day) => '<td role="gridcell"><button aria-label="Ngày ' + (day + 1) + ' tháng 11">' + (day + 1) + '</button></td>').join('') + '</tr>';
      document.body.appendChild(grid); };</script>`));
  else if (url.pathname === '/success') response.end(page('Kết quả', '<h1>Đặt phòng thành công</h1><p>Mã đặt phòng: BK123</p>'));
  else { response.writeHead(404); response.end('missing'); }
});

const scenario = `LUỒNG: SMOKE ĐẶT PHÒNG
website_url = placeholder
destination = Nha Trang
hotel_name = Hòn Tằm Resort
rate_plan_name = [VGRBIZ] Ưu đãi CBNV Vingroup công tác
guest_full_name = Nguyễn Văn Test
guest_email = eventqa@example.com
guest_phone = 0900000000
checkin = {{date:+14}}

BƯỚC 01 - MỞ HOME
- Mở trang và đóng popup giới thiệu nếu có.
BƯỚC 02 - TÌM ĐỊA ĐIỂM
- Gõ destination, chọn gợi ý loại địa điểm, bấm Tìm kiếm.
BƯỚC 03 - CHỌN KHÁCH SẠN
- Bấm Xem chi tiết của đúng hotel_name.
BƯỚC 04 - CHỌN PHÒNG VÀ RATE PLAN
- Bấm Đặt ngay trong card rate_plan_name.
BƯỚC 05 - ĐIỀN THÔNG TIN
- Điền họ tên, email, số điện thoại.
BƯỚC 06 - CHỌN TIỀN MẶT
- Chọn phương thức Tiền mặt.
BƯỚC 07 - XÁC NHẬN ĐẶT PHÒNG
- Bấm Xác nhận đặt phòng một lần và chờ trang kết quả.
BƯỚC 08 - KIỂM TRA KẾT QUẢ
- Trang báo đặt phòng thành công.`;

/** Scripted stand-in for the model: it only sees what the real client would send. */
const validateStep = new Ajv({ strict: false }).compile(STEP_SCHEMA);
const calls = [];
const fakeAi = { modelAutomation: 'fake', async complete(model, system, input, schema, validateOutput) {
  if (schema.properties?.reached) return { available: true, data: { reason: 'Đạt', reached: true }, routing: { model: 'fake', estimated_cost_usd: 0 } };
  const { step, page: snap, mode, history = [] } = input;
  const find = (predicate) => snap.elements.find(predicate);
  const byName = (name, extra = () => true) => find(item => item.name === name && extra(item));
  const full = action => ({ ref: '', value: '', variable: '', anchor_text: '', optional: false, irreversible: false, ...action });
  const done = (note, actions = []) => ({ note, status: 'step_done', actions: actions.map(full) });
  const act = (note, actions) => ({ note, status: 'act', actions: actions.map(full) });
  let data;
  const name = step.name;
  if (name.includes('MỞ HOME')) data = byName('Đóng') ? act('Đóng popup', [{ type: 'click', ref: byName('Đóng').ref, optional: true }]) : done('Trang chủ đã sẵn sàng');
  else if (name.includes('TÌM ĐỊA ĐIỂM')) {
    const suggestion = find(item => item.name === 'Nha Trang (Địa điểm)');
    if (snap.url.includes('/listing')) data = done('Đã vào listing');
    else if (suggestion) data = act('Chọn gợi ý địa điểm rồi tìm', [{ type: 'click', ref: suggestion.ref, variable: 'destination' }, { type: 'click', ref: byName('Tìm kiếm', item => item.tag === 'button').ref }]);
    else data = act('Gõ điểm đến', [{ type: 'type', ref: byName('Bạn muốn đi đâu?').ref, variable: 'destination' }]);
  } else if (name.includes('CHỌN KHÁCH SẠN')) {
    if (snap.url.includes('/detail')) data = done('Đã mở trang chi tiết');
    else data = act('Bấm xem chi tiết', [{ type: 'click', ref: find(item => item.name === 'Xem chi tiết' && item.context?.includes('Hòn Tằm Resort')).ref, anchor_text: 'Hòn Tằm Resort', variable: 'hotel_name' }]);
  } else if (name.includes('CHỌN PHÒNG')) {
    if (snap.url.includes('/checkout')) data = done('Đã sang checkout');
    else {
      const button = find(item => item.tag === 'button' && item.context?.includes('[VGRBIZ]'));
      data = act(mode === 'repair' ? 'Nút đã đổi tên, bấm nút mới' : 'Bấm đặt gói VGRBIZ', [{ type: 'click', ref: button.ref, anchor_text: '[VGRBIZ] Ưu đãi CBNV Vingroup công tác', variable: 'rate_plan_name' }]);
    }
  } else if (name.includes('ĐIỀN THÔNG TIN')) data = done('Đã điền', [
    { type: 'fill', ref: byName('Họ và tên').ref, variable: 'guest_full_name' }, { type: 'fill', ref: byName('Email').ref, variable: 'guest_email' }, { type: 'fill', ref: byName('Số điện thoại').ref, variable: 'guest_phone' }]);
  else if (name.includes('TIỀN MẶT')) data = done('Chọn tiền mặt', [{ type: 'click', ref: byName('Tiền mặt').ref }]);
  else if (name.includes('XÁC NHẬN')) data = snap.url.includes('/success') ? done('Đã có trang kết quả') : history.at(-1)?.result === 'NOT_ALLOWED' ? act('Chờ trang kết quả', [{ type: 'wait_ms', value: '1000' }])
    : act('Bấm xác nhận', [{ type: 'click', ref: byName('Xác nhận đặt phòng').ref, irreversible: true }]);
  else if (name.includes('KIỂM TRA')) data = done('Thành công');
  else data = { note: 'unknown', status: 'blocked', actions: [] };
  assert.ok(validateStep(data), JSON.stringify(validateStep.errors));
  assert.equal(validateOutput(data), null);
  calls.push({ step: name, mode, actions: data.actions.length, history: history.length });
  return { available: true, data, routing: { model: 'fake', estimated_cost_usd: 0 } };
} };

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, port = await freePort();
  browser = await launchBrowser({ browser: browserName, port, headless: true, profileDir: path.join(directory, 'profile') });
  const targetId = await createTestPage({ port, headless: true, reuse: 'startup' });
  driver = await connectAutomationBrowser({ port, targetId });
  const progress = [], ai = realAi ?? fakeAi, waits = [];
  // The app lets go of the tab while the user logs in, then reconnects.
  const waitForUser = async ({ message }) => {
    waits.push(message);
    await driver.disconnect();
    const user = await connectAutomationBrowser({ port, targetId });
    await user.execute({ type: 'click', locator: { by: 'role', role: 'button', value: 'Đăng nhập', exact: true } });
    await user.disconnect();
    driver = await connectAutomationBrowser({ port, targetId });
    return driver;
  };
  const explorer = new WorkflowExplorer({ getAi: () => ai, driver, observeEvents: () => [], waitForUser,
    onProgress: event => { progress.push(event); if (realAi && event.message) console.log(`[${event.type}] ${event.message}${event.actions?.length ? ` → ${event.actions.join('; ')}` : ''}`); } });
  const explored = await explorer.explore({ name: 'Smoke', url: `${origin}/`, browser: browserName, instructions: scenario.replace('placeholder', `${origin}/`), allowIrreversible: false });
  assert.equal(explored.status, 'STOPPED', JSON.stringify({ error: explored.error, progress: progress.slice(-6) }, null, 2));
  assert.equal(bookings, 0, 'exploration must not submit the booking without permission');
  assert.equal(waits.length, 1); assert.match(waits[0], /trang đăng nhập/);
  const workflow = explored.workflow, steps = Object.fromEntries(workflow.steps.map(step => [step.id, step]));
  assert.equal(workflow.steps.length, 8);
  if (realAi) console.log(JSON.stringify({ usage: explored.usage, steps: workflow.steps.map(step => ({ name: step.name, pending: step.pending, actions: step.actions })) }, null, 1));
  if (!realAi) {
  assert.deepEqual(workflow.steps.map(step => Boolean(step.pending)), [false, false, false, false, false, false, true, true]);
  assert.equal(steps['step-1'].actions[0].optional, true);
  assert.equal(steps['step-2'].actions[0].type, 'type'); assert.equal(steps['step-2'].actions[0].value, '{{destination}}');
  assert.match(steps['step-2'].actions[1].locator.value, /\{\{destination\}\}/);
  assert.equal(steps['step-3'].actions[0].locator.within?.text, '{{hotel_name}}');
  assert.equal(steps['step-4'].actions[0].locator.within?.text, '{{rate_plan_name}}');
  assert.deepEqual(steps['step-5'].actions.map(action => action.value), ['{{guest_full_name}}', '{{guest_email}}', '{{guest_phone}}']);
  assert.equal(steps['step-7'].actions[0].irreversible, true);
  assert.ok(steps['step-7'].actions[0].locator, 'the final button is recorded with a verified locator even though it was not pressed');
  }

  // Replay without AI repair first for the recorded steps, then with AI for the pending ones.
  const assist = (step, details) => new WorkflowExplorer({ getAi: () => ai, driver, signal: details.signal })
    .assistStep({ step, index: details.index, total: resolved.steps.length, values: resolved.variables, reason: details.reason, error: details.error, done: details.done, allowIrreversible: details.allowIrreversible });
  const resolved = resolveWorkflow(workflow);
  const replay = await runWorkflow(resolved, { driver, assist, screenshotDir: path.join(directory, 'shots') });
  assert.equal(replay.status, 'COMPLETED', JSON.stringify(replay.steps.map(step => [step.name, step.status, step.error]), null, 2));
  assert.equal(bookings, 1, 'the recorded booking click runs exactly once on replay');
  assert.equal(replay.steps[7].assisted?.status, 'DONE');

  // The website renames its buttons: the recorded click fails and AI repairs the step.
  variant = 'v2';
  const changed = structuredClone(resolved);
  for (const action of changed.steps[3].actions) action.timeout_ms = 3000;
  assert.ok(changed.steps[3].actions.some(action => /Đặt ngay/.test(action.locator?.value ?? '')), 'step 4 clicks the recorded “Đặt ngay” button');
  const repaired = await runWorkflow(changed, { driver, assist, screenshotDir: path.join(directory, 'shots') });
  assert.equal(repaired.status, 'COMPLETED', JSON.stringify(repaired.steps.map(step => [step.name, step.status, step.error]), null, 2));
  assert.equal(repaired.steps[3].assisted?.reason, 'failed');
  assert.equal(bookings, 2);

  // Without AI the same change fails fast with a readable reason and a screenshot.
  const failed = await runWorkflow(changed, { driver, screenshotDir: path.join(directory, 'shots') });
  assert.equal(failed.status, 'FAILED');
  assert.match(failed.steps[3].error, /Không tìm thấy|Có .* nhưng/);
  assert.match(failed.steps[3].error, /Đặt ngay/);
  assert.ok(failed.steps[3].screenshot && (await fs.stat(failed.steps[3].screenshot)).size > 1000, 'a failed step keeps its screenshot');

  // A calendar opened at the end of the page: each day is listed once (the button, not
  // its cell) and, being new, ahead of the 40 links that were already there.
  await driver.execute({ type: 'goto', url: `${origin}/calendar` });
  await driver.snapshot();
  await driver.execute({ type: 'click', locator: { by: 'role', role: 'button', value: 'Ngày đi', exact: true } });
  await driver.settle({ ms: 300 });
  const calendar = await driver.snapshot();
  assert.equal(calendar.elements.filter(item => item.tag === 'td').length, 0, 'a cell wrapping its day button is not listed twice');
  const days = calendar.elements.filter(item => /^Ngày \d+ tháng 11$/.test(item.name));
  assert.equal(days.length, 30); assert.ok(days.every(item => item.new), 'controls that just appeared are flagged new');
  assert.ok(calendar.elements.findIndex(item => item.name === 'Ngày 1 tháng 11') < calendar.elements.findIndex(item => item.name === 'Liên kết 0'), 'new controls are listed first');
  console.log(JSON.stringify({ result: 'PASS', explored: explored.status, recordedSteps: workflow.steps.length, aiCalls: calls.length,
    replay: replay.status, repaired: repaired.status, bookings, failureMessage: failed.steps[3].error,
    locators: workflow.steps.flatMap(step => step.actions.map(action => action.locator && JSON.stringify(action.locator))).filter(Boolean) }, null, 2));
} finally {
  await driver?.disconnect().catch(() => {});
  if (browser) await closeOwnedBrowser(browser);
  await new Promise(resolve => server.close(resolve));
  const target = path.resolve(directory), temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
  assert.ok(target.startsWith(temporaryRoot) && path.basename(target).startsWith('eventqa-explore-'));
  await fs.rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
