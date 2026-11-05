import { chromium } from 'playwright-core';
import { observeTargets, bindTarget } from './targets.mjs';

const abortReason = signal => signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Đã dừng luồng tự động.'), { name: 'AbortError' });
const checkAborted = signal => { if (signal?.aborted) throw abortReason(signal); };

function abortable(operation, signal, onAbort = () => {}) {
  checkAborted(signal);
  if (!signal) return Promise.resolve().then(operation);
  return new Promise((resolve, reject) => {
    const abort = () => { Promise.resolve().then(onAbort).catch(() => {}); reject(abortReason(signal)); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { checkAborted(signal); return operation(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

function locate(page, locator, visible = true) {
  if (!locator || typeof locator.value !== 'string') throw new Error('Thiếu locator cho thao tác.');
  const options = locator.exact === undefined ? {} : { exact: locator.exact };
  let target;
  switch (locator.by) {
    case 'role': target = page.getByRole(locator.role, { name: locator.value, ...options }); break;
    case 'label': target = page.getByLabel(locator.value, options); break;
    case 'placeholder': target = page.getByPlaceholder(locator.value, options); break;
    case 'text': target = page.getByText(locator.value, options); break;
    case 'testId': target = page.getByTestId(locator.value); break;
    case 'css': target = page.locator(locator.value); break;
    default: throw new Error('Loại locator không được hỗ trợ.');
  }
  if (visible) target = target.filter({ visible: true });
  return locator.nth === undefined ? target : target.nth(locator.nth);
}

/** Attach a driver to the exact test target. Closing this CDP connection only
 * disconnects Playwright: the existing browser/context remain owned by launcher. */
export async function connectAutomationBrowser({ port, targetId, signal, timeoutMs = 30000 } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Cổng CDP chưa hợp lệ.');
  if (typeof targetId !== 'string' || !targetId) throw new Error('Cần targetId của tab test.');
  checkAborted(signal);
  const connecting = chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: Math.min(30000, Math.max(1, timeoutMs)), noDefaults: true });
  let browser;
  const disconnectLate = () => connecting.then(connected => connected.close()).catch(() => {});
  const connectingSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.min(30000, Math.max(1, timeoutMs)))]);
  try {
    browser = await abortable(() => connecting, connectingSignal, disconnectLate);
    let page;
    await abortable(async () => {
      for (const context of browser.contexts()) {
        for (const candidate of context.pages()) {
          checkAborted(connectingSignal);
          let session;
          try {
            session = await context.newCDPSession(candidate);
            const { targetInfo } = await session.send('Target.getTargetInfo');
            if (targetInfo?.targetId === targetId) { page = candidate; return; }
          } catch (error) {
            checkAborted(connectingSignal);
            if (!candidate.isClosed()) throw error;
          } finally { await session?.detach().catch(() => {}); }
        }
      }
    }, connectingSignal, () => browser.close());
    if (!page) throw new Error('Không tìm thấy đúng tab test đã chọn; hãy mở lại phiên.');

    let disconnecting;
    const disconnect = () => disconnecting ??= browser.close();
    const perform = (operation, actionSignal) => {
      if (disconnecting || !browser.isConnected()) throw new Error('Kết nối tự động hóa đã dừng.');
      const combined = signal && actionSignal ? AbortSignal.any([signal, actionSignal]) : actionSignal ?? signal;
      // Disconnect on cancellation so an action waiting for a locator cannot
      // execute later after the runner has already reported cancellation.
      return abortable(operation, combined, disconnect);
    };

    return {
      async inspect({ signal: inspectSignal } = {}) {
        const inspectionSignal = AbortSignal.any([...(inspectSignal ? [inspectSignal] : []), AbortSignal.timeout(30000)]);
        return perform(async () => {
          await page.locator('input,textarea,select,button,a[href],[role="button"],[role="combobox"]').filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 7000 }).catch(() => {});
          return page.evaluate(observeTargets);
        }, inspectionSignal);
      },
      async execute(action, { signal: actionSignal, onObservation } = {}) {
        const timeout = Math.min(action.type === 'goto' ? 30000 : 60000, Math.max(1, action.timeout_ms ?? 30000));
        return perform(async () => {
          if (action.type === 'goto') { await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout }); return; }
          if (action.type === 'assert_url') { await page.waitForURL(url => url.href === action.url, { timeout, waitUntil: 'domcontentloaded' }); return; }
          let target = locate(page, action.locator, !(action.type === 'wait_for' && action.state === 'hidden'));
          let resolved;
          if (['fill', 'click', 'select', 'check', 'press'].includes(action.type) && await target.count() === 0) {
            // An HTML name/id is not necessarily an accessible label. Rebind
            // only when one compatible visible control has that exact alias.
            const observation = await page.evaluate(observeTargets);
            onObservation?.(observation);
            resolved = bindTarget(action, observation);
            const name = action.locator.value.trim().toLowerCase();
            if (!resolved && action.type === 'fill' && observation.controls.some(control => control.readonly && [control.id, control.name, control.label, control.placeholder].some(value => value && value.trim().toLowerCase() === name))) throw Object.assign(new Error(`“${action.locator.value}” là ô chỉ đọc để mở bảng chọn. Cần bấm ô này trước, rồi nhập vào ô tìm kiếm được mở ra; không thể fill trực tiếp.`), { code: 'AUTOMATION_NOT_EDITABLE' });
            if (resolved) target = locate(page, resolved);
          }
          if (action.type === 'fill' && await target.count() === 1 && (await target.getAttribute('readonly') !== null || await target.getAttribute('aria-readonly') === 'true')) throw Object.assign(new Error(`“${action.locator.value}” là ô chỉ đọc. Cần mở bảng chọn trước rồi nhập vào ô tìm kiếm bên trong.`), { code: 'AUTOMATION_NOT_EDITABLE' });
          switch (action.type) {
            case 'click': await target.click({ timeout }); break;
            case 'fill': await target.fill(String(action.value), { timeout }); break;
            case 'select': await target.selectOption(action.value, { timeout }); break;
            case 'check': await target.setChecked(action.checked, { timeout }); break;
            case 'press': await target.press(action.key, { timeout }); break;
            case 'wait_for': await target.waitFor({ state: action.state ?? 'visible', timeout }); break;
            case 'assert_text': {
              const end = Date.now() + timeout;
              while (true) {
                checkAborted(actionSignal ?? signal);
                const text = await target.textContent({ timeout: Math.max(1, end - Date.now()) });
                if (String(text ?? '').includes(action.text)) break;
                if (Date.now() >= end) throw Object.assign(new Error('Nội dung trang chưa khớp văn bản mong muốn.'), { name: 'TimeoutError' });
                await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, end - Date.now()))));
              }
              break;
            }
            default: throw new Error('Thao tác tự động hóa không được hỗ trợ.');
          }
          return resolved ? { resolved_locator: resolved } : undefined;
        }, actionSignal);
      },
      async screenshot(filePath) {
        await perform(() => page.screenshot({ path: filePath, fullPage: false, timeout: 5000 }));
        return filePath;
      },
      disconnect,
    };
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    throw error;
  }
}
