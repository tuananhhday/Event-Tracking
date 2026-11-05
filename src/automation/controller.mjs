import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkflowStore } from './store.mjs';
import { DailyScheduler } from './scheduler.mjs';
import { validateWorkflow, resolveWorkflow } from './schema.mjs';
import { connectAutomationBrowser } from './playwright.mjs';
import { runWorkflow } from './runner.mjs';
import { draftWorkflow } from '../ai/workflow.mjs';
import { redact } from '../core/privacy.mjs';

export class AutomationController {
  constructor({ directory, manager, getAi, capture, openInspection, finish, exportReport, onStatus = () => {},
    isAvailable = () => true, connectDriver = connectAutomationBrowser, now = () => new Date(), intervalMs = 30000 } = {}) {
    Object.assign(this, { manager, getAi, capture, openInspection, finish, exportReport, onStatus, isAvailable, connectDriver, now });
    this.store = new WorkflowStore(directory); this.run = null; this.task = null; this.closed = false; this.inspection = null;
    this.scheduler = new DailyScheduler({ getWorkflows: () => this.store.list(), now, intervalMs,
      enqueue: (ids, meta) => this.busy || this.manager.session?.status === 'RUNNING' || !this.isAvailable() ? { accepted: false } : this.enqueue(ids, meta),
      getLastScheduledDate: id => this.store.getLastScheduledDate(id), recordScheduledDate: (id, date) => this.store.recordScheduledDate(id, date),
      onError: error => onStatus(`Lịch tự động: ${error.message}`) });
  }
  get busy() { return Boolean(this.task); }
  async load() { await this.store.load(); }
  startScheduler() { if (!this.closed) this.scheduler.start(); }
  state() {
    return { workflows: this.store.list(), run: this.run ? redact(this.run) : null, history: this.store.history(30), busy: this.busy,
      session_running: this.manager.session?.status === 'RUNNING', cases: this.manager.cases.map(testCase => ({ id: testCase.id, name: testCase.name, flow: testCase.flow,
        source: testCase.source, event_names: testCase.rules.map(rule => rule.event_name) })) };
  }
  async save(input) { await this.store.save(validateWorkflow(input)); return this.state(); }
  async saveMany(input) { const saved = await this.store.saveMany(input); return { ...this.state(), saved_ids: saved.map(workflow => workflow.id) }; }
  async delete(id) { await this.store.delete(String(id)); return this.state(); }
  async inspect({ url, browser = 'chrome' } = {}) {
    if (this.busy || this.manager.session?.status === 'RUNNING') throw new Error('Kết thúc phiên đang chạy trước khi quan sát trang tạo luồng.');
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Website phải dùng HTTP hoặc HTTPS.');
    const connection = await this.openInspection({ url: target.toString(), browser });
    const driver = await this.connectDriver(connection);
    try {
      await driver.execute({ type: 'goto', url: target.toString(), timeout_ms: 30000 });
      const page = await driver.inspect();
      this.inspection = { url: target.toString(), page };
      return { page };
    } finally { await driver.disconnect(); }
  }
  async draft(input) {
    if (this.busy || this.manager.session?.status === 'RUNNING') throw new Error('Kết thúc phiên đang chạy trước khi lập luồng mới.');
    const reason = this.getAi()?.unavailable?.();
    if (reason) return { available: false, reason };
    if (input.autoInspect) await this.inspect(input);
    const page = (this.inspection?.url === String(input.url) || this.inspection?.url === (() => { try { return new URL(input.url).toString(); } catch { return ''; } })())
      ? this.inspection.page : null;
    if (input.autoInspect && !page?.controls?.length) return { available: false, reason: 'PAGE_NO_CONTROLS', message: 'Chưa đọc được ô nhập hoặc nút bấm trên website. Kiểm tra trang trong cửa sổ test, hoàn tất đăng nhập nếu cần, rồi lập kế hoạch lại.' };
    return draftWorkflow(this.getAi(), { ...input, page, cases: this.manager.cases });
  }
  async enqueue(ids, { variables = {}, aiNotes = false, trigger = 'manual', scheduled_date, exportReport } = {}) {
    if (this.closed) throw new Error('Ứng dụng đang dừng.');
    if (this.busy || this.manager.session?.status === 'RUNNING') throw new Error('Đang có phiên chạy. Kết thúc hoặc dừng phiên đó trước.');
    if (!Array.isArray(ids) || !ids.length || ids.length > 50) throw new Error('Chọn từ 1 đến 50 luồng để chạy.');
    const uniqueIds = [...new Set(ids)], workflows = [], failures = [];
    for (const id of uniqueIds) {
      const saved = this.store.get(id);
      try {
        if (!saved) throw new Error(`Không tìm thấy luồng ${id}.`);
        const workflow = resolveWorkflow(saved, { now: this.now(), variables });
        for (const step of workflow.steps) {
          const testCase = step.case_id && this.manager.cases.find(candidate => candidate.id === step.case_id);
          if (step.case_id && !testCase) throw new Error(`Bước “${step.name}” tham chiếu case không còn tồn tại: ${step.case_id}.`);
          if (!step.expected_events?.length && testCase) step.expected_events = testCase.rules.filter(rule => (rule.count?.min ?? 1) > 0)
            .map(rule => ({ event_name: rule.event_name, source: rule.source ?? testCase.source, layer: rule.layer }));
        }
        workflows.push(workflow);
      } catch (error) {
        if (trigger !== 'schedule') throw error;
        failures.push({ workflow_id: id, name: saved?.name ?? id, status: 'FAILED', steps: [], error: redact(String(error.message || error)) });
      }
    }
    if (new Set(workflows.map(workflow => workflow.browser)).size > 1) throw new Error('Các luồng trong cùng lượt chạy cần chọn cùng Chrome hoặc cùng Edge.');
    this.abortController = new AbortController();
    this.run = { id: `AUTO-${randomUUID()}`, status: 'RUNNING', trigger, scheduled_date, workflow_ids: uniqueIds,
      workflow_names: uniqueIds.map(id => this.store.get(id)?.name ?? id), started_at: this.now().toISOString(), results: failures, progress: [],
      ...(failures.length ? { error: failures.map(failure => `${failure.name}: ${failure.error}`).join('\n') } : {}) };
    const task = this.execute(workflows, { aiNotes, exportReport: exportReport ?? workflows.some(workflow => workflow.export_report !== false), signal: this.abortController.signal });
    this.task = task;
    task.catch(error => this.onStatus(`Luồng tự động: ${error.message}`)).finally(() => { if (this.task === task) this.task = null; });
    return { accepted: true, ...this.state() };
  }
  progress(event) {
    if (!this.run) return;
    this.run.progress.push(redact({ ...event, at: this.now().toISOString() }));
    if (this.run.progress.length > 200) this.run.progress.shift();
    if (event.workflow_id) this.run.current_workflow_id = event.workflow_id;
    if (event.step_id) this.run.current_step_id = event.step_id;
  }
  async execute(workflows, { aiNotes, exportReport, signal }) {
    let driver, captureStarted = false, stepStartedAt = 0;
    const previousSession = this.manager.session?.id;
    const run = this.run;
    try {
      if (!workflows.length) { run.status = 'FAILED'; return run; }
      const connection = await this.capture(workflows[0]); captureStarted = true;
      run.session_id = this.manager.session.id;
      this.manager.session.automation_run_id = run.id;
      for (const workflow of workflows) {
        if (signal.aborted) break;
        this.progress({ type: 'workflow-start', workflow_id: workflow.id, message: `Đang chạy ${workflow.name}` });
        try {
          driver = await this.connectDriver({ ...connection, signal });
          const result = await runWorkflow(workflow, { driver, signal, screenshotDir: path.join(this.manager.runDir, 'automation-screenshots'),
          onProgress: event => this.progress(event),
          onStepStart: step => {
            stepStartedAt = Date.now();
            if (step.case_id) this.manager.startStep(step.case_id, step.context ?? {});
          },
          onStepComplete: (_step, result) => {
            if (this.manager.currentStep) result.qa_verdict = this.manager.completeStep().verdict;
          },
          onStepError: (step, error, { result } = {}) => {
            if (this.manager.currentStep) {
              const actionsCompleted = result?.actions?.length && result.actions.every(action => action.status === 'COMPLETED');
              if (!signal.aborted && (error.code === 'AUTOMATION_EVENT_TIMEOUT' || actionsCompleted && step.expected_events?.length)) this.manager.completeStep();
              else this.manager.interruptStep();
            }
          },
          waitForEvents: async (expected, { timeoutMs = 15000, signal: stepSignal } = {}) => {
            const deadline = Date.now() + Math.min(30000, Math.max(1, timeoutMs - 150));
            while (true) {
              stepSignal?.throwIfAborted(); signal.throwIfAborted();
              const observed = this.manager.store?.events() ?? [];
              const missing = expected.filter(item => !observed.some(event => !event.historical && Date.parse(event.captured_at) >= stepStartedAt
                && (!event.page?.target_id || event.page.target_id === connection.targetId)
                && event.event_name === item.event_name && (!item.source || event.source === item.source)
                && event.layer === (item.layer ?? 'TRACKING_REQUEST') && (!event.network?.phase || event.network.phase === 'request')));
              if (!missing.length) return;
              if (Date.now() >= deadline) throw Object.assign(new Error(`Chưa thấy event mong muốn: ${missing.map(item => item.event_name).join(', ')}.`), { code: 'AUTOMATION_EVENT_TIMEOUT' });
              await delay(100, undefined, { signal: stepSignal ?? signal });
            }
          } });
          run.results.push({ ...result, name: workflow.name });
        } catch (error) {
          run.results.push({ workflow_id: workflow.id, name: workflow.name, status: signal.aborted ? 'CANCELLED' : 'FAILED', steps: [], error: redact(String(error.message || error)) });
        } finally { await driver?.disconnect().catch(() => {}); driver = null; }
      }
      run.status = signal.aborted ? 'CANCELLED' : run.results.some(result => result.status !== 'COMPLETED') ? 'FAILED' : 'COMPLETED';
      if (!signal.aborted) await delay(500);
    } catch (error) {
      run.status = signal.aborted ? 'CANCELLED' : 'FAILED'; run.error = redact(String(error.message || error));
      if (this.manager.currentStep) this.manager.interruptStep();
    } finally {
      try { await driver?.disconnect(); } catch { /* Collector has an independent connection. */ }
      run.completed_at = this.now().toISOString();
      if (this.manager.session?.id && this.manager.session.id !== previousSession) { captureStarted = true; run.session_id = this.manager.session.id; }
      if (captureStarted || this.manager.session?.automation_run_id === run.id) {
        try {
          await this.finish();
          const evidence = path.join(this.manager.runDir, 'workflow-results.json');
          await fs.writeFile(evidence, JSON.stringify(redact(run), null, 2), 'utf8');
          if (exportReport && run.export_report !== false) run.reports = await this.exportReport({ aiNotes: aiNotes === true && !signal.aborted });
          run.run_dir = this.manager.runDir;
          await fs.writeFile(evidence, JSON.stringify(redact(run), null, 2), 'utf8');
        } catch (error) { run.error = `Đã lưu bằng chứng; xuất báo cáo gặp lỗi: ${redact(String(error.message || error))}`; run.status = run.status === 'CANCELLED' ? run.status : 'FAILED'; }
      }
      await this.store.recordRun(redact(run));
      this.onStatus(`Luồng tự động ${run.status === 'COMPLETED' ? 'đã chạy xong' : run.status === 'CANCELLED' ? 'đã dừng' : 'có lỗi'}; xem kết quả và báo cáo.`);
    }
    return run;
  }
  cancel({ exportReport } = {}) { if (this.busy) { if (exportReport === false) this.run.export_report = false; this.run.cancel_requested = true; this.abortController.abort(new Error('Người dùng đã dừng luồng.')); } return this.state(); }
  async wait() { if (this.task) await this.task; }
  async close() { this.closed = true; this.scheduler.stop(); this.cancel(); await this.wait(); }
}
