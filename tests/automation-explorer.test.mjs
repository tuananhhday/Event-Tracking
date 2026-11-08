import test from 'node:test';
import assert from 'node:assert/strict';
import { splitScenario, parseVariables, templatize, summarizeEvents, WorkflowExplorer, looksLikeLogin } from '../src/automation/explorer.mjs';
import { runWorkflow } from '../src/automation/runner.mjs';
import { validateWorkflow, resolveWorkflow, resolveVariables, formatDate } from '../src/automation/schema.mjs';
import { routingCandidates } from '../src/ai/routing.mjs';
import { parseJsonContent } from '../src/ai/openrouter.mjs';

test('scenarios split on BƯỚC headings or numbered lists and keep data lines as variables', () => {
  const file = `LUỒNG: ĐẶT PHÒNG\n\n1. MỤC TIÊU\nĐặt một phòng.\n\n2. DỮ LIỆU\ndestination = Nha Trang\ncheckin = {{date:+14}}\npromotion_code =\n\n3. CÁC BƯỚC\n\nBƯỚC 01 - MỞ HOME\n- Mở trang.\nBƯỚC 02 - TÌM KIẾM\n- Nhập destination.\nMong muốn:\n- Có kết quả.\n\n4. BÁO CÁO\n- Xuất báo cáo.`;
  const scenario = splitScenario(file);
  assert.equal(scenario.title, 'LUỒNG: ĐẶT PHÒNG');
  assert.deepEqual(scenario.variables, { destination: 'Nha Trang', checkin: '{{date:+14}}', promotion_code: '' });
  assert.deepEqual(scenario.steps.map(step => step.name), ['MỞ HOME', 'TÌM KIẾM']);
  assert.match(scenario.steps[1].instructions, /Có kết quả/);
  assert.doesNotMatch(scenario.steps[1].instructions, /BÁO CÁO/, 'a new numbered section ends the last step');
  assert.match(scenario.notes, /BÁO CÁO/); assert.doesNotMatch(scenario.notes, /destination =/);
  const typed = splitScenario('1. Mở trang chủ\n2. Tìm Phú Quốc\n   chờ danh sách\ndestination = Phú Quốc');
  assert.deepEqual(typed.steps.map(step => step.instructions), ['Mở trang chủ', 'Tìm Phú Quốc\n   chờ danh sách']);
  assert.deepEqual(splitScenario('Chỉ một câu mô tả').steps, []);
  assert.deepEqual(parseVariables('a = 1\n a = 2\nnot a line'), { a: '1' });
});

test('recorded literals become templates again, including date picker cells', () => {
  const values = { checkin: '2026-11-22', hotel_name: 'Hòn Tằm Resort', destination: 'Nha Trang', rooms: '1', adults: '1' };
  assert.equal(templatize('22', values, 'checkin'), '{{checkin|D}}');
  assert.equal(templatize('Hòn Tằm Resort', values), '{{hotel_name}}');
  assert.equal(templatize('Nha Trang (Địa điểm)', values, 'destination'), '{{destination}} (Địa điểm)');
  assert.equal(templatize('Nhận phòng 22/11/2026', values), 'Nhận phòng {{checkin|DD/MM/YYYY}}');
  assert.equal(templatize('1', values), '1', 'short ambiguous values stay literal');
  assert.equal(templatize('Tháng 11 năm 2026', values, 'checkin'), '{{checkin|Tháng M năm YYYY}}');
  const resolved = resolveVariables({ checkin: '{{date:+14}}', cell: '{{checkin|D}}', label: '{{date:+14|DD/MM/YYYY}}' }, { now: new Date('2026-11-08T03:00:00Z') });
  assert.deepEqual(resolved, { checkin: '2026-11-22', cell: '22', label: '22/11/2026' });
  assert.throws(() => formatDate('Nha Trang', 'D'), /YYYY-MM-DD/);
  assert.deepEqual(summarizeEvents([{ source: 'GA4', event_name: 'page_view' }, { source: 'GA4', event_name: 'page_view' }, { source: 'INSIDER', event_name: 'search' }]),
    [{ source: 'GA4', event_name: 'page_view', count: 2 }, { source: 'INSIDER', event_name: 'search', count: 1 }]);
});

test('schema accepts recorded actions and leaves scenario prose untouched when resolving', () => {
  const workflow = validateWorkflow({ name: 'A', url: 'https://example.test/', instructions: 'Dùng {{ten_bien}} trong ví dụ', ai_heal: true,
    variables: { hotel: 'Hòn Tằm', checkin: '{{date:+1}}' },
    steps: [{ name: 'S', instructions: 'Ví dụ {{khong_co}}', note: 'ghi chú {{x}}', pending: true, observed_events: [{ source: 'GA4', event_name: 'page_view', count: 1 }], actions: [
      { type: 'type', locator: { by: 'role', role: 'button', value: 'Đặt ngay', exact: true, within: { text: '{{hotel}}' } }, value: '{{checkin|DD/MM/YYYY}}' },
      { type: 'click', locator: { by: 'text', value: 'Đóng' }, optional: true, timeout_ms: 5000 },
      { type: 'hover', locator: { by: 'text', value: 'Menu' } }, { type: 'scroll', direction: 'down' }, { type: 'wait_ms', ms: 500 },
      { type: 'click', locator: { by: 'role', role: 'button', value: 'Xác nhận' }, irreversible: true, note: 'đặt thật' },
    ] }] });
  const resolved = resolveWorkflow(workflow, { now: new Date('2026-11-08T03:00:00Z') });
  assert.equal(resolved.steps[0].actions[0].locator.within.text, 'Hòn Tằm');
  assert.equal(resolved.steps[0].actions[0].value, '09/11/2026');
  assert.equal(resolved.instructions, 'Dùng {{ten_bien}} trong ví dụ');
  assert.equal(resolved.steps[0].instructions, 'Ví dụ {{khong_co}}');
  assert.throws(() => validateWorkflow({ name: 'A', url: 'https://example.test/', steps: [{ name: 'S', actions: [{ type: 'wait_ms', ms: 30001 }] }] }), /30000/);
});

test('automation model preferences are tried first, then other suitable models', () => {
  const model = (id, price = 0.0000001) => ({ id, json_mode: 'json_schema', supported_parameters: ['structured_outputs'], context_length: 100000, max_completion_tokens: null,
    prompt_usd_per_million: price * 1e6, completion_usd_per_million: price * 1e6, request_usd: 0, free: price === 0, reasoning: null });
  const models = [model('tiny/free', 0), model('cheap/tiny', 0.00000001), model('good/flash'), model('other/mini')];
  const options = { inputTokens: 1000, outputTokens: 500, allowPaid: true, maxPromptUsdPerMillion: 1, maxCompletionUsdPerMillion: 1, requestBudgetUsd: 1 };
  assert.deepEqual(routingCandidates(models, { ...options, model: 'other/mini,good/flash,auto' }).map(item => item.id), ['other/mini', 'good/flash', 'tiny/free', 'cheap/tiny']);
  assert.deepEqual(routingCandidates(models, { ...options, model: 'good/flash,missing/model' }).map(item => item.id), ['good/flash']);
  assert.equal(routingCandidates(models, { ...options, model: 'auto' })[0].id, 'tiny/free');
  assert.deepEqual(parseJsonContent('Đây là kết quả:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseJsonContent('không có JSON'), /INVALID_AI_JSON/);
});

function fakeDriver(pages) {
  const executed = [];
  let index = 0;
  return { executed, async snapshot() { return structuredClone(pages[Math.min(index, pages.length - 1)]); },
    async locatorFor(ref) { return { by: 'css', value: `#${ref}` }; },
    async execute(action) { executed.push(action); if (action.locator?.value === '#broken') throw new Error('Không tìm thấy phần tử'); if (action.type === 'click') index++; },
    async settle() {}, url: () => pages[Math.min(index, pages.length - 1)].url };
}
const snapshotPage = (url, elements) => ({ url, title: url, elements, dialogs: [], headings: [], text: '' });
const fullAction = action => ({ ref: '', value: '', variable: '', anchor_text: '', optional: false, irreversible: false, ...action });
function scriptedAi(replies) {
  const inputs = [];
  return { inputs, modelAutomation: 'fake', async complete(model, system, input, schema, validate) {
    // The end-of-step check agrees unless a test says otherwise.
    if (schema.properties?.reached) return { available: true, data: { reason: 'Đạt', reached: true }, routing: { model: 'fake', estimated_cost_usd: 0 } };
    inputs.push(input);
    const reply = typeof replies === 'function' ? replies(input) : replies.shift();
    if (!reply) return { available: false, reason: 'OPENROUTER_TIMEOUT' };
    const data = { ...reply, actions: reply.actions.map(fullAction) };
    const invalid = validate(data);
    if (invalid) return { available: false, reason: invalid };
    return { available: true, data, routing: { model: 'fake', estimated_cost_usd: 0.001 } };
  } };
}

test('exploration records verified locators, fills variables locally and stops before irreversible actions', async () => {
  const driver = fakeDriver([snapshotPage('https://site.test/', [{ ref: 'e1', tag: 'input', name: 'Email' }, { ref: 'e2', tag: 'button', name: 'Xác nhận đặt phòng' }])]);
  const ai = scriptedAi([
    { status: 'act', note: 'Điền email', actions: [{ type: 'fill', ref: 'e1', variable: 'guest_email' }] },
    { status: 'step_done', note: 'Đã điền', actions: [] },
    { status: 'act', note: 'Bấm xác nhận', actions: [{ type: 'click', ref: 'e2' }] },
  ]);
  const explorer = new WorkflowExplorer({ getAi: () => ai, driver });
  const outcome = await explorer.explore({ name: 'Đặt phòng', url: 'https://site.test/', instructions: 'guest_email = qa@example.com\nBƯỚC 1 - ĐIỀN\n- Điền email\nBƯỚC 2 - XÁC NHẬN\n- Bấm xác nhận\nBƯỚC 3 - KẾT QUẢ\n- Xem kết quả' });
  assert.equal(outcome.status, 'STOPPED');
  assert.deepEqual(driver.executed.map(action => action.type), ['goto', 'fill'], 'the final booking click is not executed');
  assert.equal(driver.executed[1].value, 'qa@example.com', 'the real value is typed even though AI only saw the variable name');
  const [fill, confirm, result] = outcome.workflow.steps;
  assert.deepEqual(fill.actions, [{ type: 'fill', locator: { by: 'css', value: '#e1' }, value: '{{guest_email}}' }]);
  assert.equal(fill.pending, undefined);
  assert.equal(confirm.actions[0].irreversible, true, 'final booking names are flagged even without the AI flag');
  assert.equal(confirm.pending, true); assert.equal(result.pending, true); assert.deepEqual(result.actions, []);
  assert.equal(outcome.usage.calls, 4, 'three turns plus the end-of-step check of the finished step');
});

test('exploration reports AI failures, blocked steps and repeated failing actions without hanging', async () => {
  const page = snapshotPage('https://site.test/', [{ ref: 'broken', tag: 'button', name: 'Tìm' }]);
  const blocked = await new WorkflowExplorer({ getAi: () => scriptedAi([{ status: 'blocked', note: 'Cần đăng nhập', actions: [] }]), driver: fakeDriver([page]) })
    .explore({ url: 'https://site.test/', instructions: '1. Tìm\n2. Đặt' });
  assert.equal(blocked.status, 'PARTIAL'); assert.match(blocked.error, /Cần đăng nhập/); assert.equal(blocked.workflow.steps.length, 2);
  const repeatingAi = scriptedAi(() => ({ status: 'act', note: 'Bấm', actions: [{ type: 'click', ref: 'broken' }] }));
  const repeating = await new WorkflowExplorer({ getAi: () => repeatingAi, driver: fakeDriver([page]) })
    .explore({ url: 'https://site.test/', instructions: '1. Tìm\n2. Đặt' });
  assert.equal(repeating.status, 'PARTIAL'); assert.match(repeating.error, /lặp lại/);
  assert.match(repeatingAi.inputs[1].history[0].error, /Không tìm thấy/, 'the AI sees why its previous action failed');
  const offline = await new WorkflowExplorer({ getAi: () => scriptedAi([]), driver: fakeDriver([page]) }).explore({ url: 'https://site.test/', instructions: '1. Tìm\n2. Đặt' });
  assert.equal(offline.status, 'PARTIAL'); assert.match(offline.error, /quá chậm/);
  // A ref that is not on the page is rejected as an invalid reply, so the real client moves on to the next model.
  const invented = await new WorkflowExplorer({ getAi: () => scriptedAi([{ status: 'act', note: 'x', actions: [{ type: 'click', ref: 'e99' }] }]), driver: fakeDriver([page]) })
    .explore({ url: 'https://site.test/', instructions: '1. Tìm\n2. Đặt' });
  assert.equal(invented.status, 'PARTIAL'); assert.match(invented.error, /không có trên trang/);
});

const flow = steps => ({ id: 'WF', name: 'Flow', url: 'https://site.test/', variables: {}, steps });
test('runner skips absent optional popups, lets AI repair failed or pending steps, and reports missing events without stopping', async () => {
  const executed = [];
  const driver = { async execute(action) { executed.push(action.locator?.value ?? action.type); if (['Popup', 'Old button'].includes(action.locator?.value)) throw new Error('Không tìm thấy'); } };
  const assisted = [];
  const assist = async (step, details) => { assisted.push({ step: step.id, reason: details.reason, allow: details.allowIrreversible, done: details.done.length }); return { status: 'DONE', note: 'AI xong', actions: [] }; };
  const missing = Object.assign(new Error('Chưa thấy event mong muốn: purchase.'), { code: 'AUTOMATION_EVENT_TIMEOUT', missing: [{ event_name: 'purchase' }] });
  const result = await runWorkflow(flow([
    { id: 'home', name: 'Home', actions: [{ type: 'click', locator: { by: 'text', value: 'Popup' }, optional: true }, { type: 'click', locator: { by: 'text', value: 'Search' } }] },
    { id: 'book', name: 'Book', actions: [{ type: 'click', locator: { by: 'text', value: 'Old button' } }, { type: 'click', locator: { by: 'text', value: 'Pay' }, irreversible: true }] },
    { id: 'pending', name: 'Pending', pending: true, actions: [], expected_events: [{ event_name: 'purchase' }] },
    { id: 'after', name: 'After', actions: [{ type: 'click', locator: { by: 'text', value: 'Next' } }] },
  ]), { driver, assist, waitForEvents: async () => { throw missing; } });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(executed, ['goto', 'Popup', 'Search', 'Old button', 'Next']);
  assert.equal(result.steps[0].actions[1].status, 'SKIPPED');
  assert.deepEqual(assisted, [{ step: 'book', reason: 'failed', allow: true, done: 0 }, { step: 'pending', reason: 'pending', allow: false, done: 0 }]);
  assert.deepEqual(result.steps[2].missing_events, [{ event_name: 'purchase' }]);
  assert.equal(result.assisted_steps, 2); assert.match(result.warning, /1 bước/);
  const unrecorded = await runWorkflow(flow([{ id: 'pending', name: 'Pending', pending: true, actions: [] }]), { driver });
  assert.equal(unrecorded.status, 'FAILED'); assert.match(unrecorded.error, /chưa được ghi đủ/);
  const unrepaired = await runWorkflow(flow([{ id: 'book', name: 'Book', actions: [{ type: 'click', locator: { by: 'text', value: 'Old button' } }] }]),
    { driver, assist: async () => ({ status: 'BLOCKED', note: 'Hết phòng' }) });
  assert.equal(unrepaired.status, 'FAILED'); assert.match(unrepaired.error, /Không tìm thấy — AI chưa hoàn tất bước: Hết phòng/);
});

test('login pages are recognised for the interactive pause', () => {
  for (const url of ['https://vinpearlota.com/vi/account/auth/login?redirectUrl=x', 'https://id.vinpearlota.com/realms/x', 'https://site.test/dang-nhap', 'https://sso.example.test/']) assert.equal(looksLikeLogin(url), true, url);
  for (const url of ['https://vinpearlota.com/vi', 'https://site.test/hotel/author-pick', 'not a url']) assert.equal(looksLikeLogin(url), false, url);
});

test('interactive exploration waits for the user on a login redirect or a blocked step, then continues', async () => {
  const pages = [snapshotPage('https://site.test/account/auth/login', [{ ref: 'e1', tag: 'button', name: 'Tìm' }])];
  let current = 'https://site.test/account/auth/login';
  const executed = [];
  const driver = { async snapshot() { return { ...structuredClone(pages[0]), url: current }; }, async locatorFor(ref) { return { by: 'css', value: `#${ref}` }; },
    async execute(action) { executed.push(action.type); }, async settle() {}, url: () => current };
  const waits = [];
  const waitForUser = async ({ message }) => { waits.push(message); current = 'https://site.test/'; return driver; };
  const ai = scriptedAi([{ status: 'blocked', note: 'Cần nhập OTP', actions: [] }, { status: 'act', note: 'Bấm', actions: [{ type: 'click', ref: 'e1' }] }, { status: 'step_done', note: 'Xong', actions: [] }]);
  const outcome = await new WorkflowExplorer({ getAi: () => ai, driver, waitForUser }).explore({ url: 'https://site.test/', instructions: 'Tìm khách sạn' });
  assert.equal(outcome.status, 'COMPLETED');
  assert.equal(waits.length, 2);
  assert.match(waits[0], /trang đăng nhập/); assert.match(waits[1], /Cần nhập OTP/);
  assert.deepEqual(executed, ['goto', 'goto', 'click'], 'after logging in the scenario restarts from its first page');
  assert.equal(ai.inputs[1].history.at(-1).result, 'USER_ACTED');
});

test('stopping an exploration keeps the steps and actions already recorded', async () => {
  const controller = new AbortController();
  const page = snapshotPage('https://site.test/', [{ ref: 'e1', tag: 'input', name: 'Email' }]);
  const ai = scriptedAi(input => { if (input.history.length) controller.abort(new Error('Người dùng đã dừng.')); return { status: 'act', note: 'Điền', actions: [{ type: 'fill', ref: 'e1', value: 'Huế' }] }; });
  const outcome = await new WorkflowExplorer({ getAi: () => ({ ...ai, async complete(...args) { const result = await ai.complete(...args); return controller.signal.aborted ? { available: false, reason: 'AI_CANCELLED' } : result; } }),
    driver: fakeDriver([page]), signal: controller.signal }).explore({ url: 'https://site.test/', instructions: '1. Điền\n2. Tìm' });
  assert.equal(outcome.status, 'CANCELLED');
  assert.deepEqual(outcome.workflow.steps.map(step => [step.actions.length, step.pending]), [[1, true], [0, true]]);
});

test('AI repair never presses an already attempted booking button again and waits for the result instead', async () => {
  const driver = fakeDriver([snapshotPage('https://site.test/checkout', [{ ref: 'e1', tag: 'button', name: 'Xác nhận đặt phòng' }])]);
  const ai = scriptedAi([{ status: 'act', note: 'Bấm xác nhận', actions: [{ type: 'click', ref: 'e1', irreversible: true }] }, { status: 'step_done', note: 'Đã có kết quả', actions: [] }]);
  const outcome = await new WorkflowExplorer({ getAi: () => ai, driver }).assistStep({ step: { name: 'Xác nhận', instructions: 'Bấm xác nhận một lần' }, reason: 'pending', allowIrreversible: false });
  assert.equal(outcome.status, 'DONE');
  assert.equal(driver.executed.length, 0, 'the booking button is not clicked a second time');
  assert.equal(ai.inputs[1].history.at(-1).result, 'NOT_ALLOWED');
});

test('an action that already worked twice without finishing the step is refused, and empty turns are rejected', async () => {
  const page = snapshotPage('https://site.test/', [{ ref: 'e1', tag: 'input', name: 'Nhập điểm đến' }, { ref: 'e2', tag: 'button', name: 'Tìm kiếm' }]);
  const looping = scriptedAi(() => ({ status: 'act', note: 'Gõ lại', actions: [{ type: 'type', ref: 'e1', value: 'Nha Trang' }] }));
  const driver = fakeDriver([page]);
  const outcome = await new WorkflowExplorer({ getAi: () => looping, driver }).explore({ url: 'https://site.test/', instructions: '1. Tìm Nha Trang\n2. Chọn khách sạn' });
  assert.equal(outcome.status, 'PARTIAL'); assert.match(outcome.error, /cứ lặp lại/);
  assert.equal(driver.executed.filter(action => action.type === 'type').length, 2, 'the third identical typing is never executed');
  assert.equal(looping.inputs[3].history.at(-1).result, 'REFUSED_REPEAT', 'the AI is told why its repeat was refused');
  assert.equal(looping.inputs[0].upcoming_steps[0].name, 'Chọn khách sạn', 'the AI knows where its step ends');
  const empty = await new WorkflowExplorer({ getAi: () => scriptedAi([{ status: 'act', note: 'Cần bấm tìm kiếm', actions: [] }]), driver: fakeDriver([page]) })
    .explore({ url: 'https://site.test/', instructions: '1. Tìm\n2. Đặt' });
  assert.equal(empty.status, 'PARTIAL'); assert.match(empty.error, /không đưa ra thao tác/);
});
