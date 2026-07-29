import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repoRoot = process.cwd();
const appSource = fs.readFileSync(path.join(repoRoot, 'src', 'ui', 'app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(repoRoot, 'src', 'ui', 'index.html'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} source must be present`);
  return appSource.slice(start, end);
}

const toastSource = sourceBetween('function toast(message', 'function setupSplitPaneResizer(');
const installActionStateSource = sourceBetween(
  'let installUpdateRequestPending = false;',
  'function handleUpdaterStatus('
);
const updaterStatusSource = sourceBetween(
  'function handleUpdaterStatus(',
  'window.electronApi.onUpdaterStatus(handleUpdaterStatus);'
);
const readyToastSource = sourceBetween('function showUpdateReadyToast(', 'function showLinuxUpdateToast(');
const linuxToastSource = sourceBetween('function showLinuxUpdateToast(', 'function escapeHtml(');
const escapeHtmlSource = sourceBetween('function escapeHtml(', '// Expose manual check for Settings page');

function decodeHtml(value) {
  return String(value)
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function encodeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function attributesFromTag(tag) {
  return new Map(Array.from(tag.matchAll(/([\w-]+)="([^"]*)"/g), match => [match[1], match[2]]));
}

const toastContainerTag = indexSource.match(/<div\b[^>]*\bid="toastContainer"[^>]*>/)?.[0];
assert.ok(toastContainerTag, 'toast container markup must be present');
const toastContainerAttributes = attributesFromTag(toastContainerTag);

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.className = '';
    this.listeners = new Map();
    this._innerHTML = '';
    this._textContent = '';
  }

  get classList() {
    return {
      add: name => {
        if (!this.className.split(/\s+/).includes(name)) {
          this.className = `${this.className} ${name}`.trim();
        }
      },
      contains: name => this.className.split(/\s+/).includes(name)
    };
  }

  set id(value) { this.setAttribute('id', value); }
  get id() { return this.getAttribute('id') || ''; }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = String(value);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  set textContent(value) {
    this.children = [];
    this._textContent = String(value);
    this._innerHTML = encodeHtml(value);
  }

  get textContent() {
    if (this.children.length === 0) return this._textContent;
    return this._textContent + this.children.map(child => child.textContent).join('');
  }

  set innerHTML(value) {
    this.children = [];
    this._innerHTML = String(value);
    const anchorMatch = String(value).match(/<a\s+([^>]*)>([\s\S]*?)<\/a>/i);
    const nonChildMarkup = anchorMatch
      ? String(value).replace(anchorMatch[0], '')
      : String(value);
    this._textContent = decodeHtml(nonChildMarkup.replace(/<[^>]*>/g, ''));
    if (!anchorMatch) return;
    const action = new FakeElement('a', this.ownerDocument);
    for (const [name, attributeValue] of attributesFromTag(`<a ${anchorMatch[1]}>`)) {
      action.setAttribute(name, decodeHtml(attributeValue));
    }
    action.textContent = decodeHtml(anchorMatch[2]);
    this.appendChild(action);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    const relevant = this.getAttribute('aria-relevant') || '';
    if (this.getAttribute('aria-live') && relevant.split(/\s+/).includes('additions')) {
      this.ownerDocument.announcements.push(child.textContent);
    }
    return child;
  }

  querySelector(selector) {
    const matches = element => selector.startsWith('#')
      ? element.id === selector.slice(1)
      : selector.startsWith('.') && element.className.split(/\s+/).includes(selector.slice(1));
    for (const child of this.children) {
      if (matches(child)) return child;
      const descendant = child.querySelector(selector);
      if (descendant) return descendant;
    }
    return null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    const event = {
      type,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }
    };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
}

class FakeDocument {
  constructor() {
    this.announcements = [];
    this.body = new FakeElement('body', this);
    this.activeElement = this.body;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    const find = element => {
      if (element.id === id) return element;
      for (const child of element.children) {
        const match = find(child);
        if (match) return match;
      }
      return null;
    };
    return find(this.body);
  }
}

function createHarness() {
  const document = new FakeDocument();
  const container = document.createElement('div');
  for (const [name, value] of toastContainerAttributes) container.setAttribute(name, value);
  container.className = container.getAttribute('class');
  document.body.appendChild(container);
  const timers = [];
  const installCalls = [];
  const context = {
    document,
    window: {
      electronApi: {
        installUpdate: () => {
          installCalls.push('install');
          return Promise.resolve({ started: true, inProgress: true });
        }
      }
    },
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${toastSource}
    let updateVersion = null;
    let lastUpdaterStatusKey = null;
    ${installActionStateSource}
    ${updaterStatusSource}
    ${readyToastSource}
    ${linuxToastSource}
    ${escapeHtmlSource}
    globalThis.toastForTest = toast;
    globalThis.readyToastForTest = showUpdateReadyToast;
    globalThis.linuxToastForTest = showLinuxUpdateToast;
    globalThis.updaterStatusForTest = handleUpdaterStatus;
  `, context);
  return { container, context, document, installCalls, timers };
}

test('persistent toast container is one non-atomic polite status region', () => {
  assert.equal(toastContainerAttributes.get('role'), 'status');
  assert.equal(toastContainerAttributes.get('aria-live'), 'polite');
  assert.equal(toastContainerAttributes.get('aria-atomic'), 'false');
  assert.equal(toastContainerAttributes.get('aria-relevant'), 'additions text');
  assert.equal(toastContainerAttributes.has('tabindex'), false);
  assert.doesNotMatch(`${toastSource}\n${readyToastSource}\n${linuxToastSource}`, /aria-live|role=["'](?:status|alert)/);
});

test('ordinary success and error toasts announce each addition without moving focus', () => {
  const harness = createHarness();
  const focusedEditor = { id: 'editor' };
  harness.document.activeElement = focusedEditor;

  harness.context.toastForTest('Settings saved', 'success');
  harness.context.toastForTest('Save failed', 'error');

  assert.equal(harness.document.activeElement, focusedEditor);
  assert.deepEqual(harness.document.announcements, ['Settings saved', 'Save failed']);
  assert.deepEqual(harness.container.children.map(child => child.className), [
    'toast toast-success',
    'toast toast-error'
  ]);
  assert.equal(harness.container.children.every(child => child.getAttribute('role') === null), true);
  assert.deepEqual(harness.timers.map(timer => timer.delay), [2700, 2700]);

  const firstToast = harness.container.children[0];
  harness.timers[0].callback();
  assert.equal(firstToast.classList.contains('toast-exit'), true);
  firstToast.dispatch('animationend');
  assert.deepEqual(harness.document.announcements, ['Settings saved', 'Save failed']);
  assert.equal(harness.document.activeElement, focusedEditor);
});

test('updater action toasts announce their full text and retain the current focus', () => {
  const harness = createHarness();
  const focusedButton = { id: 'check-for-updates' };
  harness.document.activeElement = focusedButton;

  harness.context.readyToastForTest('<2.0>');
  const readyToast = harness.container.children[0];
  const installAction = readyToast.querySelector('#installUpdateBtn');
  assert.equal(readyToast.textContent, 'Update v<2.0> ready. Restart to install');
  assert.equal(installAction.textContent, 'Restart to install');
  assert.equal(installAction.getAttribute('role'), null);
  assert.equal(harness.document.activeElement, focusedButton);
  const click = installAction.dispatch('click');
  assert.equal(click.defaultPrevented, true);
  assert.deepEqual(harness.installCalls, ['install']);

  harness.context.readyToastForTest('2.0');
  assert.equal(harness.container.children.length, 1, 'persistent ready action is not duplicated');

  harness.context.linuxToastForTest('3.0', 'https://updates.test/?a=1&b=2');
  const linuxToast = harness.container.children[1];
  const downloadAction = linuxToast.querySelector('.toast-action');
  assert.equal(linuxToast.textContent, 'Update v3.0 available. Download');
  assert.equal(downloadAction.textContent, 'Download');
  assert.equal(downloadAction.getAttribute('href'), 'https://updates.test/?a=1&b=2');
  assert.equal(harness.document.activeElement, focusedButton);
  assert.deepEqual(harness.document.announcements, [
    'Update v<2.0> ready. Restart to install',
    'Update v3.0 available. Download'
  ]);
  assert.deepEqual(harness.timers.map(timer => timer.delay), [15000]);
});

test('repeated same-version update cancellations restore the restart action', async () => {
  const harness = createHarness();
  harness.context.readyToastForTest('2.0');
  const installAction = harness.document.getElementById('installUpdateBtn');
  const firstCanceledStatus = {
    status: 'install-canceled', eventId: 1, version: '2.0', manual: true
  };
  const secondCanceledStatus = {
    status: 'install-canceled', eventId: 2, version: '2.0', manual: true
  };

  installAction.dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(installAction.textContent, 'Restarting…');
  harness.context.updaterStatusForTest(firstCanceledStatus);
  harness.context.updaterStatusForTest(firstCanceledStatus);
  assert.equal(installAction.textContent, 'Restart to install');
  assert.equal(installAction.getAttribute('aria-disabled'), 'false');
  assert.equal(harness.container.children.length, 2, 'live cancellation and its replay announce once');

  installAction.dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(installAction.textContent, 'Restarting…');
  harness.context.updaterStatusForTest(secondCanceledStatus);
  harness.context.updaterStatusForTest(secondCanceledStatus);
  assert.equal(installAction.textContent, 'Restart to install');
  assert.equal(installAction.getAttribute('aria-disabled'), 'false');
  assert.equal(harness.container.children.length, 3, 'the new cancellation announces once');
  assert.deepEqual(harness.installCalls, ['install', 'install']);
});

test('repeated installer errors recover each retry without duplicating status replay', async () => {
  const harness = createHarness();
  harness.context.readyToastForTest('2.0');
  const installAction = harness.document.getElementById('installUpdateBtn');

  for (const eventId of [1, 2]) {
    installAction.dispatch('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(installAction.textContent, 'Restarting…');
    const errorStatus = {
      status: 'error', eventId, error: 'installer launch failed', manual: true
    };
    harness.context.updaterStatusForTest(errorStatus);
    harness.context.updaterStatusForTest(errorStatus);
    assert.equal(installAction.textContent, 'Restart to install');
    assert.equal(installAction.getAttribute('aria-disabled'), 'false');
  }

  assert.deepEqual(harness.installCalls, ['install', 'install']);
  assert.equal(harness.container.children.length, 3, 'each distinct failure announces exactly once');
});
