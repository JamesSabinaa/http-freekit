import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const appSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function extractFunction(name, nextMarker) {
  const start = appSource.indexOf(`function ${name}(`);
  const end = appSource.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, `${name} must be present`);
  return appSource.slice(start, end);
}

function createHarness(clipboardWrite = () => Promise.resolve()) {
  const writes = [];
  const toasts = [];
  const pendingWrites = [];
  const context = {
    navigator: {
      clipboard: {
        writeText(text) {
          writes.push(text);
          const pending = Promise.resolve().then(() => clipboardWrite(text));
          pendingWrites.push(pending);
          return pending;
        }
      }
    },
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(`
    ${extractFunction('activateOnKeyboard', 'const API_BASE')}
    ${extractFunction('switchConfigTab', 'function copyConfigCode')}
    ${extractFunction('copyConfigCode', 'function renderAndroidConfig')}
    globalThis.activateCopyControl = activateOnKeyboard;
    globalThis.switchTerminalTab = switchConfigTab;
    globalThis.copyConfig = copyConfigCode;
  `, context);

  return {
    activate: context.activateCopyControl,
    copy: context.copyConfig,
    switchTab: context.switchTerminalTab,
    writes,
    toasts,
    async settle() {
      await Promise.allSettled(pendingWrites.splice(0));
      await Promise.resolve();
    }
  };
}

class FakeElement {
  constructor(textContent = '') {
    this.textContent = textContent;
    this.parentElement = null;
    this.onclick = null;
    this.onkeydown = null;
  }

  appendChild(child) {
    child.parentElement = this;
    return child;
  }

  dispatchEvent(event) {
    event.target ||= this;
    event.currentTarget = this;
    if (event.type === 'keydown') this.onkeydown?.(event);
    if (event.type === 'click') this.onclick?.(event);
    if (!event.cancelBubble && this.parentElement) this.parentElement.dispatchEvent(event);
    return !event.defaultPrevented;
  }

  click() {
    this.dispatchEvent(createEvent('click'));
  }
}

function createEvent(type, overrides = {}) {
  return {
    type,
    key: '',
    repeat: false,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefaultCalls: 0,
    preventDefault() {
      this.defaultPrevented = true;
      this.preventDefaultCalls += 1;
    },
    stopPropagation() { this.cancelBubble = true; },
    ...overrides
  };
}

function createCopyControl(harness, textContent = '  proxy command  ') {
  const card = new FakeElement();
  let cardActivations = 0;
  card.onclick = () => { cardActivations += 1; };
  card.onkeydown = event => {
    if (event.target !== event.currentTarget || event.key !== 'Enter') return;
    event.preventDefault();
    card.click();
  };

  const control = card.appendChild(new FakeElement(textContent));
  control.onkeydown = harness.activate;
  control.onclick = event => {
    event.stopPropagation();
    harness.copy(control);
  };

  return { card, control, cardActivations: () => cardActivations };
}

test('all interceptor copy blocks expose scoped button semantics', () => {
  const copyBlocks = [
    ...appSource.matchAll(/<div class="config-code-block(?: android-qr-url)?"[^>]*>/g)
  ].map(match => match[0]);

  assert.equal(copyBlocks.length, 5);
  for (const block of copyBlocks) {
    assert.match(block, /role="button"/);
    assert.match(block, /tabindex="0"/);
    assert.match(block, /title="Copy to clipboard"/);
    assert.match(block, /onkeydown="activateOnKeyboard\(event\)"/);
    assert.match(block, /onclick="event\.stopPropagation\(\); copyConfigCode\(this\)"/);
  }

  const expectedLabels = new Map([
    ['Copy Docker Run command', 1],
    ['Copy Docker Compose configuration', 1],
    ['Copy terminal command', 1],
    ['Copy Android QR connection URL', 1],
    ['Copy JVM launch option', 1]
  ]);
  for (const [label, count] of expectedLabels) {
    assert.equal(copyBlocks.filter(block => block.includes(`aria-label="${label}"`)).length, count);
  }
});

test('Enter, Space, and pointer activation copy once without activating the parent card', async () => {
  const harness = createHarness();
  const { control, cardActivations } = createCopyControl(harness);

  for (const key of ['Enter', ' ']) {
    const event = createEvent('keydown', { key });
    const writesBefore = harness.writes.length;
    control.dispatchEvent(event);
    await harness.settle();
    assert.equal(harness.writes.length, writesBefore + 1, `${JSON.stringify(key)} copy count`);
    assert.equal(event.preventDefaultCalls, 1, `${JSON.stringify(key)} must prevent default once`);
  }

  const writesBeforePointer = harness.writes.length;
  control.click();
  await harness.settle();
  assert.equal(harness.writes.length, writesBeforePointer + 1);
  assert.deepEqual(harness.writes, ['proxy command', 'proxy command', 'proxy command']);
  assert.equal(cardActivations(), 0);
  assert.deepEqual(harness.toasts, [
    { message: 'Copied to clipboard!', type: 'success' },
    { message: 'Copied to clipboard!', type: 'success' },
    { message: 'Copied to clipboard!', type: 'success' }
  ]);

  const repeatEvent = createEvent('keydown', { key: 'Enter', repeat: true });
  control.dispatchEvent(repeatEvent);
  await harness.settle();
  assert.equal(harness.writes.length, 3);
  assert.equal(repeatEvent.preventDefaultCalls, 1);
  assert.equal(cardActivations(), 0);
});

test('clipboard errors show failure feedback and remain scoped to the copy control', async () => {
  const harness = createHarness(() => Promise.reject(new Error('permission denied')));
  const { control, cardActivations } = createCopyControl(harness);

  control.click();
  await harness.settle();

  assert.deepEqual(harness.writes, ['proxy command']);
  assert.deepEqual(harness.toasts, [{ message: 'Failed to copy', type: 'error' }]);
  assert.equal(cardActivations(), 0);
});

test('terminal tab changes update the text copied by the existing control', async () => {
  const harness = createHarness();
  const { control, cardActivations } = createCopyControl(harness, 'bash command');
  const createClassList = (...initial) => {
    const values = new Set(initial);
    return {
      add: value => values.add(value),
      remove: value => values.delete(value),
      contains: value => values.has(value)
    };
  };
  const bashTab = { classList: createClassList('active') };
  const powershellTab = {
    classList: createClassList(),
    parentElement: { querySelectorAll: () => [bashTab, powershellTab] }
  };
  const configContainer = {
    _instructions: { bash: 'bash command', powershell: 'PowerShell command' },
    querySelector: selector => selector === '#terminalConfigCode' ? control : null
  };
  powershellTab.closest = selector => selector === '.intercept-card-config' ? configContainer : null;

  harness.switchTab(powershellTab, 'powershell');
  control.click();
  await harness.settle();

  assert.equal(control.textContent, 'PowerShell command');
  assert.equal(bashTab.classList.contains('active'), false);
  assert.equal(powershellTab.classList.contains('active'), true);
  assert.deepEqual(harness.writes, ['PowerShell command']);
  assert.equal(cardActivations(), 0);
});
