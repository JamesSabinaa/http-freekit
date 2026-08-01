import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const shortcutStart = source.indexOf('function isEditableKeyboardTarget(');
const shortcutEnd = source.indexOf('// ============ MONACO EDITOR', shortcutStart);
assert.ok(shortcutStart >= 0 && shortcutEnd > shortcutStart);
const shortcutSource = source.slice(shortcutStart, shortcutEnd);

const navigationKeys = new Map([
  ['ArrowDown', 1],
  ['j', 1],
  ['ArrowUp', -1],
  ['k', -1],
  ['PageDown', 10],
  ['PageUp', -10],
  ['Home', 'first'],
  ['End', 'last']
]);

function element(tagName = 'DIV', options = {}) {
  return {
    tagName,
    isContentEditable: options.isContentEditable === true,
    hasAttribute(name) {
      return name === 'href' && options.href === true;
    },
    closest(selector) {
      return (options.closestMatches || []).some(match => selector.includes(match)) ? {} : null;
    }
  };
}

function createHarness(activePanel = 'traffic', activeElement = element()) {
  let keydownHandler;
  const navigation = [];
  const switches = [];
  const trafficPanel = {
    classList: { contains: name => name === 'active' && activePanel === 'traffic' }
  };
  const document = {
    activeElement,
    addEventListener(type, handler) {
      if (type === 'keydown') keydownHandler = handler;
    },
    getElementById(id) {
      if (id === 'panel-traffic') return trafficPanel;
      return null;
    },
    querySelector(selector) {
      if (selector.startsWith('.sidebar-item[data-panel=')) return { dataset: {} };
      return null;
    }
  };

  vm.runInNewContext(shortcutSource, {
    document,
    selectRequestByIndex(direction) {
      navigation.push(direction);
    },
    switchPanel(_element, panelId) {
      switches.push(panelId);
      activePanel = panelId;
    }
  });
  assert.equal(typeof keydownHandler, 'function');

  return {
    navigation,
    switches,
    dispatch(key, target = activeElement, overrides = {}) {
      let prevented = 0;
      keydownHandler({
        key,
        target,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault() { prevented += 1; },
        ...overrides
      });
      return prevented;
    }
  };
}

test('all Traffic row navigation keys retain their selection behavior on the active panel surface', () => {
  const harness = createHarness('traffic');

  for (const [key, direction] of navigationKeys) {
    assert.equal(harness.dispatch(key), 1, key);
    assert.equal(harness.navigation.at(-1), direction, key);
  }

  assert.deepEqual(harness.navigation, [...navigationKeys.values()]);
});

test('Traffic navigation keys preserve default behavior throughout every other panel', () => {
  for (const panel of ['intercept', 'mock', 'send', 'settings']) {
    const harness = createHarness(panel);
    for (const key of navigationKeys.keys()) {
      assert.equal(harness.dispatch(key), 0, `${panel}: ${key}`);
    }
    assert.deepEqual(harness.navigation, [], panel);
    assert.deepEqual(harness.switches, [], panel);
  }
});

test('editable and Monaco targets retain their own navigation keys in Traffic', () => {
  const targets = [
    element('INPUT'),
    element('TEXTAREA'),
    element('SELECT'),
    element('DIV', { isContentEditable: true }),
    element('SPAN', { closestMatches: ['[contenteditable]'] }),
    element('DIV', { closestMatches: ['.monaco-editor'] })
  ];

  for (const target of targets) {
    const harness = createHarness('traffic', target);
    for (const key of navigationKeys.keys()) {
      assert.equal(harness.dispatch(key, target), 0, `${target.tagName}: ${key}`);
    }
    assert.deepEqual(harness.navigation, [], target.tagName);
  }
});

test('native and semantic controls are not shadowed by Traffic navigation', () => {
  const controls = [
    element('BUTTON'),
    element('A', { href: true }),
    element('SUMMARY'),
    element('SPAN', { closestMatches: ['button'] }),
    element('SPAN', { closestMatches: ['audio[controls]'] }),
    element('DIV', { closestMatches: ['[role="menuitem"]'] }),
    element('DIV', { closestMatches: ['[role="separator"]'] }),
    element('DIV', { closestMatches: ['[role="tab"]'] }),
    element('SPAN', { closestMatches: ['[tabindex]'] })
  ];

  for (const target of controls) {
    // Keep activeElement deliberately different to verify the event target is authoritative.
    const harness = createHarness('traffic', element('DIV'));
    for (const key of navigationKeys.keys()) {
      assert.equal(harness.dispatch(key, target), 0, `${target.tagName}: ${key}`);
    }
    assert.deepEqual(harness.navigation, [], target.tagName);
  }
});
