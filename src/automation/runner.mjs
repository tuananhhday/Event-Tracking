import fs from 'node:fs/promises';
import path from 'node:path';

const iso = () => new Date().toISOString();
const message = error => String(error?.message || error || 'Luồng tự động gặp lỗi.').slice(0, 1800);
const abortReason = signal => signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Đã dừng luồng tự động.'), { name: 'AbortError' });
const checkAborted = signal => { if (signal?.aborted) throw abortReason(signal); };

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
 * driver connection and final report export; this runner owns only its steps. */
export async function runWorkflow(workflow, { driver, signal, onStepStart, onStepComplete, onProgress, onStepError, waitForEvents, screenshotDir } = {}) {
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
        for (const [actionIndex, action] of actions.entries()) {
          checkAborted(stepSignal);
          const actionResult = { type: action.type, ...(action.initial ? { initial: true } : {}), status: 'RUNNING', started_at: iso(), completed_at: null };
          stepResult.actions.push(actionResult);
          await progress({ type: 'action-start', step_id: step.id, action_index: actionIndex, action_type: action.type, status: 'RUNNING' });
          const actionController = new AbortController();
          const actionTimeoutMs = Math.max(1, Math.min(action.timeout_ms ?? 30000, stepEnd - Date.now()));
          const actionTimer = setTimeout(() => actionController.abort(Object.assign(new Error(`Thao tác ${action.type} vượt quá ${actionTimeoutMs} ms.`), { name: 'TimeoutError' })), actionTimeoutMs);
          const actionSignal = AbortSignal.any([stepSignal, actionController.signal]);
          try {
            const boundedAction = { ...action, timeout_ms: actionTimeoutMs };
            await interruptible(() => driver.execute(boundedAction, { signal: actionSignal }), actionSignal);
            actionResult.status = 'COMPLETED';
          } catch (error) {
            actionResult.status = signal?.aborted ? 'CANCELLED' : 'FAILED'; actionResult.error = message(error); throw error;
          } finally { clearTimeout(actionTimer); actionResult.completed_at = iso(); }
          await progress({ type: 'action-complete', step_id: step.id, action_index: actionIndex, action_type: action.type, status: 'COMPLETED' });
        }
        if (step.expected_events?.length) {
          if (typeof waitForEvents !== 'function') throw new Error('Chưa có bộ kiểm tra event mong muốn cho luồng.');
          await interruptible(() => waitForEvents(step.expected_events, { ...context, step, timeoutMs: Math.max(1, stepEnd - Date.now()) }), stepSignal);
        }
        checkAborted(stepSignal);
        stepResult.status = 'COMPLETED'; stepResult.completed_at = iso();
        await interruptible(() => onStepComplete?.(step, stepResult, context), stepSignal);
        await progress({ type: 'step-complete', step_id: step.id, step_index: index, status: 'COMPLETED' });
      } catch (error) {
        stepResult.status = signal?.aborted ? 'CANCELLED' : 'FAILED'; stepResult.error = message(error); stepResult.completed_at = iso();
        if (!stepSignal.aborted) {
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
  result.completed_at = iso();
  await progress({ type: 'workflow-complete', status: result.status, ...(result.error ? { error: result.error } : {}) });
  return result;
}
