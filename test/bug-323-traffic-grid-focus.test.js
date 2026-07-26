import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const appSource = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');

function extract(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must be present`);
  return appSource.slice(start, end);
}

const activeDescendantSource = extract(
  'function updateTrafficActiveDescendant(',
  'function selectRequest('
);
const rowSelectionSource = extract(
  'function updateTrafficActiveDescendant(',
  'function selectBreakpointRequest('
);
const virtualRowsSource = extract('function renderVirtualRows()', 'function renderTraffic()');
const keyboardSelectionSource = extract(
  'function selectRequestByIndex(',
  '// ============ WS FRAME EXPAND/COLLAPSE'
);
const shortcutsSource = extract(
  'function isEditableKeyboardTarget(',
  '// ============ MONACO EDITOR'
);

test('Traffic grid is the focusable active-descendant owner', () => {
  const wrapper = html.match(/<div[^>]*id="trafficTableWrapper"[^>]*>/)?.[0] || '';
  const grid = html.match(/<table[^>]*id="trafficGrid"[^>]*>/)?.[0] || '';
  const body = html.match(/<tbody[^>]*id="trafficBody"[^>]*>/)?.[0] || '';

  assert.match(wrapper, /role="region"/);
  assert.match(wrapper, /tabindex="-1"/);
  assert.match(grid, /role="grid"/);
  assert.match(grid, /tabindex="0"/);
  assert.doesNotMatch(body, /aria-activedescendant/);
});

test('active descendant is set only for a rendered row owned by the grid', () => {
  const attributes = new Map();
  const ownedRow = { id: 'row-owned' };
  const staleRow = { id: 'row-stale' };
  const grid = {
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name)
  };
  const body = { contains: row => row === ownedRow };
  const elements = new Map([
    ['trafficGrid', grid],
    ['trafficBody', body],
    ['row-owned', ownedRow],
    ['row-stale', staleRow]
  ]);
  const context = {
    document: { getElementById: id => elements.get(id) || null }
  };
  vm.createContext(context);
  vm.runInContext(`${activeDescendantSource}; globalThis.syncActiveRow = updateTrafficActiveDescendant;`, context);

  context.syncActiveRow('owned');
  assert.equal(attributes.get('aria-activedescendant'), 'row-owned');
  context.syncActiveRow('stale');
  assert.equal(attributes.has('aria-activedescendant'), false);
  context.syncActiveRow(null);
  assert.equal(attributes.has('aria-activedescendant'), false);
});

function createVirtualGridHarness() {
  const requests = Array.from({ length: 100 }, (_, index) => ({ id: `request-${index}` }));
  const rows = new Map();
  const attributes = new Map();
  const grid = {
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name)
  };
  const body = {
    _html: '',
    contains: row => [...rows.values()].includes(row),
    set innerHTML(value) {
      this._html = value;
      rows.clear();
      for (const match of value.matchAll(/id="([^"]+)"[^>]*aria-selected="(true|false)"/g)) {
        rows.set(match[1], { id: match[1], ariaSelected: match[2] });
      }
    },
    get innerHTML() { return this._html; }
  };
  const wrapper = {
    scrollTop: 0,
    clientHeight: 198
  };
  const context = {
    filteredRequests: requests,
    selectedRequestId: null,
    VS_ROW_HEIGHT: 32,
    VS_HEADER_HEIGHT: 38,
    VS_BUFFER: 15,
    vsForceRender: true,
    vsRenderStart: -1,
    vsRenderEnd: -1,
    window: { location: { hash: '#/view' } },
    history: { replaceState() {} },
    buildTrafficViewHash: id => `#/view/${id}`,
    showDetail() {},
    scrollRowIntoView(index) { wrapper.scrollTop = Math.max(0, index * 32 - 64); },
    buildRowHtml(request, index) {
      return `<tr id="row-${request.id}" role="row" aria-rowindex="${index + 1}" aria-selected="${request.id === context.selectedRequestId}"></tr>`;
    },
    document: {
      getElementById(id) {
        if (id === 'trafficGrid') return grid;
        if (id === 'trafficBody') return body;
        if (id === 'trafficTableWrapper') return wrapper;
        return rows.get(id) || null;
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${activeDescendantSource}
    ${virtualRowsSource}
    ${keyboardSelectionSource}
    globalThis.gridApi = {
      render: renderVirtualRows,
      keyboard: selectRequestByIndex,
      setForce(value) { vsForceRender = value; },
      setRequests(value) { filteredRequests = value; }
    };
  `, context);
  return { context, requests, rows, attributes, body, wrapper, gridApi: context.gridApi };
}

test('keyboard selection renders and selects the active virtual row before referencing it', () => {
  const harness = createVirtualGridHarness();

  harness.gridApi.keyboard('last');

  assert.equal(harness.context.selectedRequestId, 'request-99');
  assert.equal(harness.rows.get('row-request-99')?.ariaSelected, 'true');
  assert.equal(harness.attributes.get('aria-activedescendant'), 'row-request-99');

  harness.wrapper.scrollTop = 0;
  harness.gridApi.setForce(false);
  harness.gridApi.render();
  assert.equal(harness.rows.has('row-request-99'), false);
  assert.equal(harness.attributes.has('aria-activedescendant'), false);

  harness.gridApi.setRequests([]);
  harness.gridApi.setForce(true);
  harness.gridApi.render();
  assert.equal(harness.body.innerHTML, '');
  assert.equal(harness.attributes.has('aria-activedescendant'), false);
});

function keyboardElement(tagName = 'DIV', options = {}) {
  return {
    id: options.id || '',
    tagName,
    isContentEditable: false,
    hasAttribute: () => false,
    matches: selector => selector === '#trafficBody tr[data-id]' && options.row === true,
    closest(selector) {
      if (options.interactive && selector.includes('[tabindex]:not([tabindex="-1"])')) return {};
      if (options.separator && selector.includes('[role="separator"]')) return {};
      return null;
    }
  };
}

function createKeyboardHarness({ activePanel = true } = {}) {
  let keydown;
  const navigation = [];
  const grid = keyboardElement('TABLE', { id: 'trafficGrid' });
  grid.focus = () => { document.activeElement = grid; };
  const panel = { classList: { contains: value => value === 'active' && activePanel } };
  const document = {
    activeElement: keyboardElement(),
    addEventListener(type, handler) { if (type === 'keydown') keydown = handler; },
    getElementById(id) {
      if (id === 'panel-traffic') return panel;
      if (id === 'trafficGrid') return grid;
      return null;
    },
    querySelector: () => null
  };
  vm.runInNewContext(shortcutsSource, {
    document,
    selectRequestByIndex: direction => navigation.push(direction)
  });
  return {
    document,
    grid,
    navigation,
    press(key, target, overrides = {}) {
      let prevented = 0;
      keydown({
        key,
        target,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault: () => { prevented++; },
        ...overrides
      });
      return prevented;
    }
  };
}

test('grid and focused rows navigate, while headers, resizers, and other panels do not', () => {
  const harness = createKeyboardHarness();
  assert.equal(harness.press('ArrowDown', harness.grid), 1);
  assert.deepEqual(harness.navigation, [1]);
  assert.equal(harness.document.activeElement, harness.grid);

  const row = keyboardElement('TR', { row: true });
  harness.document.activeElement = row;
  assert.equal(harness.press('End', row), 1);
  assert.deepEqual(harness.navigation, [1, 'last']);
  assert.equal(harness.document.activeElement, harness.grid);

  const header = keyboardElement('TH', { interactive: true });
  assert.equal(harness.press('Home', header), 0);
  const resizer = keyboardElement('DIV', { separator: true });
  assert.equal(harness.press('ArrowDown', resizer), 0);
  assert.deepEqual(harness.navigation, [1, 'last']);

  const inactive = createKeyboardHarness({ activePanel: false });
  assert.equal(inactive.press('ArrowDown', inactive.grid), 0);
  assert.deepEqual(inactive.navigation, []);
});

test('Ctrl+[ focuses the grid owner, and mouse selection does not force focus', () => {
  const keyboard = createKeyboardHarness();
  assert.equal(keyboard.press('[', keyboardElement(), { ctrlKey: true }), 1);
  assert.equal(keyboard.document.activeElement, keyboard.grid);

  const originalFocus = { id: 'search-control' };
  const request = { id: 'request-1' };
  const mouseContext = {
    requests: [request],
    filteredRequests: [request],
    selectedRequestId: null,
    vsForceRender: false,
    document: {
      activeElement: originalFocus,
      getElementById: () => null
    },
    window: { location: { hash: '#/view' } },
    history: { replaceState() {} },
    buildTrafficViewHash: id => `#/view/${id}`,
    scrollRowIntoView() {},
    renderVirtualRows() {},
    showDetail() {},
    closeDetail() {}
  };
  vm.createContext(mouseContext);
  vm.runInContext(`${rowSelectionSource}; selectRequest('request-1');`, mouseContext);
  assert.equal(mouseContext.selectedRequestId, 'request-1');
  assert.equal(mouseContext.document.activeElement, originalFocus);
});
