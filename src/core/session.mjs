import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EvidenceStore } from './store.mjs';
import { redact } from './privacy.mjs';
import { validateCase } from './rules.mjs';
import { sanitizeCases } from '../spec/sanitize.mjs';
import { API_LOG_LIMITS } from './api-log.mjs';
import { flowName } from './comparison.mjs';
import { isBusinessEvent } from './event-kind.mjs';

export class SessionManager {
  constructor({ runsDir = 'runs', mode = 'cdp', cases = [] } = {}) {
    this.runsDir = path.resolve(runsDir); this.mode = mode; this.cases = cases; this.steps = []; this.results = []; this.requestScopes = new Map(); this.comparisonRequests = new Map();
  }
  start(metadata = {}) {
    if (this.session?.status === 'RUNNING') throw new Error('Đã có phiên đang chạy. Hãy kết thúc phiên trước.');
    this.steps = []; this.results = []; this.currentStep = null; this.requestScopes.clear(); this.comparisonRequests.clear();
    const id = `S-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 6)}`;
    this.runDir = path.join(this.runsDir, id); this.store = new EvidenceStore(this.runDir);
    this.store.saveExpected(sanitizeCases(this.cases));
    this.session = { ...redact(metadata), id, session_id: id, mode: this.mode, started_at: new Date().toISOString(), status: 'RUNNING', steps: [], spec_comparison: { version: 1, active_id: null, view_id: null, attempts: [] } };
    this.persist(); return this.session;
  }
  persist() { if (this.store) this.store.saveSession({ ...this.session, steps: this.steps, results: this.results }); }
  startComparison(flow) {
    if (this.session?.status !== 'RUNNING') throw new Error('Mở website và bắt đầu phiên trước khi chọn luồng đối chiếu.');
    if (this.currentStep) throw new Error('Đang chạy luồng tự động; chờ hoặc dừng lượt chạy trước.');
    const cases = this.cases.filter(testCase => flowName(testCase) === flow);
    if (!cases.length) throw new Error('Luồng không có trong đặc tả hiện tại.');
    this.stopComparison();
    const selection = this.session.spec_comparison, attempt = { id: `CMP-${randomUUID()}`, flow, case_ids: cases.map(testCase => testCase.id), started_at: new Date().toISOString(), status: 'RUNNING', overrides: {} };
    selection.attempts.push(attempt); selection.active_id = attempt.id; selection.view_id = attempt.id; this.persist(); return attempt;
  }
  stopComparison() {
    const selection = this.session?.spec_comparison; if (!selection?.active_id) return;
    const attempt = selection.attempts.find(attempt => attempt.id === selection.active_id);
    if (attempt) { attempt.status = 'COMPLETED'; attempt.completed_at = new Date().toISOString(); }
    selection.active_id = null; this.persist();
  }
  selectComparisonEvent(caseId, evidenceId) {
    const selection = this.session?.spec_comparison, attempt = selection?.attempts.find(attempt => attempt.id === selection.view_id);
    if (!attempt || !attempt.case_ids.includes(caseId)) throw new Error('Chọn luồng có dòng đặc tả này trước.');
    if (!evidenceId) { delete attempt.overrides[caseId]; this.persist(); return; }
    const event = this.store?.events().find(event => event.evidence_id === evidenceId), testCase = this.cases.find(testCase => testCase.id === caseId);
    if (!event || event.comparison_attempt_id !== attempt.id || !isBusinessEvent(event) || event.network?.phase && event.network.phase !== 'request') throw new Error('Chỉ chọn event thuộc lượt đối chiếu hiện tại.');
    const sources = new Set([testCase.source, ...testCase.rules.map(rule => rule.source)].filter(Boolean).map(source => String(source).toUpperCase()));
    if (!sources.has(String(event.source).toUpperCase())) throw new Error('Event phải cùng nền tảng với dòng đặc tả.');
    attempt.overrides[caseId] = evidenceId; this.persist();
  }
  startStep(testCaseId, context = {}) {
    if (this.session?.status !== 'RUNNING') throw new Error('Hãy bắt đầu phiên trước.');
    if (this.currentStep) throw new Error('Cần hoàn tất bước hiện tại trước.');
    if (!this.cases.some(c => c.id === testCaseId)) throw new Error('Test case không tồn tại.');
    this.stopComparison(); this.session.spec_comparison.view_id = null;
    const id = `STEP-${randomUUID()}`;
    const step = { id, evidence_id: id, test_case_id: testCaseId, started_at: new Date().toISOString(), context: redact(context), status: 'RUNNING', observed_layers: this.session.capture_queues === false ? ['TRACKING_REQUEST'] : ['JS_QUEUE', 'TRACKING_REQUEST'] };
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
    const selection = this.session.spec_comparison, attempt = selection.attempts.find(attempt => attempt.id === selection.active_id);
    let comparisonId = !partial.historical && attempt && Date.parse(capturedAt) >= Date.parse(attempt.started_at) ? attempt.id : null;
    if (requestId && partial.network?.phase && partial.network.phase !== 'request') comparisonId = this.comparisonRequests.get(scopeKey) || null;
    else if (requestId && comparisonId) this.comparisonRequests.set(scopeKey, comparisonId);
    const event = this.store.append({ ...partial, schema_version: '1.0', evidence_id: `EV-${randomUUID()}`, session_id: this.session.id,
      comparison_attempt_id: comparisonId,
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
  // Prices the website's API returned during the session (api-prices.mjs), capped per session.
  emitApi(partial) {
    if (this.session?.status !== 'RUNNING' || this.store.apiList.length >= 3000) return null;
    return this.store.appendApi({ ...partial, schema_version: '1.0', evidence_id: `API-${randomUUID()}`, session_id: this.session.id });
  }
  // Full API request/response records (api-log.mjs). Calls made during a step carry that step. Past the
  // per-session size limit a call is still listed, without its bodies.
  emitApiCall(partial) {
    if (this.session?.status !== 'RUNNING' || this.store.apiCallIndex.length >= API_LOG_LIMITS.calls) return null;
    const step = this.currentStep && Date.parse(partial.captured_at) >= Date.parse(this.currentStep.started_at) ? this.currentStep : null;
    let record = { ...partial, schema_version: '1.0', evidence_id: `APICALL-${randomUUID()}`, session_id: this.session.id, step_id: step?.id ?? null, test_case_id: step?.test_case_id ?? null };
    if (this.store.apiCallBytes > API_LOG_LIMITS.sessionBytes) {
      const omit = part => part?.body ? { ...part, body: { omitted: 'session_limit', size: part.body.size } } : part;
      record = { ...record, request: omit(record.request), response: omit(record.response) };
    }
    return this.store.appendApiCall(record);
  }
  apiCall(id) { return this.store ? this.store.apiCall(id) : null; }
  apiCallRecords() { return this.store ? this.store.apiCalls() : []; }
  completeStep() {
    const step = this.currentStep; if (!step) throw new Error('Chưa có bước đang chạy.');
    step.completed_at = new Date().toISOString(); step.status = 'COMPLETED'; this.currentStep = null;
    this.store.appendStep(step); const result = validateCase(this.cases.find(c => c.id === step.test_case_id), this.store.events(), step);
    this.results.push(result); this.persist(); return result;
  }
  interruptStep() {
    const step = this.currentStep; if (!step) return null;
    step.completed_at = new Date().toISOString(); step.status = 'INTERRUPTED'; this.currentStep = null;
    this.store.appendStep(step);
    const result = validateCase(this.cases.find(testCase => testCase.id === step.test_case_id), this.store.events(), step);
    this.results.push(result); this.persist(); return result;
  }
  snapshot() {
    const live = this.store && !this.store.closed;
    const events = live ? this.store.events() : this.lastEvents || [], api = live ? this.store.apiRecords() : this.lastApi || [];
    const apiCalls = this.store ? this.store.apiCallSummaries() : [];
    const results = [];
    for (const step of this.steps) {
      const testCase = this.cases.find(candidate => candidate.id === step.test_case_id);
      const previous = this.results.find(result => result.step_id === step.id);
      if (testCase) results.push({ ...previous, ...validateCase(testCase, events, step) });
    }
    for (const testCase of this.cases) {
      if (!this.steps.some(s => s.test_case_id === testCase.id)) results.push(validateCase(testCase, [], { id: null, evidence_id: `NOT-EXECUTED-${testCase.id}`, test_case_id: testCase.id, status: 'NOT_EXECUTED', context: {} }));
    }
    return { session: this.session, cases: this.cases, steps: this.steps, events, api, apiCalls, results };
  }
  finish() {
    if (!this.session || this.session.status !== 'RUNNING') return this.snapshot();
    if (this.currentStep) throw new Error('Hoàn tất bước hiện tại trước khi kết thúc phiên.');
    this.stopComparison(); this.session.status = 'COMPLETED'; this.session.completed_at = new Date().toISOString(); this.persist();
    this.lastEvents = this.store.events(); this.lastApi = this.store.apiRecords(); this.store.close(); return this.snapshot();
  }
  abort() {
    if (!this.session || this.session.status !== 'RUNNING') return;
    if (this.currentStep) { this.currentStep.status = 'INTERRUPTED'; this.currentStep.completed_at = new Date().toISOString(); this.store.appendStep(this.currentStep); this.currentStep = null; }
    this.stopComparison(); this.session.status = 'INTERRUPTED'; this.persist(); this.lastEvents = this.store.events(); this.lastApi = this.store.apiRecords(); this.store.close();
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
    return { session: saved, cases, steps: [...latest.values()], results: saved.results || [], events: store.events(), api: store.apiRecords(), api_calls: store.apiCalls() };
  }
  finally { store.close(); }
}
