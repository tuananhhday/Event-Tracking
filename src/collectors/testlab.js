// EventQA · Insider Test Lab reader. Runs in the test browser on Insider panel pages (*.useinsider.com)
// only, reads the Test Results table and reports it through the __eventqa_testlab binding each time it
// changes. It reads the page and never changes it.
//
// Insider renders Test Results with ag-Grid: one row per event received (level 0, numbered in the group
// column: 1, 2, 3… newest first) and one row per parameter under it (level 1, group column "4, c_slug":
// receipt number and the parameter's key). Cells are named by col-id; status is the icon's tooltip.
// ag-Grid only puts the rows near the visible part into the page, and none of a collapsed event's
// parameters, so each reading says which events it saw whole. When the grid's own row model can be
// reached and agrees with the rows on screen, every row is read from it instead.
// Any other table is read by its column headers (STATUS · NAME · TYPE · VALUE) and cell positions.
(() => {
  'use strict';
  if (!/(?:^|\.)useinsider\.com$/i.test(location.hostname)) return;
  const KEY = Symbol.for('eventqa.testlab.v1');
  if (window[KEY]) { window[KEY].scan(); return; }
  const state = { last: '', htmlSent: 0, missingFor: '', modelNote: '', timer: 0, observer: null, stopped: false };
  window[KEY] = state;
  const send = message => {
    try { if (typeof window.__eventqa_testlab === 'function') { window.__eventqa_testlab(JSON.stringify(message)); return true; } } catch { /* never disturb the panel */ }
    return false;
  };
  const norm = text => String(text ?? '').replace(/\s+/g, ' ').trim();
  const HEADERS = ['status', 'name', 'type', 'value', 'actions'];
  const rectOf = node => {
    if (node.nodeType === 3) { const range = document.createRange(); range.selectNodeContents(node); const rect = range.getBoundingClientRect(); range.detach?.(); return rect; }
    return node.getBoundingClientRect();
  };
  const visible = rect => rect.width > 0 && rect.height > 0;
  function textNodes(root) {
    const out = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        const parent = node.parentElement;
        if (!parent || !norm(node.nodeValue) || /^(?:SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      } });
    for (let node = walker.nextNode(); node && out.length < 20000; node = walker.nextNode()) out.push(node);
    return out;
  }
  // The text pieces of a cell, in order ("Event Parameter", "Custom").
  const pieces = element => element ? textNodes(element).map(node => norm(node.nodeValue)).filter(Boolean) : [];

  // ---- status ---------------------------------------------------------------------------------
  const STATUS_WORDS = [['failed', /fail|error|danger|invalid|wrong|cross|times-circle|x-circle/], ['in_progress', /progress|loading|spin|sync|refresh|pending|waiting|running/],
    ['successful', /success|succeed|passed|check|done|complete|valid\b/], ['not_tested', /not[-_ ]?tested|untested|idle|empty/]];
  /** "Success", "In Progress", "failed", "not_tested"… as one of the reader's statuses; null when not a status word. */
  function statusWord(text) {
    const words = String(text ?? '').toLowerCase();
    if (!words) return null;
    if (/not[-_ ]?tested|untested/.test(words)) return 'not_tested';
    const found = STATUS_WORDS.find(([, pattern]) => pattern.test(words));
    return found ? found[0] : null;
  }
  function colorStatus(color) {
    const match = String(color).match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/);
    if (!match || (match[4] !== undefined && Number(match[4]) < 0.25)) return null;
    const [r, g, b] = [match[1], match[2], match[3]].map(value => Number(value) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), light = (max + min) / 2, delta = max - min;
    if (light > 0.93 || light < 0.08) return null;
    const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * light - 1));
    if (saturation < 0.3) return { status: 'not_tested', weight: 1 };
    let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
    const weight = 2 + saturation;
    if (hue < 18 || hue >= 330) return { status: 'failed', weight };
    if (hue < 65) return { status: 'in_progress', weight };
    if (hue < 170) return { status: 'successful', weight };
    return null;
  }
  // The status of a cell: the tooltip/label of its icon (what the panel says on hover), then the icon's
  // colour, then the words in its classes. The hint is kept so a wrong reading can be checked.
  function statusOfElements(elements) {
    const hints = [], votes = new Map();
    for (const element of elements.slice(0, 40)) {
      const label = element.getAttribute('data-tooltip') || element.getAttribute('aria-label') || element.getAttribute('title');
      const said = statusWord(label);
      if (said) return { status: said, text: norm(label), hint: norm(label) };
      const words = [element.getAttribute('class'), element.getAttribute('data-status'), element.getAttribute('data-icon'), element.getAttribute('name'),
        element.getAttribute('href') ?? element.getAttribute('xlink:href'), element.tagName.toLowerCase()].filter(Boolean).join(' ');
      if (words) hints.push(words);
      const style = getComputedStyle(element);
      for (const color of [style.color, style.fill, style.stroke, style.backgroundColor]) {
        const vote = colorStatus(color);
        if (vote) votes.set(vote.status, (votes.get(vote.status) ?? 0) + vote.weight);
      }
    }
    const hint = hints.join(' | ').toLowerCase().slice(0, 300);
    const colored = [...votes].filter(([status]) => status !== 'not_tested').sort((a, b) => b[1] - a[1]);
    if (colored.length) return { status: colored[0][0], hint };
    const word = STATUS_WORDS.find(([, pattern]) => pattern.test(hint));
    if (word) return { status: word[0], hint };
    return { status: votes.has('not_tested') ? 'not_tested' : 'unknown', hint };
  }
  const statusOfCell = cell => {
    if (!cell) return { status: 'unknown', hint: '' };
    const elements = [cell, ...cell.querySelectorAll('*')].filter(element => visible(rectOf(element)) || element.hasAttribute('data-tooltip'));
    // A tooltip says it first; a status written out in the cell ("Success") comes next.
    if (!elements.some(element => statusWord(element.getAttribute('data-tooltip') || element.getAttribute('aria-label') || element.getAttribute('title')))) {
      const said = statusWord(norm(cell.textContent));
      if (said) return { status: said, text: norm(cell.textContent) };
    }
    return statusOfElements(elements);
  };

  // ---- the header: which column is STATUS, NAME, TYPE, VALUE ------------------------------------
  // The header labels are the whole text of their element (a header, not a sentence saying "name").
  function headerLabels(root) {
    const labels = new Map(HEADERS.map(name => [name, []]));
    for (const node of textNodes(root)) {
      const text = norm(node.nodeValue).toLowerCase();
      if (labels.has(text) && norm(node.parentElement.textContent).toLowerCase() === text && visible(rectOf(node))) labels.get(text).push(node.parentElement);
    }
    return labels;
  }

  // ---- ag-Grid ----------------------------------------------------------------------------------
  function findAgGrid() {
    for (const root of document.querySelectorAll('.ag-root-wrapper, .ag-root')) {
      if (root.parentElement?.closest('.ag-root-wrapper, .ag-root') && root.classList.contains('ag-root')) continue;
      const cols = {};
      for (const header of root.querySelectorAll('.ag-header-cell[col-id], [role=columnheader][col-id]')) {
        const text = norm(header.textContent).toLowerCase();
        if (HEADERS.includes(text) && !cols[text]) cols[text] = header.getAttribute('col-id');
      }
      if (cols.name && cols.type && cols.value) return { root, cols };
    }
    return null;
  }
  const levelOf = row => {
    const aria = Number(row.getAttribute('aria-level'));
    if (Number.isInteger(aria) && aria > 0) return aria - 1;
    const match = String(row.className).match(/ag-row-level-(\d+)/);
    return match ? Number(match[1]) : 0;
  };
  // The group column shows the row's path: "4" for an event, "4, c_slug" for one of its parameters.
  const pathOf = text => norm(text) ? norm(text).split(/\s*,\s*/) : [];

  function agDomRows(grid) {
    const { root, cols } = grid, rows = new Map();
    for (const element of root.querySelectorAll('[role=row][row-id]')) {
      if (element.closest('.ag-header')) continue;
      const id = element.getAttribute('row-id');
      const row = rows.get(id) ?? { id, element: null, index: null, level: 0, expanded: null, group: false, cells: new Map() };
      // Pinned and centre parts of one row share its row-id; the cells are gathered from all of them.
      for (const cell of element.querySelectorAll('[col-id]')) if (!row.cells.has(cell.getAttribute('col-id')) || norm(cell.textContent)) row.cells.set(cell.getAttribute('col-id'), cell);
      const index = Number(element.getAttribute('row-index'));
      if (Number.isInteger(index)) row.index = index;
      row.level = Math.max(row.level, levelOf(element));
      // An event row with parameters is a group row, open (expanded) or closed (contracted); one without is not.
      const classes = element.classList;
      if (classes.contains('ag-row-group')) row.group = true;
      if (classes.contains('ag-row-group-expanded')) row.expanded = true;
      else if (classes.contains('ag-row-group-contracted')) row.expanded = false;
      const expanded = element.getAttribute('aria-expanded');
      if (row.expanded === null && (expanded === 'true' || expanded === 'false')) { row.expanded = expanded === 'true'; row.group = true; }
      if (!row.element || element.closest('.ag-center-cols-container')) row.element = element;
      rows.set(id, row);
    }
    const groupCol = [...new Set([...rows.values()].flatMap(row => [...row.cells.keys()]))].find(id => id !== cols.name && [...rows.values()].some(row => row.cells.get(id)?.querySelector('.ag-group-value')));
    const out = [];
    for (const row of rows.values()) {
      const cell = id => id ? row.cells.get(id) : null;
      const name = norm(cell(cols.name)?.textContent);
      const [type = '', ...rest] = pieces(cell(cols.type));
      const groupCell = cell(groupCol);
      const path = pathOf(groupCell?.querySelector('.ag-group-value')?.textContent ?? groupCell?.textContent);
      if (row.expanded === null && groupCell) {
        const open = groupCell.querySelector('.ag-group-expanded'), closed = groupCell.querySelector('.ag-group-contracted');
        const shown = icon => icon && !icon.classList.contains('ag-hidden');
        if (shown(open) || shown(closed)) { row.expanded = shown(open); row.group = true; }
      }
      const valueCell = cell(cols.value);
      // The full value: a long one is cut on screen ("…") but kept whole in the cell and its tooltip.
      const tip = valueCell?.querySelector('[data-tooltip]')?.getAttribute('data-tooltip');
      let value = norm(valueCell?.textContent);
      if (tip && norm(tip).length > value.length && norm(tip).startsWith(value.replace(/(?:…|\.\.\.)$/, ''))) value = norm(tip);
      const status = statusOfCell(cell(cols.status));
      out.push({ id: row.id, index: row.index, level: row.level, expanded: row.expanded, leaf: row.level === 0 && !row.group && row.expanded === null, path, name, type, subtype: rest.join(' '), value, status: status.status,
        ...(status.text ? { status_text: status.text } : {}), ...(status.hint ? { status_hint: status.hint } : {}) });
    }
    return out.sort((a, b) => (a.index ?? 1e9) - (b.index ?? 1e9));
  }
  // How many rows the grid displays (its rows container is as tall as all of them), to know whether the
  // last rendered rows are really the end.
  function agDisplayedCount(root) {
    const container = root.querySelector('.ag-center-cols-container');
    const sample = root.querySelector('.ag-center-cols-container [role=row][row-id]');
    const total = parseFloat(container?.style.height), height = parseFloat(sample?.style.height) || sample?.getBoundingClientRect().height;
    return total > 0 && height > 0 ? Math.round(total / height) : null;
  }

  // The grid's row model, reached from a rendered row (ag-Grid keeps its row controller on the element).
  function agModel(grid, domRows) {
    const { root, cols } = grid, note = { found: false };
    let node = null;
    for (const element of root.querySelectorAll('[role=row][row-id]')) {
      for (const name of Object.getOwnPropertyNames(element)) {
        if (!name.startsWith('__AG')) continue;
        const data = element[name];
        if (!data || typeof data !== 'object') continue;
        const ctrl = data.renderedRow ?? data.rowCtrl ?? Object.values(data).find(value => value && typeof value === 'object' && (typeof value.getRowNode === 'function' || value.rowNode));
        node = ctrl && (typeof ctrl.getRowNode === 'function' ? ctrl.getRowNode() : ctrl.rowNode);
        if (node) { note.via = 'dom-data'; break; }
      }
      if (!node && element.__agComponent) {
        const component = element.__agComponent, ctrl = component.rowCtrl ?? component;
        node = typeof ctrl.getRowNode === 'function' ? ctrl.getRowNode() : ctrl.rowNode ?? null;
        if (node) note.via = 'component';
      }
      if (node) break;
    }
    if (!node) return { note };
    note.found = true;
    const api = [node.beans?.gridApi, node.gridApi, node.api, node.beans?.gridOptionsService?.api, node.gridOptionsWrapper?.gridOptions?.api].find(candidate => candidate && typeof candidate.forEachNode === 'function');
    note.api = Boolean(api);
    const nodes = [];
    if (api) api.forEachNode(each => { if (nodes.length < 5000) nodes.push(each); });
    else {
      let top = node;
      while (top.parent) top = top.parent;
      const walk = parent => { for (const child of parent.childrenAfterGroup ?? parent.childrenAfterFilter ?? parent.allLeafChildren ?? []) { if (nodes.length >= 5000) return; nodes.push(child); walk(child); } };
      walk(top);
    }
    note.nodes = nodes.length;
    const cellValue = (each, col) => {
      if (!col) return undefined;
      try { if (typeof api?.getCellValue === 'function') return api.getCellValue({ rowNode: each, colKey: col }); } catch { /* older grid */ }
      try { if (typeof api?.getValue === 'function') return api.getValue(col, each); } catch { /* no such column */ }
      return each.data?.[col];
    };
    const text = value => value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : norm(value);
    const pathTo = each => { const path = []; for (let at = each; at && at.parent && path.length < 6; at = at.parent) path.unshift(String(at.key ?? at.id ?? '')); return path; };
    const rows = nodes.filter(each => each.level >= 0 && (each.data || each.key != null)).map(each => {
      const level = Number.isInteger(each.level) ? each.level : 0, path = pathTo(each), key = path.at(-1) ?? '';
      const kind = each.data?.kind;
      const typeValue = cellValue(each, cols.type), sub = typeof typeValue === 'string' && /custom|default/i.test(typeValue) ? typeValue : each.data?.type;
      const status = cellValue(each, cols.status);
      return { id: String(each.id), level, path, expanded: level === 0 ? each.expanded !== false : null, leaf: level === 0 && !(each.childrenAfterGroup?.length || each.allChildrenCount), name: text(cellValue(each, cols.name)),
        type: level === 0 ? (/attribute/i.test(kind ?? '') ? 'Attribute' : 'Event') : 'Event Parameter',
        subtype: /custom/i.test(sub ?? '') || (!sub && /^c_/.test(key)) ? 'Custom' : 'Default',
        value: text(cellValue(each, cols.value)), status: statusWord(typeof status === 'string' ? status : status?.status ?? status?.label) ?? 'unknown', from: 'model' };
    });
    // Trusted only when it names every row on screen as the screen does.
    const byId = new Map(rows.map(row => [row.id, row]));
    const shown = domRows.filter(row => row.name);
    const disagree = shown.filter(row => byId.get(row.id)?.name !== row.name);
    note.verified = shown.length > 0 && disagree.length === 0;
    if (!note.verified) note.mismatch = disagree.slice(0, 3).map(row => ({ id: row.id, screen: row.name, model: byId.get(row.id)?.name ?? null }));
    // A few raw rows, so the reader can be fitted to the grid's real data if it disagrees.
    note.sample = nodes.slice(0, 3).map(each => { try { return { id: each.id, key: each.key, level: each.level, data: JSON.parse(JSON.stringify(each.data ?? null, (k, v) => typeof v === 'string' ? v.slice(0, 200) : v)) }; } catch { return { id: each.id }; } });
    return { note, rows: note.verified ? rows : null };
  }

  // Events of a grid reading: each level-0 row with the parameter rows under it. An event is whole when
  // its rows run, without a gap, from it to the next event or to the last row the grid displays.
  function agGroups(rows, displayed, fromModel) {
    const byIndex = new Map(rows.filter(row => Number.isInteger(row.index)).map(row => [row.index, row]));
    const groups = new Map();
    const groupOf = row => row.path[0] ?? null;
    for (const row of rows) {
      if (row.level !== 0 || !row.name) continue;
      const id = groupOf(row) ?? `row-${row.id}`;
      groups.set(id, { group: id, name: row.name, type: row.type, subtype: row.subtype, value: row.value, status: row.status,
        ...(row.status_text ? { status_text: row.status_text } : {}), ...(row.status_hint ? { status_hint: row.status_hint } : {}),
        // An event without parameters is whole as it is; a closed one shows none of its parameters.
        collapsed: !fromModel && row.expanded === false, complete: fromModel || Boolean(row.leaf), params: [] });
      if (fromModel || row.leaf || row.expanded === false || !Number.isInteger(row.index)) continue;
      for (let index = row.index + 1; ; index++) {
        const next = byIndex.get(index);
        if (!next) { groups.get(id).complete = displayed !== null && index >= displayed; break; }
        if (next.level === 0) { groups.get(id).complete = true; break; }
      }
    }
    // Without a group column a parameter belongs to the event row above it.
    let above = null;
    for (const row of rows) {
      if (row.level === 0) { above = row.name ? groupOf(row) ?? `row-${row.id}` : null; continue; }
      if (!row.name) continue;
      const id = groupOf(row) ?? above;
      const param = { key: row.path.length > 1 ? row.path.at(-1) : null, name: row.name, type: row.type, subtype: row.subtype, value: row.value, status: row.status,
        ...(row.status_text ? { status_text: row.status_text } : {}), ...(row.status_hint ? { status_hint: row.status_hint } : {}) };
      if (groups.has(id)) groups.get(id).params.push(param);
      // The event row is scrolled away: its parameters still go to it, by receipt number.
      else if (id) groups.set(id, { group: id, name: null, params: [param], complete: false });
    }
    return [...groups.values()];
  }

  function readAgGrid(grid) {
    const domRows = agDomRows(grid);
    const model = agModel(grid, domRows);
    let rows = domRows, fromModel = false;
    if (model.rows) {
      // What the screen shows wins for the rows on it; the model adds the rows ag-Grid has not drawn.
      const shown = new Map(domRows.map(row => [row.id, row]));
      rows = model.rows.map(row => shown.has(row.id) ? { ...shown.get(row.id), path: shown.get(row.id).path.length ? shown.get(row.id).path : row.path } : row);
      fromModel = true;
    }
    return { reader: fromModel ? 'ag-grid-model' : 'ag-grid', groups: agGroups(rows, agDisplayedCount(grid.root), fromModel), model: model.note, container: grid.root };
  }

  // ---- any other table ---------------------------------------------------------------------------
  function findHeader() {
    if (!document.body) return null;
    const labels = headerLabels(document.body);
    let best = null;
    for (const nameLabel of labels.get('name')) {
      let row = nameLabel.parentElement;
      for (let depth = 0; row && depth < 8; depth++, row = row.parentElement) {
        const inside = key => labels.get(key).find(label => row.contains(label));
        const status = inside('status'), type = inside('type'), value = inside('value');
        if (status && type && value) {
          const candidate = { row, status, name: nameLabel, type, value, actions: inside('actions') };
          if (!best || best.row.contains(row)) best = candidate;
          break;
        }
      }
    }
    return best;
  }
  // The header cell of a label: its ancestor that is a direct child of the header row.
  const cellOf = (node, row) => { let cell = node.nodeType === 3 ? node.parentElement : node; while (cell?.parentElement && cell.parentElement !== row) cell = cell.parentElement; return cell; };
  function readTable() {
    const header = findHeader();
    if (!header) return null;
    const headerRect = rectOf(header.row);
    const cols = ['status', 'name', 'type', 'value', 'actions'].filter(key => header[key]).map(key => ({ key, left: rectOf(cellOf(header[key], header.row)).left }));
    cols.sort((a, b) => a.left - b.left);
    cols.forEach((col, index) => { col.right = cols[index + 1]?.left ?? Infinity; });
    const col = key => cols.find(entry => entry.key === key);
    const nameCol = col('name'), valueCol = col('value');
    let container = header.row.parentElement;
    for (let depth = 0; container && depth < 10; depth++) {
      if (rectOf(container).bottom > headerRect.bottom + 8) break;
      container = container.parentElement;
    }
    if (!container) return null;
    const rows = new Map();
    for (const node of textNodes(container)) {
      if (header.row.contains(node)) continue;
      const rect = rectOf(node);
      if (!visible(rect) || rect.top < headerRect.bottom - 2) continue;
      // The row: the lowest element spanning the NAME and VALUE columns.
      let row = node.parentElement;
      while (row && row !== container) {
        const box = rectOf(row);
        if (box.left <= nameCol.left + 4 && box.right >= valueCol.left + 4) break;
        row = row.parentElement;
      }
      if (!row || row === container) continue;
      // The column of the text's cell (cells keep to their column; long text may run past it).
      const cell = cellOf(node, row), box = cell && cell !== row ? rectOf(cell) : rect;
      const center = box.left + Math.min(box.width, 40) / 2;
      const column = cols.find(entry => center >= entry.left && center < entry.right);
      if (!column) continue;
      if (!rows.has(row)) rows.set(row, { element: row, top: rectOf(row).top, cells: { status: [], name: [], type: [], value: [], actions: [] }, statusCell: null });
      rows.get(row).cells[column.key].push(norm(node.nodeValue));
    }
    const groups = [];
    for (const { element, cells } of [...rows.values()].sort((a, b) => a.top - b.top)) {
      const name = cells.name.join(' '), [type = '', ...rest] = cells.type;
      if (!name || !type) continue;
      const statusCol = col('status'), box = rectOf(element);
      const status = statusCol ? statusOfElements([...element.querySelectorAll('*')].filter(item => {
        const rect = rectOf(item), center = rect.left + rect.width / 2;
        return (visible(rect) || item.hasAttribute('data-tooltip')) && center >= statusCol.left && center < statusCol.right && rect.top >= box.top - 2 && rect.bottom <= box.bottom + 2;
      })) : { status: 'unknown', hint: '' };
      const entry = { name, type, subtype: rest.join(' '), value: cells.value.join(' '), status: status.status, ...(status.text ? { status_text: status.text } : {}), ...(status.hint ? { status_hint: status.hint } : {}) };
      if (/param/i.test(type) && groups.length) groups.at(-1).params.push({ key: null, ...entry });
      else if (!/param/i.test(type)) groups.push({ group: null, ...entry, collapsed: false, complete: true, params: [] });
    }
    return { reader: 'table', groups, container };
  }

  function scan() {
    if (state.stopped) return;
    let table;
    try { const grid = findAgGrid(); table = grid ? readAgGrid(grid) : readTable(); }
    catch (error) { send({ kind: 'error', url: location.href, message: String(error?.message || error).slice(0, 300) }); return; }
    if (!table || !table.groups.length) {
      // A Test Lab page whose table was not recognised: one copy of its markup per address, to fix the reader.
      if (!table && state.missingFor !== location.href && /test\s*results|test\s*lab/i.test(document.body?.innerText ?? '')) {
        if (send({ kind: 'missing', url: location.href, title: document.title, at: new Date().toISOString(), html: document.body.outerHTML.slice(0, 400000) })) state.missingFor = location.href;
      }
      return;
    }
    const signature = JSON.stringify([table.reader, table.groups]);
    if (signature === state.last) return;
    const message = { kind: 'table', url: location.href, title: document.title, at: new Date().toISOString(), reader: table.reader, groups: table.groups };
    // The grid's model note when it changes, and the table's markup with the first readings, so the
    // reader can be checked against the real page.
    const modelNote = JSON.stringify(table.model ?? null);
    if (modelNote !== state.modelNote) message.model = table.model ?? null;
    if (state.htmlSent < 30) message.html = table.container.outerHTML.slice(0, 300000);
    if (!send(message)) return;
    state.last = signature; state.modelNote = modelNote;
    if (message.html) state.htmlSent++;
  }
  const later = () => { if (!state.stopped && !state.timer) state.timer = setTimeout(() => { state.timer = 0; scan(); }, 600); };
  state.scan = later;
  state.stop = () => { state.stopped = true; clearTimeout(state.timer); state.observer?.disconnect(); };
  const start = () => {
    if (state.stopped || state.observer || !document.documentElement) return;
    state.observer = new MutationObserver(later);
    state.observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-expanded', 'data-tooltip'] });
    later();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
