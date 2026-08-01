import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const helperStart = source.indexOf('function isEditableKeyboardTarget(');
const handlerEnd = source.indexOf('// ============ MONACO EDITOR', helperStart);
assert.ok(helperStart >= 0 && handlerEnd > helperStart);
const shortcutSource = source.slice(helperStart, handlerEnd);

function element(tagName) {
  return {
    tagName,
    isContentEditable: false,
    closest: () => null
  };
}

function createHarness(activePanel, activeElement = element('DIV')) {
  let trafficActive = activePanel === 'traffic';
  let keydownHandler;
  const actions = [];
  const navigation = [];
  const trafficPanel = {
    classList: { contains: name => name === 'active' && trafficActive }
  };
  const trafficNav = { dataset: { panel: 'traffic' } };
  const searchInput = element('INPUT');
  const document = {
    activeElement,
    addEventListener(type, handler) {
      if (type === 'keydown') keydownHandler = handler;
    },
    getElementById(id) {
      if (id === 'panel-traffic') return trafficPanel;
      if (id === 'searchInput') return searchInput;
      return null;
    },
    querySelector(selector) {
      if (selector === '.sidebar-item[data-panel="traffic"]') return trafficNav;
      return null;
    }
  };
  searchInput.focus = () => {
    actions.push(['focus', trafficActive]);
    document.activeElement = searchInput;
  };

  const context = {
    document,
    switchPanel(nav, panelId) {
      assert.equal(nav, trafficNav);
      assert.equal(panelId, 'traffic');
      actions.push(['switch', activePanel]);
      trafficActive = true;
    },
    selectRequestByIndex(direction) {
      navigation.push(direction);
    }
  };
  vm.runInNewContext(shortcutSource, context);
  assert.equal(typeof keydownHandler, 'function');

  return {
    actions,
    navigation,
    dispatch(overrides) {
      let prevented = 0;
      const event = {
        key: '',
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault: () => { prevented++; },
        ...overrides
      };
      keydownHandler(event);
      return prevented;
    }
  };
}

test('Ctrl+F from Send switches to visible Traffic search before focusing', () => {
  const harness = createHarness('send', element('INPUT'));

  assert.equal(harness.dispatch({ key: 'f', ctrlKey: true }), 1);
  assert.deepEqual(harness.actions, [['switch', 'send'], ['focus', true]]);
});

test('Ctrl+K from a Settings field switches and focuses the visible Traffic search', () => {
  const harness = createHarness('settings', element('INPUT'));

  assert.equal(harness.dispatch({ key: 'k', ctrlKey: true }), 1);
  assert.deepEqual(harness.actions, [['switch', 'settings'], ['focus', true]]);
  assert.deepEqual(harness.navigation, []);
});

test('Ctrl+K returns before stale editability can trigger vim row navigation', () => {
  const harness = createHarness('traffic', element('DIV'));

  assert.equal(harness.dispatch({ key: 'k', ctrlKey: true }), 1);
  assert.deepEqual(harness.actions, [['focus', true]]);
  assert.deepEqual(harness.navigation, []);
});

test('slash from another panel uses the same switch-and-focus path', () => {
  const harness = createHarness('send', element('DIV'));

  assert.equal(harness.dispatch({ key: '/' }), 1);
  assert.deepEqual(harness.actions, [['switch', 'send'], ['focus', true]]);
});

test('Traffic search focus does not redundantly switch an already active panel', () => {
  const harness = createHarness('traffic', element('DIV'));

  assert.equal(harness.dispatch({ key: '/' }), 1);
  assert.deepEqual(harness.actions, [['focus', true]]);
});

test('slash remains available inside editable controls', () => {
  const harness = createHarness('settings', element('TEXTAREA'));

  assert.equal(harness.dispatch({ key: '/' }), 0);
  assert.deepEqual(harness.actions, []);
  assert.deepEqual(harness.navigation, []);
});
