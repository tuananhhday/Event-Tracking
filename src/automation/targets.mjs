const normalized = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const signature = locator => JSON.stringify([locator?.by, locator?.role || '', normalized(locator?.value), locator?.nth ?? null]);
export function canPerform(control, type) {
  if (control.disabled) return false;
  if (type === 'fill') return control.editable === true || control.editable === undefined && (['input', 'textarea'].includes(control.tag) || control.role === 'textbox');
  if (type === 'select') return control.tag === 'select';
  if (type === 'check') return ['checkbox', 'radio'].includes(control.type) || control.role === 'checkbox';
  return true;
}
/** Only bind to attributes/names actually observed, never translated guesses. */
export function bindTarget(action, observation) {
  if (!action.locator) return null;
  const controls = (observation?.controls || []).filter(control => canPerform(control, action.type) && control.locator);
  const exact = controls.filter(control => [...(control.locators || []), control.locator].some(locator => signature(locator) === signature(action.locator)));
  if (exact.length === 1) return exact[0].locator;
  if (exact.length > 1) return null;
  if (action.locator.by === 'css' || action.locator.nth !== undefined) return null;
  const name = normalized(action.locator.value);
  const aliases = controls.filter(control => !control.sensitive && [control.id, control.name, control.label, control.placeholder, control.testId, control.text].some(value => value && normalized(value) === name));
  return aliases.length === 1 ? aliases[0].locator : null;
}

/** Actions on the initial page must use real controls. Later clicks/navigation
 * can reveal new controls and are resolved against the live DOM when executed. */
export function groundInitialActions(input, observation) {
  const workflow = structuredClone(input);
  if (!observation?.controls?.length) return workflow;
  for (const step of workflow.steps) for (const action of step.actions) {
    if (action.type === 'goto') { if (action.url !== workflow.url) return workflow; continue; }
    if (action.type === 'assert_url' || action.type === 'assert_text' || action.type === 'wait_for') continue;
    const locator = bindTarget(action, observation);
    if (!locator) throw Object.assign(new Error(`Chưa xác nhận được thành phần “${action.locator?.value || ''}” trên trang đã đọc.`), { code: 'INVALID_AI_GROUNDED_LOCATOR' });
    action.locator = structuredClone(locator);
    if (['click', 'press', 'select', 'check'].includes(action.type)) return workflow;
  }
  return workflow;
}

// Runs inside the browser. Input values and form contents are never collected.
export function observeTargets() {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const safeText = node => {
    if (node.matches?.('input,textarea,select,output,[contenteditable]')) return '';
    const copy = node.cloneNode(true);
    for (const field of copy.querySelectorAll('input,textarea,select,output,[contenteditable]')) field.remove();
    return copy.textContent;
  };
  const controls = [], selector = 'input,textarea,select,button,a[href],summary,[role="button"],[role="link"],[role="tab"],[role="combobox"],[role="textbox"],[role="checkbox"],[role="menuitem"],[aria-haspopup],[tabindex],[onclick],[contenteditable="true"]';
  let visited = 0;
  for (const element of document.querySelectorAll(selector)) {
    if (++visited > 2000 || controls.length >= 160) break;
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none' || element.type === 'hidden') continue;
    const tag = element.tagName.toLowerCase(), role = clean(element.getAttribute('role'));
    const label = clean(element.getAttribute('aria-label') || [...(element.labels || [])].map(safeText).join(' ')
      || (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => { const node = document.getElementById(id); return node ? safeText(node) : ''; }).join(' '));
    const text = /^(button|a|summary)$/.test(tag) || ['button', 'link', 'tab', 'menuitem'].includes(role) || element.hasAttribute('aria-haspopup') || element.hasAttribute('onclick') ? clean(safeText(element)) : '';
    const id = clean(element.id), name = clean(element.getAttribute('name')), placeholder = clean(element.getAttribute('placeholder')), testId = clean(element.getAttribute('data-testid'));
    const sensitive = element.type === 'password';
    const editable = !element.readOnly && !element.disabled && (tag === 'textarea' || element.isContentEditable || tag === 'input' && ['text', 'search', 'password', 'email', 'tel', 'url', 'number', 'date', 'datetime-local', 'month', 'week', 'time'].includes(element.type));
    const item = { tag, role, type: clean(element.type), label, text, id, name, placeholder, testId, editable, readonly: Boolean(element.readOnly), disabled: Boolean(element.disabled), sensitive, locators: [] };
    if (testId) item.locators.push({ by: 'testId', value: testId });
    if (label) item.locators.push({ by: 'label', value: label, exact: true });
    if (placeholder) item.locators.push({ by: 'placeholder', value: placeholder, exact: true });
    if (text && (tag === 'button' || role === 'button')) item.locators.push({ by: 'role', role: 'button', value: text, exact: true });
    else if (text && (tag === 'a' || role === 'link')) item.locators.push({ by: 'role', role: 'link', value: text, exact: true });
    else if (text) item.locators.push({ by: 'text', value: text, exact: true });
    if (id && id === element.id) item.locators.push({ by: 'css', value: `#${CSS.escape(id)}` });
    if (name && name === element.getAttribute('name')) item.locators.push({ by: 'css', value: `[name="${CSS.escape(name)}"]` });
    item.locator = item.locators[0]; controls.push(item);
  }
  const counts = new Map(), indexes = new Map();
  for (const item of controls) if (item.locator) { const key = JSON.stringify(item.locator); counts.set(key, (counts.get(key) || 0) + 1); }
  for (const item of controls) if (item.locator) {
    const key = JSON.stringify(item.locator);
    if (counts.get(key) > 1) { item.locator = { ...item.locator, nth: indexes.get(key) || 0 }; indexes.set(key, item.locator.nth + 1); }
  }
  return { url: location.href, title: clean(document.title), observed_at: new Date().toISOString(), controls, truncated: controls.length >= 160 || visited > 2000 };
}
