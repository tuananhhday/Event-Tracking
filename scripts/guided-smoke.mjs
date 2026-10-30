// Full local workflow: real browser/capture, synthetic requirements and AI transport.
// No external websites, API calls, payments or real user data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { CDPConnection, listTargets } from '../src/collectors/cdp.mjs';
import { launchBrowser, closeOwnedBrowser } from '../src/browser/launcher.mjs';
process.env.EVENTQA_HEADLESS = '1';
const { createApp } = await import('../src/server.mjs');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventqa-guided-smoke-'));
const cases = [
  { id: 'GA4-SEARCH', name: 'Tìm sân', flow: 'Golf', source: 'GA4', description: 'Bấm tìm sân golf.', needs_review: true,
    sample: { event: 'search_submit', service: 'golf', destination: 'Sample', quantity: 1 }, rules: [{ event_name: 'search_submit', layer: 'JS_QUEUE', fields: {
      event: { op: 'eq', value: 'search_submit' }, service: { op: 'eq', value: 'golf' },
      destination: { op: 'ref', value: 'context.search.destination_name' }, quantity: { op: 'ref', value: 'context.search.quantity' },
    } }] },
  { id: 'INSIDER-SEARCH', name: 'Tìm sân Insider', flow: 'Golf', source: 'INSIDER', description: 'Bấm tìm sân golf.', needs_review: true,
    sample: { type: 'custom_event', value: [{ event_name: 'search_golf', event_parameters: { custom: { currency: 'VND' } } }] },
    rules: [{ event_name: 'search_golf', layer: 'JS_QUEUE', fields: { type: { op: 'eq', value: 'custom_event' }, 'value.0.event_parameters.custom.currency': { op: 'eq', value: 'VND' } } }] },
  { id: 'CHECKOUT', name: 'Thanh toán', flow: 'Golf', source: 'INSIDER', description: 'Bấm Thanh toán.', needs_review: true,
    sample: { event_name: 'golf_checkout', event_params: { c_total: 100 } }, rules: [{ event_name: 'golf_checkout', layer: 'TRACKING_REQUEST', fields: { 'event_params.c_total': { op: 'ref', value: 'context.checkout.total' } } }] },
  { id: 'FAIL', name: 'Thanh toán lỗi', flow: 'Golf', source: 'GA4', description: 'Nhánh lỗi khi thanh toán.', needs_review: true,
    sample: { event: 'purchase_fail', service: 'golf' }, rules: [{ event_name: 'purchase_fail', layer: 'JS_QUEUE', fields: { event: { op: 'eq', value: 'purchase_fail' } } }] },
  { id: 'UNSELECTED', name: 'Yêu cầu Golf không chọn', flow: 'Golf', source: 'GA4', description: 'Mở ưu đãi riêng.', needs_review: true,
    rules: [{ event_name: 'promotion_view', layer: 'JS_QUEUE', fields: { event: { op: 'eq', value: 'promotion_view' } } }] },
  { id: 'SHARED', name: 'Đăng nhập chung', flow: 'All', source: 'GA4', description: 'Đăng nhập tài khoản.', needs_review: true,
    rules: [{ event_name: 'login', layer: 'JS_QUEUE', fields: { event: { op: 'eq', value: 'login' } } }] },
  { id: 'FLIGHT', name: 'Tìm chuyến bay', flow: 'Flight', source: 'GA4', description: 'Tìm chuyến bay.', needs_review: true,
    rules: [{ event_name: 'search_flight', layer: 'JS_QUEUE', fields: { event: { op: 'eq', value: 'search_flight' } } }] },
];
const selectedIds = ['GA4-SEARCH', 'INSIDER-SEARCH', 'CHECKOUT', 'FAIL', 'SHARED'];
const spec = path.join(dir, 'requirements.json'); await fs.writeFile(spec, JSON.stringify({ cases }));
const ai = { modelSpec: 'auto', diagnostics: () => ({ enabled: true, configured_key_count: 1 }), close() {},
  async complete(_model, _system, input, _schema, validate) {
    assert.deepEqual(input.requirements.map(row => row.id), selectedIds);
    assert.deepEqual(input.requirements.find(row => row.id === 'GA4-SEARCH').events[0].parameter_requirements.destination, { op: 'ref', value: 'context.search.destination_name' });
    const plan = { title: 'Kiểm tra Golf', steps: [
      { title: 'Tìm sân golf', instruction: 'Bấm tìm kiếm sân trên website test.', expected_case_ids: ['GA4-SEARCH', 'INSIDER-SEARCH'] },
      { title: 'Kiểm tra thanh toán', instruction: 'Kiểm tra event thanh toán ở bước này.', expected_case_ids: ['CHECKOUT'] },
      { title: 'Nhánh thanh toán lỗi', instruction: 'Chỉ kiểm tra khi chạy kịch bản lỗi.', expected_case_ids: ['FAIL'], optional: true, branch: 'failure' },
      { title: 'Đăng nhập chung', instruction: 'Đăng nhập theo yêu cầu chung đã chọn.', expected_case_ids: ['SHARED'] },
    ] };
    assert.equal(validate(plan), null); return { available: true, data: plan, routing: { model: 'synthetic/free' } };
  },
  async explain() { return { available: true, note: 'Điểm đến khác giá trị đã chọn; thiếu currency ở event Insider.', routing: { model: 'synthetic/free' } }; },
};
const app = await createApp({ mode: 'cdp-ai', port: 0, runsDir: path.join(dir, 'runs'), initialCases: [], aiClient: ai });
const fixture = http.createServer(async (req, res) => {
  if (['/demo/insider/events', '/demo/g/collect'].some(p => req.url.startsWith(p))) { for await (const chunk of req) {} res.writeHead(204); res.end(); return; }
  res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><button id="search" style="padding:25px;margin:40px">Tìm sân golf</button><script>
    window.dataLayer=[];window.InsiderQueue=[];window.Insider={eventManager:{dispatch(){}}};window.sent=0;
    document.getElementById('search').onclick=async()=>{
      dataLayer.push({event:'search_submit',service:'golf',destination:'HCM',quantity:1});
      InsiderQueue.push({type:'custom_event',value:[{event_name:'search_golf',event_parameters:{custom:{destination:'HCM'}}}]});
      const payload={events:[{event_name:'search_golf',event_params:{c_destination:'HCM',ta:'golf'}}]};
      Insider.eventManager.dispatch('Ucd:event:beforeSend',payload);
      dataLayer.push({event:'unexpected_business',service:'golf'});
      dataLayer.push({event:'promotion_view',service:'golf'});
      await fetch('/demo/g/collect?en=search_submit&ep.service=golf',{method:'POST'});
      await fetch('/demo/insider/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});sent++;
    };</script>`);
});
let browser, ui, site;
const errors = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ev = async (connection, expression) => {
  const response = await connection.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result?.value;
};
async function wait(connection, expression) {
  for (let i = 0; i < 200; i++) {
    try { if (await ev(connection, expression)) return; }
    catch (error) {
      // Page.navigate may replace about:blank's execution context between polls.
      if (!/Execution context was destroyed|Cannot find context|Inspected target navigated/i.test(error.message)) throw error;
    }
    await pause(50);
  }
  throw new Error('Timeout: ' + expression);
}
async function typed(path, value) {
  await ev(ui, `(()=>{const n=[...document.querySelectorAll('[data-context-path]')].find(n=>n.dataset.contextPath===${JSON.stringify(path)});n.value=${JSON.stringify(String(value))};n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
try {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${fixture.address().port}/demo`;
  const base = await app.listen();
  browser = await launchBrowser({ port: 9496, headless: true, url: base + '/guided', profileDir: path.join(dir, 'ui-profile') });
  ui = new CDPConnection((await listTargets(9496))[0].webSocketDebuggerUrl); await ui.connect();
  ui.on('event', message => { if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails); });
  await ui.send('Runtime.enable');
  await ui.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  await wait(ui, '!!document.getElementById("requirement-file")');
  const { root } = await ui.send('DOM.getDocument'); const { nodeId } = await ui.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#requirement-file' });
  await ui.send('DOM.setFileInputFiles', { nodeId, files: [spec] });
  await wait(ui, 'document.getElementById("file-summary").textContent.includes("7 event")');
  assert.equal(await ev(ui, 'document.querySelectorAll("[data-select-case]:checked").length'), 0, 'import does not select requirements for the user');
  assert.equal(await ev(ui, 'document.getElementById("make-plan").disabled'), true);
  await ev(ui, 'document.getElementById("business-flow").value="Golf";document.getElementById("business-flow").dispatchEvent(new Event("change"))');
  await wait(ui, 'document.querySelectorAll("[data-select-case]").length===5');
  await ev(ui, 'document.getElementById("select-visible").click()');
  await ev(ui, 'document.querySelector("[data-select-case=UNSELECTED]").click();document.getElementById("requirement-vendor").value="GA4";document.getElementById("requirement-vendor").dispatchEvent(new Event("change"));document.getElementById("clear-visible").click()');
  assert.ok((await ev(ui, 'document.getElementById("selection-count").textContent')).includes('2'), 'clearing visible rows preserves hidden Insider selections');
  await ev(ui, 'document.getElementById("select-visible").click();document.querySelector("[data-select-case=UNSELECTED]").click();document.getElementById("requirement-vendor").value="";document.getElementById("requirement-vendor").dispatchEvent(new Event("change"));document.getElementById("include-shared").click()');
  assert.equal(await ev(ui, 'document.querySelector("[data-select-case=SHARED]").checked'), false, 'showing common requirements does not select them');
  await ev(ui, 'document.querySelector("[data-select-case=SHARED]").click()');
  assert.ok((await ev(ui, 'document.getElementById("selection-count").textContent')).includes('5'));
  await ev(ui, `document.getElementById('website-url').value=${JSON.stringify(target)};(()=>{const original=window.fetch;window.fetch=(url,init={})=>{if(String(url).endsWith('/api/guided/plan')){const body=JSON.parse(init.body);body.debugPort=9497;init={...init,body:JSON.stringify(body)};}return original(url,init);};})();document.getElementById('make-plan').click()`);
  await wait(ui, '!!document.getElementById("step-action")');
  assert.deepEqual(app.state().guided.plan.selection.selected_case_ids, selectedIds);
  assert.deepEqual(app.state().guided.plan.selection.excluded_case_ids, ['UNSELECTED']);
  assert.deepEqual(app.state().guided.plan.selection.out_of_scope_case_ids, ['FLIGHT']);
  site = new CDPConnection((await listTargets(9497))[0].webSocketDebuggerUrl); await site.connect();
  await wait(site, `location.href === ${JSON.stringify(target)} && document.readyState === 'complete' && typeof document.getElementById('search')?.onclick === 'function'`);
  await wait(site, "!!window[Symbol.for('eventqa.collector.v1')]");
  await typed('search.destination_name', 'Hải Phòng'); await typed('search.quantity', 1);
  await ev(ui, 'document.getElementById("step-action").click()');
  await wait(ui, 'document.getElementById("step-action")?.dataset.stepAction === "complete"');
  const point = await ev(site, '(()=>{const r=document.getElementById("search").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()');
  await site.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await site.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  await wait(site, 'window.sent === 1');
  await ev(ui, 'document.getElementById("step-action").click()');
  await wait(ui, 'document.querySelectorAll(".result-card").length === 1');
  const first = app.state().guided.results[0];
  assert.equal(first.comparisons.find(r => r.source === 'GA4').actual_count, 1);
  assert.equal(first.comparisons.find(r => r.source === 'INSIDER').actual_count, 1);
  assert.ok(first.comparisons.find(r => r.source === 'GA4').wrong_parameters.some(p => p.path === 'destination' && p.actual === 'HCM' && p.expected === 'Hải Phòng'));
  assert.ok(first.comparisons.find(r => r.source === 'INSIDER').missing_parameters.some(p => p.path.endsWith('currency')));
  assert.deepEqual(first.extra_events.map(e => e.event_name), ['unexpected_business']);
  assert.equal(first.observations.find(event => event.event_name === 'promotion_view').scope_status, 'out_of_selection');
  await typed('checkout.total', 100); await ev(ui, 'document.getElementById("step-action").click()');
  await wait(ui, 'document.getElementById("step-action")?.dataset.stepAction === "complete"');
  await ev(ui, 'document.getElementById("step-action").click()');
  await wait(ui, 'document.querySelectorAll(".result-card").length === 2');
  assert.equal(app.state().guided.results[1].status, 'missing');
  await wait(ui, '!!document.getElementById("skip-step")'); await ev(ui, 'document.getElementById("skip-step").click()');
  await wait(ui, 'document.querySelectorAll(".result-card").length === 3');
  assert.equal(app.state().guided.results[2].verdict, 'NOT_EXECUTED');
  const coverage = app.state().guided.completeness;
  assert.equal(coverage.selected, 5); assert.equal(coverage.executed, 3); assert.equal(coverage.skipped, 1); assert.equal(coverage.remaining, 1); assert.equal(coverage.excluded, 1); assert.equal(coverage.out_of_scope, 1); assert.equal(coverage.complete, false);
  assert.equal(coverage.requirements.find(row => row.case_id === 'SHARED').status, 'not_run');
  assert.equal(coverage.requirements.find(row => row.case_id === 'FAIL').status, 'skipped');
  assert.ok(!(await ev(ui, 'document.getElementById("scope-completeness").textContent')).includes('not_run'), 'coverage statuses use understandable labels');
  await ev(ui, 'document.getElementById("finish").click()'); await wait(ui, '!![...document.querySelectorAll("#downloads a")].find(a => a.getAttribute("href").endsWith(".xlsx"))');
  await ui.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
  await ev(ui, '[...document.querySelectorAll("#downloads a")].find(a => a.getAttribute("href").endsWith(".xlsx")).click()');
  for (let i = 0; i < 100 && !(await fs.readdir(dir)).includes('report.xlsx'); i++) await pause(50);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path.join(dir, 'report.xlsx'));
  const text = workbook.worksheets.flatMap(s => s.getSheetValues()).flat(2).join(' ');
  assert.ok(text.includes('search_submit') && text.includes('search_golf') && text.includes('Hải Phòng') && text.includes('HCM'));
  assert.ok(workbook.getWorksheet('Phạm vi kiểm'), 'report includes selected, excluded and unrun scope');
  assert.deepEqual(errors, []);
  await fs.mkdir('runs/guided-smoke', { recursive: true });
  await ev(ui, 'document.getElementById("results-section").scrollIntoView()');
  await fs.writeFile('runs/guided-smoke/results.png', Buffer.from((await ui.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await ui.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  assert.equal(await ev(ui, 'document.documentElement.scrollWidth <= innerWidth'), true);
  console.log(JSON.stringify({ result: 'PASS', realBrowserAndCapture: true, aiTransport: 'synthetic', explicitSelection: true, hiddenSelectionPreserved: true, sharedSelectionExplicit: true, selectedRequirementsOnlySentToAI: true, skippedAndUnrunRemainUnverified: true, wrongParameter: true, missingParameter: true, missingEvent: true, extraEvent: true, unselectedEventNotFailure: true, sourceObservationsNotDuplicates: true, expectedActualReportDownloaded: true, browserErrors: 0 }));
} finally {
  ui?.close(); site?.close(); await app.close(); if (browser) await closeOwnedBrowser(browser);
  await new Promise(resolve => fixture.close(resolve));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
