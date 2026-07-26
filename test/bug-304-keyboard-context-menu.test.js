import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must be present`);
  return source.slice(start, end);
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.listeners = new Map();
    this.isConnected = false;
    this.isContentEditable = false;
    this.rect = { left: 0, top: 0, right: 180, bottom: 40, width: 180, height: 40 };
  }

  get classList() {
    return { contains: name => this.className.split(/\s+/).includes(name) };
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.ownerDocument.elementsById.set(String(value), this);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child) {
    child.parentElement = this;
    child.setConnected(this.isConnected);
    this.children.push(child);
    return child;
  }

  setConnected(value) {
    this.isConnected = value;
    this.children.forEach(child => child.setConnected(value));
  }

  remove() {
    if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    }
    this.parentElement = null;
    this.setConnected(false);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    event.target ||= this;
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    if (!event.cancelBubble && this.parentElement) this.parentElement.dispatchEvent(event);
    else if (!event.cancelBubble && this.isConnected) this.ownerDocument.dispatch(event.type, event);
    return !event.defaultPrevented;
  }

  click() {
    this.dispatchEvent(createEvent('click', { target: this }));
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  contains(candidate) {
    return candidate === this || this.children.some(child => child.contains(candidate));
  }

  matches(selector) {
    if (selector === '[data-context-header-key][data-context-section]') {
      return this.dataset.contextHeaderKey !== undefined && this.dataset.contextSection !== undefined;
    }
    if (selector === '#trafficBody tr[data-id]') {
      return this.tagName === 'TR' && this.dataset.id !== undefined
        && this.ancestors().some(element => element.id === 'trafficBody');
    }
    if (selector.includes('.monaco-editor')) {
      return this.classList.contains('monaco-editor') || this.isContentEditable;
    }
    return false;
  }

  closest(selector) {
    let candidate = this;
    while (candidate) {
      if (candidate.matches(selector)) return candidate;
      candidate = candidate.parentElement;
    }
    return null;
  }

  ancestors() {
    const result = [];
    let candidate = this.parentElement;
    while (candidate) {
      result.push(candidate);
      candidate = candidate.parentElement;
    }
    return result;
  }

  querySelectorAll(selector) {
    const result = [];
    const visit = element => {
      for (const child of element.children) {
        if (selector === '[role="menuitem"]' && child.getAttribute('role') === 'menuitem') result.push(child);
        if (selector === 'tr[data-id]' && child.tagName === 'TR' && child.dataset.id !== undefined) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }

  getBoundingClientRect() {
    return this.rect;
  }
}

class FakeDocument {
  constructor() {
    this.elementsById = new Map();
    this.listeners = new Map();
    this.body = new FakeElement('body', this);
    this.body.setConnected(true);
    this.activeElement = this.body;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    return this.elementsById.get(id) || null;
  }

  querySelectorAll(selector) {
    if (selector === '#trafficBody tr[data-id]') {
      return this.getElementById('trafficBody')?.querySelectorAll('tr[data-id]') || [];
    }
    return this.body.querySelectorAll(selector);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, event) {
    event.type ||= type;
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
      if (event.immediatePropagationStopped) break;
    }
  }
}

function createEvent(type, overrides = {}) {
  return {
    type,
    key: '',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    clientX: 0,
    clientY: 0,
    defaultPrevented: false,
    cancelBubble: false,
    immediatePropagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.cancelBubble = true; },
    stopImmediatePropagation() {
      this.cancelBubble = true;
      this.immediatePropagationStopped = true;
    },
    ...overrides
  };
}

function append(document, parent, tagName, id) {
  const element = document.createElement(tagName);
  if (id) element.id = id;
  parent.appendChild(element);
  return element;
}

function createHarness() {
  const document = new FakeDocument();
  const clipboardWrites = [];
  const selections = [];
  const trafficPanel = append(document, document.body, 'section', 'panel-traffic');
  trafficPanel.className = 'active';
  const wrapper = append(document, trafficPanel, 'div', 'trafficTableWrapper');
  const trafficBody = append(document, wrapper, 'tbody', 'trafficBody');
  const row = append(document, trafficBody, 'tr');
  row.setAttribute('data-id', 'request-1');
  row.rect = { left: 41, top: 20, right: 141, bottom: 64, width: 100, height: 44 };

  const context = {
    Array,
    document,
    window: { innerWidth: 1000, innerHeight: 800, _detailHeaders: { request: {}, response: {} } },
    navigator: { clipboard: { writeText: value => {
      clipboardWrites.push(value);
      return { then: callback => { callback(); } };
    } } },
    generateExportSnippet: () => 'curl generated',
    toast() {},
    resendSelectedRequest() {},
    createMockFromRequest() {},
    createBreakpointFromRequest() {},
    togglePinRequest() {},
    deleteSelectedRequest() {},
    selectRequest: id => selections.push(id)
  };
  vm.createContext(context);

  const editableHelper = extract('function isEditableKeyboardTarget', 'function isClearTrafficShortcut');
  const menuBlock = extract('let activeContextMenu = null;', '// --- Traffic row context menu ---');
  const trafficMenu = extract('function showTrafficContextMenu', 'function copyResponseHeadersForMock');
  const headerMenu = extract('window._detailHeaders = { request: {}, response: {} };', '// ============ HELPERS ============');
  vm.runInContext(`
    let selectedRequestId = 'request-1';
    let requests = [{ id: 'request-1', url: 'https://example.test/path' }];
    ${editableHelper}
    ${menuBlock}
    ${trafficMenu}
    ${headerMenu}
    globalThis.menuApi = {
      show: showContextMenu,
      hide: hideContextMenu,
      active: () => activeContextMenu,
      setSelected: value => { selectedRequestId = value; },
      traffic: showTrafficContextMenu,
      header: showHeaderContextMenu
    };
  `, context);

  return { context, document, clipboardWrites, selections, trafficPanel, wrapper, trafficBody, row, api: context.menuApi };
}

function dispatchKey(document, key, target = document.activeElement, overrides = {}) {
  const event = createEvent('keydown', { key, target, ...overrides });
  document.dispatch('keydown', event);
  return event;
}

test('menu exposes roles, roving focus, wrapping navigation, and single activation', () => {
  const { api, document } = createHarness();
  let activations = 0;
  const invoker = append(document, document.body, 'button');
  invoker.focus();
  const keydownListeners = document.listeners.get('keydown').length;
  const menu = api.show(15, 25, [
    { label: 'First', action: () => { activations++; } },
    { separator: true },
    { label: 'Last', action: () => { activations++; } }
  ], { invoker, focusFirst: true });

  const items = menu.querySelectorAll('[role="menuitem"]');
  assert.equal(menu.getAttribute('role'), 'menu');
  assert.deepEqual(items.map(item => item.getAttribute('role')), ['menuitem', 'menuitem']);
  assert.equal(menu.children[1].getAttribute('role'), 'separator');
  assert.equal(menu.children[1].tabIndex, undefined);
  assert.equal(document.activeElement, items[0]);

  dispatchKey(document, 'ArrowUp');
  assert.equal(document.activeElement, items[1]);
  dispatchKey(document, 'ArrowDown');
  assert.equal(document.activeElement, items[0]);
  dispatchKey(document, 'End');
  assert.equal(document.activeElement, items[1]);
  dispatchKey(document, 'Home');
  assert.equal(document.activeElement, items[0]);

  const enter = dispatchKey(document, 'Enter');
  assert.equal(enter.defaultPrevented, true);
  assert.equal(activations, 1);
  assert.equal(api.active(), null);

  api.show(15, 25, [{ label: 'Space', action: () => { activations++; } }], { invoker, focusFirst: true });
  dispatchKey(document, ' ');
  assert.equal(activations, 2);
  assert.equal(document.listeners.get('keydown').length, keydownListeners);
});

test('Escape restores the invoker while replacement and click-away keep one active menu', () => {
  const { api, document } = createHarness();
  const invoker = append(document, document.body, 'button');
  const other = append(document, document.body, 'button');
  const first = api.show(1, 2, [{ label: 'First', action() {} }], { invoker, focusFirst: true });
  const second = api.show(3, 4, [{ label: 'Second', action() {} }], { invoker, focusFirst: true });
  assert.equal(first.isConnected, false);
  assert.equal(api.active(), second);

  const escape = dispatchKey(document, 'Escape');
  assert.equal(escape.immediatePropagationStopped, true);
  assert.equal(api.active(), null);
  assert.equal(document.activeElement, invoker);

  other.focus();
  api.show(5, 6, [{ label: 'Pointer menu', action() {} }], { invoker });
  document.dispatch('click', createEvent('click', { target: other }));
  assert.equal(api.active(), null);
  assert.equal(document.activeElement, other);
});

test('Traffic row keyboard invocation anchors to its bounds and pointer invocation keeps coordinates and actions', async () => {
  const { api, document, row, wrapper, selections, clipboardWrites } = createHarness();

  const keyboardEvent = dispatchKey(document, 'F10', row, { shiftKey: true });
  const keyboardMenu = api.active();
  assert.equal(keyboardEvent.defaultPrevented, true);
  assert.equal(keyboardMenu.style.left, '41px');
  assert.equal(keyboardMenu.style.top, '64px');
  assert.equal(document.activeElement.textContent, 'Copy URL');

  api.hide();
  const wrapperEvent = dispatchKey(document, 'ContextMenu', wrapper);
  assert.equal(wrapperEvent.defaultPrevented, true);
  assert.equal(api.active().style.left, '41px');

  api.hide();
  api.setSelected(null);
  api.traffic(createEvent('contextmenu', { target: row, currentTarget: row, clientX: 217, clientY: 319 }), 'request-1');
  const pointerMenu = api.active();
  assert.equal(pointerMenu.style.left, '217px');
  assert.equal(pointerMenu.style.top, '319px');
  assert.deepEqual(selections, ['request-1']);
  assert.equal(document.activeElement, document.body);
  pointerMenu.querySelectorAll('[role="menuitem"]')[0].click();
  await Promise.resolve();
  assert.deepEqual(clipboardWrites, ['https://example.test/path']);
});

test('header keyboard invocation targets the exact focused header and preserves right-click behavior', async () => {
  const { api, context, document, trafficPanel, clipboardWrites } = createHarness();
  const header = append(document, trafficPanel, 'span');
  header.setAttribute('data-context-header-key', 'x-test');
  header.setAttribute('data-context-section', 'request');
  header.rect = { left: 70, top: 80, right: 170, bottom: 102, width: 100, height: 22 };
  vm.runInContext(`window._detailHeaders.request = { 'x-test': 'keyboard value' }`, context);

  const keyboardEvent = dispatchKey(document, 'ContextMenu', header);
  const keyboardMenu = api.active();
  assert.equal(keyboardEvent.defaultPrevented, true);
  assert.equal(keyboardMenu.style.left, '70px');
  assert.equal(keyboardMenu.style.top, '102px');
  assert.equal(document.activeElement.textContent, 'Copy header value');
  document.activeElement.click();
  await Promise.resolve();
  assert.deepEqual(clipboardWrites, ['keyboard value']);

  api.header(createEvent('contextmenu', {
    target: header, currentTarget: header, clientX: 311, clientY: 412
  }), 'x-test', 'request');
  const pointerMenu = api.active();
  assert.equal(pointerMenu.style.left, '311px');
  assert.equal(pointerMenu.style.top, '412px');
  pointerMenu.querySelectorAll('[role="menuitem"]')[1].click();
  await Promise.resolve();
  assert.deepEqual(clipboardWrites, ['keyboard value', 'x-test']);
});

test('keyboard invocation excludes editable targets, editor surfaces, unselected rows, and inactive panels', () => {
  const { api, context, document, row, trafficPanel } = createHarness();
  for (const tagName of ['input', 'textarea', 'select']) {
    const editable = append(document, row, tagName);
    dispatchKey(document, 'ContextMenu', editable);
    assert.equal(api.active(), null);
  }

  const contentEditable = append(document, row, 'div');
  contentEditable.isContentEditable = true;
  dispatchKey(document, 'F10', contentEditable, { shiftKey: true });
  assert.equal(api.active(), null);

  const editor = append(document, row, 'div');
  editor.className = 'monaco-editor';
  const editorChild = append(document, editor, 'span');
  dispatchKey(document, 'F10', editorChild, { shiftKey: true });
  assert.equal(api.active(), null);

  api.setSelected('another-request');
  dispatchKey(document, 'ContextMenu', row);
  assert.equal(api.active(), null);

  api.setSelected('request-1');
  trafficPanel.className = '';
  dispatchKey(document, 'ContextMenu', row);
  assert.equal(api.active(), null);
  assert.ok(context);
});

test('rendered Traffic rows and header targets expose keyboard menu hooks', () => {
  const rowRenderer = extract('const _globe =', '// Render the visible virtual-scroll rows');
  const headerRenderer = extract('function renderHeadersGrid', '// Keep old renderHeaders as alias');
  const context = {
    wsFramesByParent: {},
    wsExpandedConnections: new Set(),
    formatSize: value => String(value || 0),
    esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  };
  vm.createContext(context);
  vm.runInContext(`
    let selectedRequestId = 'row-1';
    const HEADER_DOCS = {};
    ${rowRenderer}
    ${headerRenderer}
    globalThis.renderApi = { row: buildRowHtml, headers: renderHeadersGrid };
  `, context);

  const rowHtml = context.renderApi.row({
    id: 'row-1', method: 'GET', statusCode: 200, source: 'proxy', host: 'example.test', path: '/', pinned: false
  }, 2);
  assert.match(rowHtml, /aria-haspopup="menu" tabindex="0"/);
  assert.match(rowHtml, /oncontextmenu="showTrafficContextMenu\(event, 'row-1'\)"/);

  const headerHtml = context.renderApi.headers({ 'x-test': 'value' }, 'request');
  const targets = [...headerHtml.matchAll(/<span class="header-(?:name|value)"([^>]*)>/g)];
  assert.equal(targets.length, 2);
  for (const [, attributes] of targets) {
    assert.match(attributes, /role="button"/);
    assert.match(attributes, /tabindex="0"/);
    assert.match(attributes, /aria-haspopup="menu"/);
    assert.match(attributes, /data-context-header-key="x-test"/);
    assert.match(attributes, /data-context-section="request"/);
  }
});
