import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EvidenceStore } from './store.mjs';
import { redact } from './privacy.mjs';
import { validateCase } from './rules.mjs';
import { sanitizeCases } from '../spec/sanitize.mjs';

export class SessionManager {
  constructor({ runsDir = 'runs', mode = 'cdp', cases = [] } = {}) {
    this.runsDir = path.resolve(runsDir); this.mode = mode; this.cases = cases; this.steps = []; this.results = []; this.requestScopes = new Map();
  }
  start(metadata = {}) {
    if (this.session?.status === 'RUNNING') throw new Error('Đã có phiên đang chạy. Hãy kết thúc phiên trước.');
    this.steps = []; this.results = []; this.currentStep = null; this.requestScopes.clear();
    const id = `S-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 6)}`;
    this.runDir = path.join(this.runsDir, id); this.store = new EvidenceStore(this.runDir);
    this.store.saveExpected(sanitizeCases(this.cases));
    this.session = { ...redact(metadata), id, session_id: id, mode: this.mode, started_at: new Date().toISOString(), status: 'RUNNING', steps: [] };
    this.persist(); return this.session;
  }
  persist() { if (this.store) this.store.saveSession({ ...this.session, steps: this.steps, results: this.results }); }
  startStep(testCaseId, context = {}) {
    if (this.session?.status !== 'RUNNING') throw new Error('Hãy bắt đầu phiên trước.');
    if (this.currentStep) throw new Error('Cần hoàn tất bước hiện tại trước.');
    if (!this.cases.some(c => c.id === testCaseId)) throw new Error('Test case không tồn tại.');
    const id = `STEP-${randomUUID()}`;
    const step = { id, evidence_id: id, test_case_id: testCaseId, started_at: new Date().toISOString(), context: redact(context), status: 'RUNNING', observed_layers: this.mode === 'proxy' ? ['TRACKING_REQUEST'] : ['JS_QUEUE', 'TRACKING_REQUEST'] };
    this.steps.push(step); this.currentStep = step; this.store.appendStep(step); this.persist(); return step;
  }
  emit(partial) {
    if (this.session?.status !== 'RUNNING') return null;
    const capturedAt = partial.captured_at || new Date().toISOString();
    const canCorrelate = !partial.historical && this.currentStep && Date.parse(capturedAt) >= Date.parse(this.currentStep.started_at);
    let scope = canCorrelate ? this.currentStep : null;
    const requestId = partial.network?.request_id;
    const scopeKey = `${partial.page?.target_id || ''}:${requestId}`;
    if (requestId && partial.network?.phase && partial.network.phase !== 'request') scope = this.requestScopes.get(scopeKey) || null;
    else if (requestId && scope) this.requestScopes.set(scopeKey, scope);
    const event = this.store.append({ ...partial, schema_version: '1.0', evidence_id: `EV-${randomUUID()}`, session_id: this.session.id,
      test_case_id: scope?.test_case_id || null, step_id: scope?.id || null, captured_at: capturedAt,
      correlation: scope ? { action_at: scope.started_at, delta_ms: Date.parse(capturedAt) - Date.parse(scope.started_at) } : {}, privacy: { redacted: true }
    });
    if (scope?.status === 'COMPLETED' && ['response', 'failed'].includes(partial.network?.phase)) {
      const index = this.results.findIndex(result => result.step_id === scope.id);
      const fresh = validateCase(this.cases.find(testCase => testCase.id === scope.test_case_id), this.store.events(), scope);
      if (index < 0) this.results.push(fresh); else this.results[index] = { ...this.results[index], ...fresh };
      this.persist();
    }
    return event;
  }
  completeStep() {
    const step = this.currentStep; if (!step) throw new Error('Chưa có bước đang chạy.');
    step.completed_at = new Date().toISOString(); step.status = 'COMPLETED'; this.currentStep = null;
    this.store.appendStep(step); const result = validateCase(this.cases.find(c => c.id === step.test_case_id), this.store.events(), step);
    this.results.push(result); this.persist(); return result;
  }
  snapshot() {
    const events = this.store && !this.store.closed ? this.store.events() : this.lastEvents || [];
    const results = [];
    for (const step of this.steps) {
      const testCase = this.cases.find(candidate => candidate.id === step.test_case_id);
      const previous = this.results.find(result => result.step_id === step.id);
      if (testCase) results.push({ ...previous, ...validateCase(testCase, events, step) });
    }
    for (const testCase of this.cases) {
      if (!this.steps.some(s => s.test_case_id === testCase.id)) results.push(validateCase(testCase, [], { id: null, evidence_id: `NOT-EXECUTED-${testCase.id}`, test_case_id: testCase.id, status: 'NOT_EXECUTED', context: {} }));
    }
    return { session: this.session, cases: this.cases, steps: this.steps, events, results };
  }
  finish() {
    if (!this.session || this.session.status !== 'RUNNING') return this.snapshot();
    if (this.currentStep) throw new Error('Hoàn tất bước hiện tại trước khi kết thúc phiên.');
    this.session.status = 'COMPLETED'; this.session.completed_at = new Date().toISOString(); this.persist();
    this.lastEvents = this.store.events(); this.store.close(); return this.snapshot();
  }
  abort() {
    if (!this.session || this.session.status !== 'RUNNING') return;
    if (this.currentStep) { this.currentStep.status = 'INTERRUPTED'; this.currentStep.completed_at = new Date().toISOString(); this.store.appendStep(this.currentStep); this.currentStep = null; }
    this.session.status = 'INTERRUPTED'; this.persist(); this.lastEvents = this.store.events(); this.store.close();
  }
}

export function loadRun(runDir) {
  const dir = path.resolve(runDir); const saved = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  const store = new EvidenceStore(dir);
  try {
    const latest = new Map((saved.steps || []).map(step => [step.id, step]));
    for (const step of store.recoveredSteps || []) latest.set(step.id, step);
    const expectedPath = path.join(dir, 'expected.json');
    const cases = fs.existsSync(expectedPath) ? JSON.parse(fs.readFileSync(expectedPath, 'utf8')).cases || [] : [];
    return { session: saved, cases, steps: [...latest.values()], results: saved.results || [], events: store.events() };
  }
  finally { store.close(); }
}
