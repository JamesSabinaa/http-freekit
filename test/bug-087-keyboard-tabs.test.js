import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const appSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'index.html'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} source should be present`);
  return appSource.slice(start, end);
}

class FakeTab {
  constructor(tablist, selected = false) {
    this.tablist = tablist;
    this.selected = selected;
    this.clicks = 0;
    this.focuses = 0;
  }

  closest(selector) {
    return selector === '[role="tablist"]' ? this.tablist : null;
  }

  click() {
    this.clicks++;
    this.tablist.tabs.forEach(tab => { tab.selected = false; });
    this.selected = true;
  }

  focus() { this.focuses++; }
}

class FakeTablist {
  constructor() {
    this.tabs = [new FakeTab(this, true), new FakeTab(this), new FakeTab(this)];
  }

  querySelectorAll(selector) {
    return selector === '[role="tab"]' ? this.tabs : [];
  }

  querySelector(selector) {
    return selector === '[role="tab"][aria-selected="true"]'
      ? this.tabs.find(tab => tab.selected)
      : null;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this._textContent = '';
  }

  set textContent(value) {
    this._textContent = value;
    if (value === '') this.children = [];
  }

  get textContent() { return this._textContent; }

  setAttribute(name, value) { this.attributes.set(name, value); }

  getAttribute(name) { return this.attributes.get(name); }

  addEventListener() {}

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
}

function loadKeyboardHandlers() {
  const source = sourceBetween('function handleTablistKeydown(', 'function setActiveSidebarTab(');
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${source}; globalThis.sidebarKey = handleSidebarTabKeydown; globalThis.sendKey = handleSendTabKeydown;`, context);
  return context;
}

function keyEvent(tab, key, target = tab) {
  return {
    currentTarget: tab,
    target,
    key,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }
  };
}

test('sidebar tabs expose one roving tab stop and keyboard handlers', () => {
  const sidebarTags = Array.from(htmlSource.matchAll(/<div class="sidebar-item[^>]*role="tab"[^>]*>/g), match => match[0]);
  assert.equal(sidebarTags.length, 5);
  assert.equal(sidebarTags.filter(tag => /tabindex="0"/.test(tag)).length, 1);
  assert.equal(sidebarTags.filter(tag => /tabindex="-1"/.test(tag)).length, 4);
  assert.equal(sidebarTags.every(tag => /onkeydown="handleSidebarTabKeydown\(event\)"/.test(tag)), true);
});

test('sidebar and Send tab keys wrap, activate, and retain focus', () => {
  const handlers = loadKeyboardHandlers();
  const vertical = new FakeTablist();
  const up = keyEvent(vertical.tabs[0], 'ArrowUp');
  handlers.sidebarKey(up);
  assert.equal(up.defaultPrevented, true);
  assert.equal(vertical.tabs[2].clicks, 1);
  assert.equal(vertical.tabs[2].focuses, 1);

  const horizontal = new FakeTablist();
  const end = keyEvent(horizontal.tabs[0], 'End');
  handlers.sendKey(end);
  assert.equal(end.defaultPrevented, true);
  assert.equal(horizontal.tabs[2].clicks, 1);
  assert.equal(horizontal.tabs[2].focuses, 1);

  const activate = keyEvent(horizontal.tabs[2], ' ');
  handlers.sendKey(activate);
  assert.equal(activate.defaultPrevented, true);
  assert.equal(horizontal.tabs[2].clicks, 2);

  const nestedControl = {};
  const ignored = keyEvent(horizontal.tabs[2], 'ArrowLeft', nestedControl);
  handlers.sendKey(ignored);
  assert.equal(ignored.defaultPrevented, false);
});

test('generated Send tabs expose sibling tab and close controls with roving semantics', () => {
  const renderSource = sourceBetween('function renderSendTabs(', 'function renderSendResponseStatus(');
  assert.match(renderSource, /tabEl\.tabIndex = isActive \? 0 : -1/);
  assert.match(renderSource, /tabEl\.setAttribute\('aria-controls', 'sendTabPanel'\)/);
  assert.match(renderSource, /tabEl\.addEventListener\('keydown', handleSendTabKeydown\)/);
  assert.match(renderSource, /closeEl\.tabIndex = isActive \? 0 : -1/);
  assert.match(renderSource, /document\.createElement\('button'\)/);
  assert.match(renderSource, /panel\.setAttribute\('aria-labelledby', activeTabDomId\)/);
  assert.match(htmlSource, /id="sendTabPanel" role="tabpanel"/);

  const bar = new FakeElement('div');
  const panel = new FakeElement('div');
  const context = {
    activeSendTab: 'tab-1',
    addSendTab() {},
    closeSendTab() {},
    document: {
      createElement: tagName => new FakeElement(tagName),
      getElementById: id => id === 'sendTabBar' ? bar : panel
    },
    handleSendTabKeydown() {},
    sendTabs: [{ id: 'tab-1', method: 'GET', url: '' }],
    switchSendTab() {}
  };
  vm.createContext(context);
  vm.runInContext(`${renderSource}; renderSendTabs();`, context);

  const tabItem = bar.children[0];
  const [tabControl, closeControl] = tabItem.children;
  assert.equal(tabItem.className, 'send-tab-item active');
  assert.equal(tabItem.getAttribute('role'), 'presentation');
  assert.equal(tabControl.getAttribute('role'), 'tab');
  assert.equal(closeControl.tagName, 'BUTTON');
  assert.equal(closeControl.className, 'send-tab-close');
  assert.equal(closeControl.parentNode, tabItem);
  assert.equal(tabControl.children.includes(closeControl), false);
});
