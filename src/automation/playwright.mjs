import { chromium } from 'playwright-core';

const abortReason = signal => signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Đã dừng luồng tự động.'), { name: 'AbortError' });
const checkAborted = signal => { if (signal?.aborted) throw abortReason(signal); };
// Playwright's own timeout fires this much before the runner's safety timer, so the
// informative Playwright error (which locator, covered or missing) is what users see
// and the browser connection stays usable for the failure screenshot and AI repair.
const TIMEOUT_MARGIN_MS = 750;
const CONTAINERS = 'div,li,article,section,tr,form,fieldset,table,ul,ol,dl,main,aside,label';

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

function baseLocator(root, locator) {
  const options = locator.exact === undefined ? {} : { exact: locator.exact };
  switch (locator.by) {
    case 'role': return root.getByRole(locator.role, { name: locator.value, ...options });
    case 'label': return root.getByLabel(locator.value, options);
    case 'placeholder': return root.getByPlaceholder(locator.value, options);
    case 'text': return root.getByText(locator.value, options);
    case 'testId': return root.getByTestId(locator.value);
    case 'css': return root.locator(locator.value);
    default: throw new Error('Loại locator không được hỗ trợ.');
  }
}

export function locate(page, locator) {
  if (!locator || typeof locator.value !== 'string') throw new Error('Thiếu locator cho thao tác.');
  let target;
  if (locator.within?.text) {
    // The deepest card/row containing both the anchor text and the target: page
    // wrappers also contain them but come first in document order.
    const inner = baseLocator(page, locator);
    const container = page.locator(CONTAINERS).filter({ hasText: locator.within.text }).filter({ has: inner }).last();
    target = baseLocator(container, locator);
  } else target = baseLocator(page, locator);
  return locator.nth === undefined ? target : target.nth(locator.nth);
}

export function describeLocator(locator) {
  if (!locator) return 'phần tử';
  if (locator.by === 'visible_text') return `phần tử có chữ “${locator.value}”`;
  const base = locator.by === 'role' ? `${locator.role} “${locator.value}”` : locator.by === 'css' ? `CSS ${locator.value}` : `${locator.by} “${locator.value}”`;
  return `${base}${locator.within ? ` trong khối có “${locator.within.text}”` : ''}${locator.nth !== undefined ? ` (vị trí ${locator.nth + 1})` : ''}`;
}

/** Turns a Playwright error into a short Vietnamese explanation; the raw call log
 * stays in `detail` for the evidence file. */
export function humanizeError(error, action = {}, timeout) {
  const raw = String(error?.message || error || '');
  if (!raw || error?.name === 'AbortError' || error?.code) return error;
  const target = describeLocator(action.locator), seconds = timeout ? `${Math.round(timeout / 100) / 10}s` : '';
  let text;
  if (/strict mode violation/i.test(raw)) text = `Locator ${target} khớp ${raw.match(/resolved to (\d+) elements/)?.[1] ?? 'nhiều'} phần tử; cần chọn cụ thể hơn.`;
  else if (/intercepts pointer events/i.test(raw)) text = `Không bấm được ${target}: phần tử đang bị popup hoặc lớp phủ khác che.`;
  else if (/did not find some options/i.test(raw)) text = `Không có lựa chọn “${[].concat(action.value).join(', ')}” trong ${target}.`;
  else if (/not a <select>/i.test(raw)) text = `${target} không phải ô chọn <select>; cần dùng thao tác bấm.`;
  else if (/(Target page, context or browser has been closed|Target closed|Browser has been closed)/i.test(raw)) text = 'Tab hoặc trình duyệt test đã bị đóng.';
  else if (error?.name === 'TimeoutError' || /Timeout \d+ms exceeded/i.test(raw)) {
    if (action.type === 'goto') text = `Trang ${action.url} tải quá ${seconds}.`;
    else if (action.type === 'assert_url') text = `Địa chỉ trang chưa đổi thành ${action.url} sau ${seconds}.`;
    else if (/element is not enabled|element is disabled/i.test(raw)) text = `${target} đang bị vô hiệu hóa (disabled) sau ${seconds}.`;
    else if (/element is not visible|to be visible/i.test(raw) && /resolved to/i.test(raw)) text = `Có ${target} nhưng phần tử đang bị ẩn sau ${seconds}.`;
    else if (/resolved to/i.test(raw)) text = `Có ${target} nhưng chưa thao tác được trong ${seconds} (phần tử đang di chuyển hoặc bị che).`;
    else text = `Không tìm thấy ${target} trên trang sau ${seconds}.`;
  } else return error;
  return Object.assign(new Error(text), { name: error?.name === 'TimeoutError' ? 'TimeoutError' : 'AutomationActionError', code: 'ACTION_FAILED', detail: raw.slice(0, 1500) });
}

// Links that open a new tab would leave the captured tab behind: keep the whole
// journey in the tab whose events are being collected. window.open is left alone:
// login popups (Google, SSO) rely on it.
const SAME_TAB_SCRIPT = `(() => {
  if (window.__eventqaSameTab) return; window.__eventqaSameTab = true;
  document.addEventListener('click', event => {
    const link = event.target && event.target.closest ? event.target.closest('a[target]') : null;
    if (link && link.href && !/^javascript:/i.test(link.href) && !['_self', '_top', '_parent', ''].includes(link.target)) link.target = '_self';
  }, true);
})();`;
const LOADING_TEXT = /đang (tải|kiểm tra|xử lý|chuyển hướng)|vui lòng (chờ|đợi)|loading|please wait|redirecting/i;
const NAVIGATING =/Execution context was destroyed|Cannot find context|navigation|frame was detached|Target page, context or browser has been closed/i;

/** In-page: number the visible controls so the AI can choose one by `ref`. Runs in
 * the browser, so it must stay self-contained. */
function pageSnapshot({ max, textLimit }) {
  const clean = (value, limit = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
  for (const node of document.querySelectorAll('[data-eventqa-ref]')) node.removeAttribute('data-eventqa-ref');
  const semantic = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=option],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=gridcell],[role=treeitem],[role=spinbutton],[role=slider],[contenteditable=""],[contenteditable="true"],[onclick]';
  const container = 'a[href],button,[role=button],[role=link],[role=option],[role=menuitem],[role=tab],summary';
  const styles = new Map();
  const style = element => { let value = styles.get(element); if (!value) { value = getComputedStyle(element); styles.set(element, value); } return value; };
  const shown = element => {
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) return false;
    const current = style(element);
    return current.visibility !== 'hidden' && current.display !== 'none' && Number(current.opacity) > 0.05;
  };
  const picked = [];
  let scanned = 0;
  for (const element of document.body ? document.body.querySelectorAll('*') : []) {
    if (++scanned > 9000) break;
    const tag = element.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'template', 'svg', 'path', 'g', 'iframe', 'br', 'hr', 'img', 'option'].includes(tag)) continue;
    if (tag === 'input' && element.type === 'hidden') continue;
    let interactive = element.matches(semantic);
    if (!interactive && tag === 'label' && element.control && !shown(element.control)) interactive = true;
    if (!interactive && style(element).cursor === 'pointer') {
      const parent = element.parentElement;
      interactive = (!parent || style(parent).cursor !== 'pointer') && !parent?.closest(container);
    }
    if (!interactive || element.closest('[aria-hidden="true"]') || !shown(element)) continue;
    picked.push(element);
  }
  // A control wrapping exactly one other control and adding no text of its own
  // (a calendar <td> around its day button, <a> around <button>) is listed once, as
  // the inner element. Descendants come later in document order, so walk backwards.
  // Exception: a read-only, unfocusable input inside a button is only the display of a
  // custom select ("Danh xưng: Chọn"); the button is what opens it.
  const decorative = element => element.matches('input') && (element.readOnly || element.tabIndex < 0 || getComputedStyle(element).pointerEvents === 'none');
  const opener = element => element.matches('button,[role=button],[role=combobox],label');
  const kept = [];
  for (let index = picked.length - 1; index >= 0; index--) {
    const element = picked[index], inner = kept.filter(other => element.contains(other));
    if (inner.length === 1 && opener(element) && decorative(inner[0])) { kept.splice(kept.indexOf(inner[0]), 1); kept.push(element); continue; }
    if (inner.length === 1 && clean(element.innerText).length <= clean(inner[0].innerText).length + 15) continue;
    kept.push(element);
  }
  picked.splice(0, picked.length, ...kept.reverse());
  const height = innerHeight, width = innerWidth;
  const inView = element => { const box = element.getBoundingClientRect(); return box.bottom > 0 && box.right > 0 && box.top < height && box.left < width; };
  // What appeared since the previous look (suggestions, a calendar, a popup) is what
  // the next action usually needs: list it first and flag it.
  const seen = window.__eventqaSeen instanceof WeakSet ? window.__eventqaSeen : null;
  const isNew = element => Boolean(seen) && !seen.has(element);
  const inLayer = element => Boolean(element.closest('[role=dialog],[role=listbox],[role=menu],[role=grid],dialog[open],[aria-modal="true"]'));
  const disabled = element => element.disabled || element.getAttribute('aria-disabled') === 'true';
  // The site's navigation bar and footer come last: listed first they get picked for
  // "the search box" of the page.
  const chrome = element => Boolean(element.closest('header,nav,[role=banner],[role=navigation],footer,[role=contentinfo]'));
  // Unlabelled clickable areas (promo bars, image wrappers) are rarely what a step needs.
  const unnamed = element => !clean(element.getAttribute('aria-label') || element.innerText || element.getAttribute('title') || element.getAttribute('placeholder') || element.querySelector?.('img[alt]')?.alt);
  const rank = element => (chrome(element) ? 8 : 0) + (inView(element) ? 0 : 4) + (isNew(element) || inLayer(element) ? 0 : 1) + (disabled(element) ? 2 : 0) + (unnamed(element) ? 3 : 0);
  const implicitRole = element => {
    const tag = element.tagName.toLowerCase(), type = (element.getAttribute('type') || '').toLowerCase();
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button' || tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (tag === 'input' && ['checkbox', 'radio'].includes(type)) return type;
    if (tag === 'input' && type === 'search') return 'searchbox';
    if (tag === 'input' && type === 'number') return 'spinbutton';
    if (tag === 'input' && ['', 'text', 'email', 'tel', 'url', 'password'].includes(type)) return 'textbox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return element.multiple || element.size > 1 ? 'listbox' : 'combobox';
    return '';
  };
  const labelOf = element => {
    const aria = clean(element.getAttribute('aria-label'));
    if (aria) return aria;
    const by = (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ');
    if (clean(by)) return clean(by);
    return element.labels?.length ? clean([...element.labels].map(label => label.innerText).join(' ')) : '';
  };
  const hintPattern = /close|search|submit|next|prev|calendar|date|guest|room|menu|book|pay|login|plus|minus|increase|decrease|apply/i;
  const ranks = new Map(picked.map(element => [element, rank(element)]));
  const ordered = picked.map((element, index) => [element, index]).sort((a, b) => ranks.get(a[0]) - ranks.get(b[0]) || a[1] - b[1]).map(([element]) => element).slice(0, max);
  const nextSeen = new WeakSet(); for (const element of picked) nextSeen.add(element);
  window.__eventqaSeen = nextSeen;
  const elements = ordered.map((element, index) => {
    const ref = `e${index + 1}`, tag = element.tagName.toLowerCase();
    element.setAttribute('data-eventqa-ref', ref);
    const role = element.getAttribute('role') || implicitRole(element);
    const field = /^(input|textarea|select)$/.test(tag) || element.isContentEditable;
    const sensitive = tag === 'input' && element.type === 'password';
    // A select-like button showing only "Chọn" takes the label of the field it contains.
    const innerField = field ? null : element.querySelector?.('input,select,textarea');
    const innerLabel = innerField ? labelOf(innerField) : '';
    const ownText = field ? '' : clean(element.innerText);
    const borrowed = innerLabel && ownText.length < 25 && !ownText.toLowerCase().includes(innerLabel.toLowerCase()) && !innerLabel.toLowerCase().includes(ownText.toLowerCase() || '\u0000')
      ? `${innerLabel}${ownText ? `: ${ownText}` : ''}` : innerLabel && !ownText ? innerLabel : '';
    const name = clean(labelOf(element) || borrowed || ownText || element.getAttribute('title') || element.querySelector?.('img[alt]')?.alt
      || element.getAttribute('placeholder') || (tag === 'input' && /^(button|submit|reset)$/.test(element.type) ? element.value : ''), 100);
    const item = { ref, tag, ...(role ? { role } : {}), name };
    if (tag === 'input') item.type = element.type;
    if (sensitive) item.sensitive = true;
    if (element.getAttribute('placeholder')) item.placeholder = clean(element.getAttribute('placeholder'), 80);
    if (field && !sensitive && tag !== 'select') { const value = clean(element.value ?? element.innerText, 60); if (value) item.value = value; }
    if (tag === 'select') { item.options = [...element.options].slice(0, 25).map(option => clean(option.label || option.text, 60)); item.value = clean(element.selectedOptions?.[0]?.label, 60); }
    if (tag === 'input' && ['checkbox', 'radio'].includes(element.type)) item.checked = element.checked;
    for (const [attribute, key] of [['aria-checked', 'checked'], ['aria-selected', 'selected'], ['aria-expanded', 'expanded'], ['aria-pressed', 'pressed']]) {
      const value = element.getAttribute(attribute); if (value === 'true' || value === 'false') item[key] = value === 'true';
    }
    if (element.disabled || element.getAttribute('aria-disabled') === 'true') item.disabled = true;
    if (tag === 'a') { try { const url = new URL(element.href); item.href = clean(url.pathname + url.search, 100); } catch { /* not a URL */ } }
    if (!name) {
      const hints = String(element.getAttribute('class') || '').split(/\s+/).filter(token => hintPattern.test(token)).slice(0, 3);
      if (hints.length) item.hint = hints.join(' ');
    }
    // No "offscreen" flag on purpose: seeing it, models scroll first although clicks scroll by themselves.
    if (isNew(element)) item.new = true;
    // Site navigation vs the page itself: "the search box" of a scenario is rarely the header one.
    if (element.closest('header,nav,[role=banner],[role=navigation]')) item.area = 'header';
    else if (element.closest('footer,[role=contentinfo]')) item.area = 'footer';
    else if (element.closest('[role=dialog],dialog[open],[aria-modal="true"]')) item.area = 'dialog';
    return item;
  });
  // Repeated labels ("Đặt ngay" on every rate plan): show the text of the card that
  // holds each one so the AI can pick the right card.
  const groups = new Map();
  elements.forEach((item, index) => { const key = `${item.role || item.tag}|${item.name}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(index); });
  for (const [key, indexes] of groups) {
    const nameless = key.endsWith('|');
    if (indexes.length < 2 && !nameless) continue;
    for (const index of indexes) {
      const element = ordered[index], others = nameless ? [] : indexes.filter(other => other !== index).map(other => ordered[other]);
      let card = element;
      // Twins bound a repeated control's card; an unlabeled icon only needs nearby text.
      while (card.parentElement && card.parentElement !== document.body && !others.some(other => card.parentElement.contains(other))
        && (!nameless || clean(card.parentElement.innerText).length < 300)) card = card.parentElement;
      const context = clean(card.innerText, 240);
      if (context && context !== elements[index].name) elements[index].context = context;
    }
  }
  // A context shared by many elements (a whole calendar) tells them apart from nothing.
  const contexts = new Map();
  for (const item of elements) if (item.context) contexts.set(item.context, (contexts.get(item.context) ?? 0) + 1);
  for (const item of elements) if (item.context && contexts.get(item.context) > 3) delete item.context;
  const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog],dialog[open],[aria-modal="true"]')].filter(shown).slice(0, 3).map(dialog => clean(dialog.innerText, 300));
  const headings = [...document.querySelectorAll('h1,h2,h3')].filter(shown).slice(0, 12).map(heading => clean(heading.innerText, 100)).filter(Boolean);
  return { url: location.href, title: clean(document.title, 150), scroll: { y: Math.round(scrollY), max: Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight)) },
    dialogs, headings, text: clean(document.body?.innerText, textLimit), elements, truncated: picked.length > ordered.length };
}

/** In-page: the clickable element showing `wanted`, tagged with `tag`. An open popup,
 * suggestion list or dialog wins over the rest of the page, then the page body over the
 * header/footer, then the shortest matching text. */
function tagVisibleText({ wanted, tag, layerOnly }) {
  const normal = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const target = normal(wanted);
  if (!target) return null;
  const visible = element => {
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
  };
  // Really clickable now: the point under its centre belongs to it (not covered, not a
  // leftover of a closed popup). Off-screen entries are accepted: the click scrolls.
  const reachable = element => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return true;
    const top = document.elementFromPoint(x, y);
    return Boolean(top) && (element.contains(top) || top.contains(element));
  };
  const layer = '[role=listbox],[role=option],[role=dialog],[role=menu],[aria-modal="true"],dialog[open],[class*="suggest" i],[class*="dropdown" i],[class*="popover" i],[class*="autocomplete" i],[class*="popup" i]';
  let best = null, bestScore = Infinity;
  for (const element of document.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(element.tagName)) continue;
    const text = normal(element.innerText || element.getAttribute('aria-label'));
    // Page sections that merely contain the text somewhere are not the entry to click.
    if (!text.includes(target) || text.length > target.length + 160 || !visible(element) || !reachable(element)) continue;
    const score = (element.closest(layer) ? 0 : 100000) + (element.closest('header,nav,footer,[role=banner],[role=navigation],[role=contentinfo]') ? 50000 : 0)
      + (text.startsWith(target) ? 0 : 5000) + text.length;
    if (score < bestScore) { best = element; bestScore = score; }
  }
  if (!best) return null;
  // Suggestions arrive a moment after typing: until then a same-named link elsewhere on the
  // page ("Nha Trang" → destination guide) must not be taken instead.
  if (layerOnly && !best.closest(layer)) return null;
  let clickable = best.closest('a[href],button,[role=button],[role=option],[role=menuitem],[role=link],[role=tab],[role=gridcell],li,label,summary');
  if (!clickable) for (let node = best; node && node !== document.body; node = node.parentElement) {
    if (getComputedStyle(node).cursor === 'pointer') { clickable = node; if (!node.parentElement || getComputedStyle(node.parentElement).cursor !== 'pointer') break; }
  }
  (clickable || best).setAttribute('data-eventqa-ref', tag);
  return tag;
}

/** In-page: attributes of one numbered element, used to build a locator that keeps
 * working on later runs (refs exist only in the current page). */
function refInfo(ref) {
  const clean = (value, limit = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const element = document.querySelector(`[data-eventqa-ref="${CSS.escape(ref)}"]`);
  if (!element) return null;
  const tag = element.tagName.toLowerCase(), type = (element.getAttribute('type') || '').toLowerCase();
  const field = /^(input|textarea|select)$/.test(tag) || element.isContentEditable;
  let implicitRole = '';
  if (tag === 'a' && element.hasAttribute('href')) implicitRole = 'link';
  else if (tag === 'button' || tag === 'input' && ['button', 'submit', 'reset', 'image'].includes(type)) implicitRole = 'button';
  else if (tag === 'input' && ['checkbox', 'radio'].includes(type)) implicitRole = type;
  else if (tag === 'input' && type === 'search') implicitRole = 'searchbox';
  else if (tag === 'input' && type === 'number') implicitRole = 'spinbutton';
  else if (tag === 'input' && ['', 'text', 'email', 'tel', 'url', 'password'].includes(type) || tag === 'textarea') implicitRole = 'textbox';
  else if (tag === 'select') implicitRole = element.multiple || element.size > 1 ? 'listbox' : 'combobox';
  const by = (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ');
  const label = clean(by) || (element.labels?.length ? clean([...element.labels].map(item => item.innerText).join(' ')) : '');
  const text = field ? '' : clean(element.innerText, 120);
  const key = text || clean(element.getAttribute('aria-label')) || label;
  // The card around a repeated control: its largest ancestor holding no other
  // control with the same tag and text. Lines unique on the page anchor it.
  const anchors = [];
  if (key) {
    const twins = [...document.querySelectorAll(tag)].filter(other => other !== element && clean(other.innerText || other.getAttribute('aria-label'), 120) === key);
    if (twins.length) {
      let card = element;
      while (card.parentElement && card.parentElement !== document.body && !twins.some(twin => card.parentElement.contains(twin))) card = card.parentElement;
      const body = document.body.innerText;
      for (const line of String(card.innerText || '').split('\n').map(value => clean(value, 140))) {
        if (anchors.length >= 4) break;
        if (line.length < 4 || line.length > 120 || line === key || anchors.includes(line)) continue;
        if (body.split(line).length - 1 === 1) anchors.push(line);
      }
    }
  }
  const path = [];
  for (let node = element; node && node !== document.body && path.length < 12; node = node.parentElement) {
    const siblings = node.parentElement ? [...node.parentElement.children].filter(child => child.tagName === node.tagName) : [];
    path.unshift(siblings.length > 1 ? `${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})` : node.tagName.toLowerCase());
  }
  const id = element.id;
  // Ids generated per render (React useId "_r_g_"/":r1:", UI kits) differ on the next load.
  const stableId = id && /^[A-Za-z][\w-]{1,60}$/.test(id) && !/\d{3,}/.test(id) && !/[0-9a-f]{8}/i.test(id)
    && !/^(radix|headlessui|mui|react|ember|ext-gen|yui|base-ui|chakra|mantine|rc-|el-|ant-)/i.test(id) && !/_r_|:r|_$|«/.test(id);
  // A card link's own title (hotel name) is steadier than its whole text with prices.
  const titleNode = field ? null : element.querySelector('h1,h2,h3,h4,h5,h6,[class*="title" i],[class*="name" i]');
  const heading = clean(titleNode?.innerText, 100);
  let hrefPath = '';
  if (tag === 'a' && element.getAttribute('href')) { try { const url = new URL(element.href); if (url.origin === location.origin && url.pathname.length > 1) hrefPath = url.pathname; } catch { /* not a URL */ } }
  return { tag, field, role: element.getAttribute('role') || '', implicitRole, label, text,
    aria: clean(element.getAttribute('aria-label')), placeholder: clean(element.getAttribute('placeholder'), 120), title: clean(element.getAttribute('title')),
    alt: clean(element.querySelector?.('img[alt]')?.alt), valueText: tag === 'input' && ['button', 'submit', 'reset'].includes(type) ? clean(element.value) : '',
    testId: element.getAttribute('data-testid') || element.getAttribute('data-test-id') || element.getAttribute('data-test') || element.getAttribute('data-qa') || element.getAttribute('data-cy') || '',
    idSelector: stableId ? `#${CSS.escape(id)}` : '', nameAttr: element.getAttribute('name') || '', anchors, cssPath: `body > ${path.join(' > ')}`,
    heading: heading && heading !== text ? heading : '',
    hrefSelector: hrefPath ? (path => `a[href*="${path}?"], a[href$="${path}"]`)(hrefPath.replace(/["\\]/g, '\\$&')) : '' };
}

// Prices, review counts, a carousel counter ("1/30 Hòn Tằm…"), stock: not dates, which become variables.
const VOLATILE_NAME = /\d{1,3}([.,]\d{3})+\s*(₫|đ|vnd)?|\d+([.,]\d+)?k?\s*(đánh giá|reviews?|lượt)|^\d+\/\d+\s+(?=\p{L})|\d+\s*(%|phòng trống|còn lại)/iu;
const NAMED_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'switch', 'gridcell', 'spinbutton', 'treeitem', 'listbox']);
export function locatorCandidates(info) {
  const result = [], push = candidate => {
    if (!candidate.value || candidate.value.length > 200) return;
    const key = JSON.stringify(candidate);
    if (!result.some(item => JSON.stringify(item) === key)) result.push(candidate);
  };
  if (info.testId) push({ by: 'testId', value: info.testId });
  const role = info.role || info.implicitRole;
  // Names carrying prices, review counts or a carousel counter change from day to day;
  // they are tried only after steadier candidates.
  const volatile = name => VOLATILE_NAME.test(name);
  const names = [info.aria, info.label, info.text, info.title, info.alt, info.valueText].filter(Boolean);
  if (NAMED_ROLES.has(role)) for (const name of names.filter(name => !volatile(name))) push({ by: 'role', role, value: name, exact: true });
  if (info.field && info.label) push({ by: 'label', value: info.label, exact: true });
  if (info.placeholder) push({ by: 'placeholder', value: info.placeholder, exact: true });
  if (info.aria && !volatile(info.aria)) push({ by: 'label', value: info.aria, exact: true });
  if (info.heading && NAMED_ROLES.has(role)) push({ by: 'role', role, value: info.heading, exact: false });
  if (info.hrefSelector) push({ by: 'css', value: info.hrefSelector });
  if (info.text && info.text.length <= 80 && !volatile(info.text)) push({ by: 'text', value: info.text, exact: true });
  if (info.idSelector) push({ by: 'css', value: info.idSelector });
  if (info.nameAttr) push({ by: 'css', value: `${info.tag}[name="${info.nameAttr.replace(/["\\]/g, '\\$&')}"]` });
  if (NAMED_ROLES.has(role)) for (const name of names.filter(volatile)) push({ by: 'role', role, value: name, exact: true });
  return result;
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
    // When the test window is behind another window, the page counts as hidden and stops
    // rendering frames; Playwright then waits forever for elements to be "stable" and every
    // click stalls. Focus emulation keeps the tab rendering as if it were in front.
    const focusSession = await page.context().newCDPSession(page).catch(() => null);
    await focusSession?.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await page.addInitScript(SAME_TAB_SCRIPT).catch(() => {});
    await page.evaluate(SAME_TAB_SCRIPT).catch(() => {});
    let lastDialog = null, textPicks = 0;
    // An unanswered alert/confirm freezes the page; accept it and tell the AI.
    page.on('dialog', dialog => { lastDialog = { type: dialog.type(), message: String(dialog.message()).slice(0, 300) }; dialog.accept().catch(() => {}); });

    let disconnecting, stopReason = '';
    browser.on('disconnected', () => { stopReason ||= 'trình duyệt test đã đóng hoặc mất kết nối'; });
    const disconnect = () => disconnecting ??= (async () => { await focusSession?.detach().catch(() => {}); await browser.close(); })();
    const perform = (operation, actionSignal) => {
      if (disconnecting || !browser.isConnected()) throw new Error(`Kết nối tự động hóa đã dừng${stopReason ? ` (${stopReason})` : ''}.`);
      const combined = signal && actionSignal ? AbortSignal.any([signal, actionSignal]) : actionSignal ?? signal;
      // Disconnect on cancellation so an action waiting for a locator cannot
      // execute later after the runner has already reported cancellation.
      return abortable(operation, combined, () => { stopReason ||= `đã huỷ: ${abortReason(combined).message}`; return disconnect(); });
    };

    return {
      async inspect({ signal: inspectSignal } = {}) {
        const inspectionSignal = AbortSignal.any([...(inspectSignal ? [inspectSignal] : []), AbortSignal.timeout(30000)]);
        return perform(() => page.evaluate(() => {
          const clean = (value, max = 180) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
          const safeText = node => {
            if (node.matches?.('input,textarea,select,output,[contenteditable]')) return '';
            const copy = node.cloneNode(true);
            for (const field of copy.querySelectorAll('input,textarea,select,output,[contenteditable]')) field.remove();
            return copy.textContent;
          };
          const controls = [];
          const candidates = document.querySelectorAll('input,textarea,select,button,a[href],summary,[role="button"],[role="link"],[role="tab"],[role="combobox"],[role="textbox"],[role="checkbox"],[role="menuitem"]');
          let visited = 0;
          for (const element of candidates) {
            if (++visited > 2000) break;
            if (controls.length >= 160) break;
            const box = element.getBoundingClientRect(), style = getComputedStyle(element);
            if (!box.width || !box.height || style.visibility === 'hidden' || style.display === 'none' || element.type === 'hidden') continue;
            const tag = element.tagName.toLowerCase(), role = clean(element.getAttribute('role'), 40);
            const label = clean(element.getAttribute('aria-label') || [...(element.labels || [])].map(safeText).join(' ')
              || (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => { const node = document.getElementById(id); return node ? safeText(node) : ''; }).join(' '));
            // Text from form inputs, textareas and output containers is omitted.
            const text = /^(button|a|summary)$/.test(tag) || ['button', 'link', 'tab', 'menuitem'].includes(role) ? clean(safeText(element)) : '';
            const testId = clean(element.getAttribute('data-testid'));
            const placeholder = clean(element.getAttribute('placeholder'));
            const item = { tag, ...(role ? { role } : {}), ...(element.type ? { type: clean(element.type, 30) } : {}),
              ...(label ? { label } : {}), ...(text ? { text } : {}), ...(testId ? { testId } : {}), ...(placeholder ? { placeholder } : {}), disabled: Boolean(element.disabled),
              ...(element.type === 'password' ? { sensitive: true } : {}) };
            if (testId) item.locator = { by: 'testId', value: testId };
            else if (label) item.locator = { by: 'label', value: label, exact: false };
            else if (placeholder) item.locator = { by: 'placeholder', value: placeholder, exact: true };
            else if (text && (tag === 'button' || role === 'button')) item.locator = { by: 'role', role: 'button', value: text, exact: true };
            else if (text && (tag === 'a' || role === 'link')) item.locator = { by: 'role', role: 'link', value: text, exact: true };
            else if (element.id) item.locator = { by: 'css', value: `#${CSS.escape(element.id)}` };
            controls.push(item);
          }
          return { url: location.href, title: clean(document.title), controls, truncated: controls.length === 160 || visited > 2000 };
        }), inspectionSignal);
      },
      /** Numbered list of visible controls plus page text, for the AI. */
      async snapshot({ signal: snapshotSignal, max = 180, textLimit = 2000 } = {}) {
        const snapshotTimeout = AbortSignal.any([...(snapshotSignal ? [snapshotSignal] : []), AbortSignal.timeout(45000)]);
        return perform(async () => {
          // A redirect (e.g. to an SSO page) can replace the document mid-read: wait and read again.
          // A single-page app also shows a bare "Đang tải…/Đang kiểm tra đăng nhập…" screen
          // for a few seconds: that is not a page to act on yet.
          const loadingUntil = Date.now() + 12000;
          for (let attempt = 0; ; attempt++) {
            await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
            let result;
            try { result = await page.evaluate(pageSnapshot, { max, textLimit }); }
            catch (error) {
              if (attempt >= 3 || page.isClosed() || !NAVIGATING.test(String(error?.message))) throw error;
              await page.waitForTimeout(1000);
              continue;
            }
            const loading = result.elements.length < 6 && (result.text.length < 60 || LOADING_TEXT.test(result.text));
            if (loading && Date.now() < loadingUntil) { await page.waitForTimeout(800); continue; }
            if (loading) result.still_loading = true;
            if (lastDialog) { result.last_dialog = lastDialog; lastDialog = null; }
            return result;
          }
        }, snapshotTimeout);
      },
      /** A locator for a numbered element that is verified to match only that element
       * now, preferring test IDs, roles and labels over positions. */
      async locatorFor(ref, { anchorText, exactElement = false, signal: locatorSignal } = {}) {
        return perform(async () => {
          const info = await page.evaluate(refInfo, String(ref));
          if (!info) throw Object.assign(new Error(`Phần tử ${ref} không còn trên trang (trang vừa thay đổi).`), { code: 'REF_STALE' });
          const check = async candidate => {
            const target = locate(page, candidate);
            const count = await target.count();
            if (!count) return { count, index: -1 };
            const [index, self] = await target.evaluateAll((elements, { ref: wanted, exact }) => {
              const element = document.querySelector(`[data-eventqa-ref="${CSS.escape(wanted)}"]`);
              const position = elements.findIndex(item => item === element || !exact && element?.contains(item));
              return [position, position >= 0 && elements[position] === element];
            }, { ref: String(ref), exact: exactElement });
            return { count, index, self };
          };
          const anchors = [...new Set([...(anchorText ? [String(anchorText).trim()] : []), ...info.anchors])].filter(Boolean);
          // A locator that lands on the element itself beats one that lands on a child of it (the
          // display input of a custom select does not take clicks).
          let fallback = null, inner = null;
          for (const candidate of locatorCandidates(info)) {
            const outcome = await check(candidate).catch(() => ({ count: 0, index: -1 }));
            if (outcome.count === 1 && outcome.index === 0 && outcome.self) return candidate;
            if (outcome.count === 1 && outcome.index === 0) { inner ??= candidate; continue; }
            // Several links to the same page (card image and title): any of them is the same click.
            if (outcome.count > 1 && outcome.index >= 0 && candidate.value === info.hrefSelector) {
              const targets = await locate(page, candidate).evaluateAll(links => [...new Set(links.map(link => link.href.split('#')[0]))]).catch(() => []);
              if (targets.length === 1) return { ...candidate, nth: 0 };
            }
            if (outcome.count > 1) {
              for (const text of anchors) {
                const scoped = { ...candidate, within: { text } };
                const narrowed = await check(scoped).catch(() => ({ count: 0, index: -1 }));
                if (narrowed.count === 1 && narrowed.index === 0 && narrowed.self) return scoped;
                if (narrowed.count === 1 && narrowed.index === 0) inner ??= scoped;
              }
              if (!fallback && outcome.index >= 0 && outcome.count <= 50) fallback = { ...candidate, nth: outcome.index };
            }
          }
          return inner ?? fallback ?? { by: 'css', value: info.cssPath };
        }, locatorSignal);
      },
      /** Lets a single-page app finish reacting to the previous action: the document is
       * loaded and its DOM has been quiet for a moment (bounded), then `ms` more. */
      async settle({ signal: settleSignal, ms = 800, quietMs = 350, maxMs = 4000 } = {}) {
        return perform(async () => {
          await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
          await page.evaluate(({ quiet, max }) => new Promise(resolve => {
            let timer;
            const done = () => { observer.disconnect(); clearTimeout(timer); clearTimeout(limit); resolve(); };
            const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, quiet); });
            observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
            timer = setTimeout(done, quiet);
            const limit = setTimeout(done, max);
          }), { quiet: quietMs, max: maxMs }).catch(() => {});
          if (ms) await page.waitForTimeout(ms);
        }, settleSignal);
      },
      url: () => page.url(),
      async execute(action, { signal: actionSignal } = {}) {
        const budget = Math.max(1, action.timeout_ms ?? (action.type === 'goto' ? 30000 : 15000));
        const timeout = Math.min(action.type === 'goto' ? 30000 : 60000, Math.max(300, budget - TIMEOUT_MARGIN_MS));
        return perform(async () => {
          try {
            if (action.type === 'goto') { await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout }); return; }
            if (action.type === 'assert_url') { await page.waitForURL(url => url.href === action.url, { timeout, waitUntil: 'domcontentloaded' }); return; }
            if (action.type === 'wait_url') {
              const wanted = decodeURIComponent(String(action.contains));
              try { await page.waitForURL(url => decodeURIComponent(url.href).includes(wanted), { timeout, waitUntil: 'commit' }); }
              catch (error) { if (error?.name === 'TimeoutError') throw Object.assign(new Error(`Trang chưa tới địa chỉ có “${wanted}” sau ${Math.round(timeout / 100) / 10}s (đang ở ${decodeURIComponent(page.url()).slice(0, 160)}).`), { name: 'TimeoutError', code: 'ACTION_FAILED' }); throw error; }
              return;
            }
            if (action.type === 'wait_ms') { await page.waitForTimeout(Math.min(action.ms ?? 0, timeout)); return; }
            if (action.type === 'back') { await page.goBack({ waitUntil: 'domcontentloaded', timeout }).catch(error => { if (error?.name !== 'TimeoutError') throw error; }); return; }
            if (action.type === 'scroll') { await page.mouse.wheel(0, (action.direction === 'up' ? -1 : 1) * (action.amount ?? 700)); await page.waitForTimeout(400); return; }
            let target;
            if (action.locator?.by === 'visible_text') {
              // Wait for the text to show up (suggestions arrive after typing), then act on it.
              const end = Date.now() + timeout, tag = `vt${++textPicks}`;
              const layerUntil = Date.now() + Math.min(4000, timeout * 0.6);
              while (!(await page.evaluate(tagVisibleText, { wanted: action.locator.value, tag, layerOnly: Date.now() < layerUntil }).catch(() => null))) {
                if (Date.now() >= end) throw Object.assign(new Error(`Không thấy phần tử có chữ “${action.locator.value}” trên trang sau ${Math.round(timeout / 100) / 10}s.`), { name: 'TimeoutError', code: 'ACTION_FAILED' });
                await page.waitForTimeout(250);
              }
              target = page.locator(`[data-eventqa-ref="${tag}"]`);
            } else target = locate(page, action.locator);
            switch (action.type) {
              case 'click': {
                // A read-only display input of a custom select does not take clicks: its button does.
                const started = Date.now();
                const display = await target.evaluate(element => element.matches('input') && Boolean(element.parentElement?.closest('button,[role=button],[role=combobox],label'))
                  && (element.readOnly || element.tabIndex < 0 || getComputedStyle(element).pointerEvents === 'none'), undefined, { timeout: Math.min(2000, Math.floor(timeout / 3)) }).catch(() => false);
                await (display ? target.locator('xpath=ancestor::*[self::button or @role="button" or @role="combobox" or self::label][1]') : target).click({ timeout: Math.max(300, timeout - (Date.now() - started)) });
                break;
              }
              case 'hover': await target.hover({ timeout }); break;
              case 'fill': await target.fill(String(action.value), { timeout }); break;
              case 'type':
                // Click first like a person: many search boxes open their suggestion list on click,
                // not on a programmatic focus. A covered field still gets focused and typed into.
                await target.click({ timeout: Math.min(timeout, 3000) }).catch(() => target.focus({ timeout: Math.min(timeout, 2000) }));
                await target.fill('', { timeout });
                await target.pressSequentially(String(action.value), { delay: 45, timeout });
                break;
              case 'select': await target.selectOption(action.value, { timeout }); break;
              case 'check': await target.setChecked(action.checked, { timeout }); break;
              case 'press': await target.press(action.key, { timeout }); break;
              case 'wait_for': await target.waitFor({ state: action.state ?? 'visible', timeout }); break;
              case 'assert_text': {
                const end = Date.now() + timeout;
                while (true) {
                  checkAborted(actionSignal ?? signal);
                  const text = await target.textContent({ timeout: Math.max(1, end - Date.now()) });
                  if (String(text ?? '').replace(/\s+/g, ' ').includes(String(action.text).replace(/\s+/g, ' '))) break;
                  if (Date.now() >= end) throw Object.assign(new Error(`${describeLocator(action.locator)} chưa chứa “${action.text}”.`), { name: 'TimeoutError', code: 'ACTION_FAILED' });
                  await new Promise(resolve => setTimeout(resolve, Math.min(150, Math.max(1, end - Date.now()))));
                }
                break;
              }
              default: throw new Error('Thao tác tự động hóa không được hỗ trợ.');
            }
          } catch (error) { throw humanizeError(error, action, timeout); }
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
