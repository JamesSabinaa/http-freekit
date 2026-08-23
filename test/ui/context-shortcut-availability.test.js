import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const appSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const shortcutStart = appSource.indexOf('// Keyboard shortcuts');
const shortcutEnd = appSource.indexOf('// ============ MONACO EDITOR', shortcutStart);
assert.ok(shortcutStart >= 0 && shortcutEnd > shortcutStart);
const shortcutSource = appSource.slice(shortcutStart, shortcutEnd);

function createHarness({ sendActive = false, trafficActive = false, tabCount = 1 } = {}) {
  let keydownHandler;
  const calls = [];
  const focusCalls = [];
  const elements = {
    'panel-send': { classList: { contains: name => name === 'active' && sendActive } },
    'panel-traffic': { classList: { contains: name => name === 'active' && trafficActive } },
    trafficGrid: { focus: () => focusCalls.push('traffic') },
    trafficTableWrapper: { focus: () => focusCalls.push('traffic-wrapper') },
    detailPanel: { focus: () => focusCalls.push('detail') }
  };
  const activeElement = { tagName: 'DIV', isContentEditable: false, closest: () => null };
  const document = {
    activeElement,
    addEventListener(type, handler) {
      if (type === 'keydown') keydownHandler = handler;
    },
    getElementById: id => elements[id] || null,
    querySelector: () => null
  };
  const context = {
    document,
    handleSendEscapeShortcut: () => false,
    handleTrafficSearchShortcut: () => false,
    isClearTrafficShortcut: () => false,
    isEditableKeyboardTarget: () => false,
    isTrafficNavigationKeyboardTarget: () => false,
    closeDetail: () => calls.push('close-detail'),
    clearTraffic: () => calls.push('clear'),
    deleteSelectedRequest: () => calls.push('delete'),
    addSendTab: () => calls.push('add-tab'),
    closeSendTab: (...args) => calls.push(['close-tab', ...args]),
    switchSendTab: id => calls.push(['switch-tab', id]),
    togglePinRequest: () => calls.push('pin'),
    resendSelectedRequest: () => calls.push('resend'),
    createMockFromRequest: () => calls.push('mock'),
    selectRequestByIndex: () => calls.push('navigate'),
    switchPanel: () => calls.push('switch-panel')
  };
  vm.createContext(context);
  vm.runInContext(`
    let selectedRequestId = null;
    let activeSendTab = 'tab-1';
    let sendTabs = Array.from({ length: ${tabCount} }, (_, index) => ({ id: 'tab-' + (index + 1) }));
    ${shortcutSource}
    globalThis.selectRequest = id => { selectedRequestId = id; };
  `, context);

  return {
    calls,
    focusCalls,
    selectRequest: context.selectRequest,
    press(key, overrides = {}) {
      const event = {
        key,
        target: activeElement,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...overrides
      };
      keydownHandler(event);
      return event;
    }
  };
}

test('Send shortcuts are consumed only when their product action is available', () => {
  const inactive = createHarness({ sendActive: false });
  assert.equal(inactive.press('w').defaultPrevented, false);
  assert.deepEqual(inactive.calls, []);

  const soleTab = createHarness({ sendActive: true, tabCount: 1 });
  assert.equal(soleTab.press('Tab').defaultPrevented, false);
  assert.equal(soleTab.press('w').defaultPrevented, true);
  assert.deepEqual(soleTab.calls, [['close-tab', 'tab-1', true]]);

  const multipleTabs = createHarness({ sendActive: true, tabCount: 2 });
  assert.equal(multipleTabs.press('Tab').defaultPrevented, true);
  assert.deepEqual(multipleTabs.calls, [['switch-tab', 'tab-2']]);
});

test('exchange shortcuts leave host actions available without a selection', () => {
  const harness = createHarness();
  for (const [key, action] of [['p', 'pin'], ['r', 'resend'], ['m', 'mock']]) {
    assert.equal(harness.press(key).defaultPrevented, false, key);
    harness.selectRequest('selected');
    assert.equal(harness.press(key).defaultPrevented, true, key);
    assert.equal(harness.calls.at(-1), action, key);
    harness.selectRequest(null);
  }
});

test('pane-focus shortcuts require the active Traffic context and a real target', () => {
  const inactive = createHarness({ trafficActive: false });
  assert.equal(inactive.press('[').defaultPrevented, false);
  assert.equal(inactive.press(']').defaultPrevented, false);
  assert.deepEqual(inactive.focusCalls, []);

  const active = createHarness({ trafficActive: true });
  assert.equal(active.press('[').defaultPrevented, true);
  assert.equal(active.press(']').defaultPrevented, true);
  assert.deepEqual(active.focusCalls, ['traffic', 'detail']);
});
