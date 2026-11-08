import fs from 'node:fs/promises';
import path from 'node:path';

const iso = () => new Date().toISOString();
const message = error => String(error?.message || error || 'Luồng tự động gặp lỗi.').slice(0, 1800);
const abortReason = signal => signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Đã dừng luồng tự động.'), { name: 'AbortError' });
const checkAborted = signal => { if (signal?.aborted) throw abortReason(signal); };
// Recorded actions normally finish in a few seconds; waiting 30 s for an element
// that is not there only delays the error. Popups marked optional wait less.
const DEFAULT_ACTION_TIMEOUT_MS = 15000;
const OPTIONAL_ACTION_TIMEOUT_MS = 5000;
const ASSIST_TIMEOUT_MS = 240000;
const SETTLE_FREE = new Set(['wait_for', 'assert_text', 'assert_url', 'wait_url', 'wait_ms']);

function interruptible(operation, signal) {
  checkAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { checkAborted(signal); return operation(); }).then(resolve, reject)
      .finally(() => signal?.removeEventListener('abort', abort));
  });
}

async function failureScreenshot(driver, directory, workflowId, stepId) {
  if (!directory || typeof driver.screenshot !== 'function') return null;
  let timer;
  try {
    await fs.mkdir(directory, { recursive: true });
    const safe = value => String(value || 'step').replace(/[^a-z0-9_-]/gi, '_').slice(0, 70);
    const filePath = path.join(directory, `${safe(workflowId)}-${safe(stepId)}-${Date.now()}.png`);
    await Promise.race([driver.screenshot(filePath), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Screenshot timeout')), 5500); })]);
    return filePath;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/** Execute a reviewed workflow in order. The caller owns the session, capture,
 * driver connection and final report export; this runner owns only its steps.
 * `assist(step, details)`, when given, lets AI finish a step whose recorded actions
 * failed or were never recorded (step.pending); it resolves to {status:'DONE'|…}. */
export async function runWorkflow(workflow, { driver, signal, onStepStart, onStepComplete, onProgress, onStepError, waitForEvents, screenshotDir, assist } = {}) {
  if (!driver || typeof driver.execute !== 'function') throw new Error('Cần browser driver để chạy luồng.');
  if (!workflow?.url || !Array.isArray(workflow.steps) || !workflow.steps.length) throw new Error('Luồng cần URL và ít nhất một bước.');
  const result = { workflow_id: workflow.id, name: workflow.name, status: 'RUNNING', steps: [], started_at: iso(), completed_at: null };
  const progress = async detail => { try { await onProgress?.({ workflow_id: workflow.id, ...detail }); } catch { /* Progress is observational. */ } };
  await progress({ type: 'workflow-start', status: result.status });
  try {
    checkAborted(signal);
    for (const [index, step] of workflow.steps.entries()) {
      const stepResult = { id: step.id, name: step.name, status: 'RUNNING', started_at: iso(), completed_at: null, actions: [] };
      result.steps.push(stepResult);
      const controller = new AbortController();
      const timeoutMs = step.timeout_ms ?? workflow.timeout_ms ?? 30000;
      const timeoutError = Object.assign(new Error(`Bước ${step.name || step.id} vượt quá ${timeoutMs} ms.`), { name: 'TimeoutError' });
      const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
      const stepSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const context = { index, workflow, signal: stepSignal };
      const stepEnd = Date.now() + timeoutMs;
      try {
        checkAborted(stepSignal);
        await interruptible(() => onStepStart?.(step, context), stepSignal);
        await progress({ type: 'step-start', step_id: step.id, step_index: index, status: 'RUNNING', name: step.name });
        const actions = index === 0 && !(step.actions[0]?.type === 'goto' && step.actions[0].url === workflow.url)
          ? [{ type: 'goto', url: workflow.url, initial: true }, ...step.actions] : step.actions;
        let assistance = null;
        try {
          for (const [actionIndex, action] of actions.entries()) {
            checkAborted(stepSignal);
            const actionResult = { type: action.type, ...(action.initial ? { initial: true } : {}), ...(action.irreversible ? { irreversible: true } : {}), status: 'RUNNING', started_at: iso(), completed_at: null };
            stepResult.actions.push(actionResult);
            await progress({ type: 'action-start', step_id: step.id, action_index: actionIndex, action_type: action.type, status: 'RUNNING' });
            const actionController = new AbortController();
            const wanted = action.timeout_ms ?? (action.optional ? OPTIONAL_ACTION_TIMEOUT_MS : action.type === 'goto' ? 30000 : DEFAULT_ACTION_TIMEOUT_MS);
            const actionTimeoutMs = Math.max(1, Math.min(wanted, stepEnd - Date.now()));
            const actionTimer = setTimeout(() => actionController.abort(Object.assign(new Error(`Thao tác ${action.type} vượt quá ${actionTimeoutMs} ms.`), { name: 'TimeoutError' })), actionTimeoutMs);
            const actionSignal = AbortSignal.any([stepSignal, actionController.signal]);
            try {
              const boundedAction = { ...action, timeout_ms: actionTimeoutMs };
              await interruptible(() => driver.execute(boundedAction, { signal: actionSignal }), actionSignal);
              // Pace like a person: an app that is still reacting swallows the next click.
              if (typeof driver.settle === 'function' && !SETTLE_FREE.has(action.type)) {
                // Bounded by settle itself (≤4 s); only a user cancellation may interrupt it.
                await interruptible(() => driver.settle({ signal, ms: 150 }), signal).catch(error => { if (signal?.aborted) throw error; });
              }
              actionResult.status = 'COMPLETED';
            } catch (error) {
              actionResult.error = message(error);
              // An intermittent popup that is not there today is not a failure.
              if (action.optional && !signal?.aborted && !stepSignal.aborted) { actionResult.status = 'SKIPPED'; continue; }
              actionResult.status = signal?.aborted ? 'CANCELLED' : 'FAILED'; throw error;
            } finally { clearTimeout(actionTimer); actionResult.completed_at = iso(); }
            await progress({ type: 'action-complete', step_id: step.id, action_index: actionIndex, action_type: action.type, status: 'COMPLETED' });
          }
        } catch (error) {
          if (signal?.aborted || typeof assist !== 'function') throw error;
          assistance = { reason: 'failed', error };
        }
        if (!assistance && step.pending) {
          if (typeof assist !== 'function') throw new Error(`Bước “${step.name}” chưa được ghi đủ thao tác. Bật “AI tự sửa” hoặc cho AI chạy thử lại luồng.`);
          assistance = { reason: 'pending' };
        }
        if (assistance) {
          clearTimeout(timer);
          // Booking/payment actions run at most once: AI may perform one only when the
          // recorded step contains it and it has not been attempted yet.
          const allowIrreversible = step.actions.some(item => item.irreversible) && !stepResult.actions.some(item => item.irreversible);
          await progress({ type: 'assist-start', step_id: step.id, step_index: index, reason: assistance.reason, message: assistance.reason === 'pending'
            ? `AI thực hiện phần chưa ghi của bước ${step.name}` : `Thao tác đã ghi không còn khớp trang (${message(assistance.error).slice(0, 200)}). AI đang tự sửa bước ${step.name}` });
          const assistSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(ASSIST_TIMEOUT_MS)]) : AbortSignal.timeout(ASSIST_TIMEOUT_MS);
          const outcome = await interruptible(() => assist(step, { ...assistance, index, workflow, signal: assistSignal, allowIrreversible,
            done: actions.filter((_, position) => stepResult.actions[position]?.status === 'COMPLETED' && !actions[position].initial) }), assistSignal);
          stepResult.assisted = { reason: assistance.reason, status: outcome?.status ?? 'FAILED', note: String(outcome?.note ?? '').slice(0, 600),
            actions: (outcome?.actions ?? []).slice(0, 40) };
          await progress({ type: 'assist-complete', step_id: step.id, step_index: index, status: outcome?.status, message: outcome?.note });
          if (outcome?.status !== 'DONE') {
            const cause = assistance.error ? `${message(assistance.error)} — ` : '';
            throw Object.assign(new Error(`${cause}AI chưa hoàn tất bước: ${outcome?.note || 'không rõ lý do'}`), { code: 'AUTOMATION_ASSIST_FAILED' });
          }
        }
        if (step.expected_events?.length) {
          if (typeof waitForEvents !== 'function') throw new Error('Chưa có bộ kiểm tra event mong muốn cho luồng.');
          const remaining = assistance ? 15000 : Math.max(1, stepEnd - Date.now());
          const eventSignal = assistance ? (signal ? AbortSignal.any([signal, AbortSignal.timeout(remaining + 1000)]) : AbortSignal.timeout(remaining + 1000)) : stepSignal;
          try {
            await interruptible(() => waitForEvents(step.expected_events, { ...context, signal: eventSignal, step, timeoutMs: remaining }), eventSignal);
          } catch (error) {
            // A missing event is a finding to report, not a reason to stop the journey:
            // later steps still produce the rest of the evidence.
            if (signal?.aborted || error.code !== 'AUTOMATION_EVENT_TIMEOUT') throw error;
            stepResult.missing_events = Array.isArray(error.missing) ? error.missing : [];
            stepResult.warning = message(error);
            await progress({ type: 'events-missing', step_id: step.id, step_index: index, message: stepResult.warning });
          }
        }
        if (!assistance) checkAborted(stepSignal); else checkAborted(signal);
        stepResult.status = 'COMPLETED'; stepResult.completed_at = iso();
        await interruptible(() => onStepComplete?.(step, stepResult, context), assistance ? signal : stepSignal);
        await progress({ type: 'step-complete', step_id: step.id, step_index: index, status: 'COMPLETED' });
      } catch (error) {
        stepResult.status = signal?.aborted ? 'CANCELLED' : 'FAILED'; stepResult.error = message(error); stepResult.completed_at = iso();
        if (error?.detail) stepResult.error_detail = String(error.detail).slice(0, 1500);
        if (!signal?.aborted) {
          const screenshot = await failureScreenshot(driver, screenshotDir, workflow.id, step.id);
          if (screenshot) stepResult.screenshot = screenshot;
        }
        try { await interruptible(() => onStepError?.(step, error, { ...context, result: stepResult }), AbortSignal.timeout(5000)); } catch { /* Preserve the action error. */ }
        await progress({ type: 'step-complete', step_id: step.id, step_index: index, status: stepResult.status, error: stepResult.error });
        throw error;
      } finally { clearTimeout(timer); }
    }
    result.status = 'COMPLETED';
  } catch (error) {
    result.status = signal?.aborted ? 'CANCELLED' : 'FAILED'; result.error = message(error);
  }
  const missing = result.steps.filter(step => step.missing_events?.length).length;
  if (missing) result.warning = `${missing} bước chưa thấy đủ event mong muốn.`;
  const assisted = result.steps.filter(step => step.assisted?.status === 'DONE').length;
  if (assisted) result.assisted_steps = assisted;
  result.completed_at = iso();
  await progress({ type: 'workflow-complete', status: result.status, ...(result.error ? { error: result.error } : {}) });
  return result;
}
