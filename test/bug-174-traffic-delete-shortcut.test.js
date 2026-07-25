import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const helperStart = source.indexOf('function isEditableKeyboardTarget');
const handlerStart = source.indexOf("document.addEventListener('keydown'", helperStart);
assert.notEqual(helperStart, -1);
assert.notEqual(handlerStart, -1);

const context = {};
vm.runInNewContext(`
  ${source.slice(helperStart, handlerStart)}
  globalThis.shortcuts = { isEditableKeyboardTarget, isClearTrafficShortcut };
`, context);

function element(tagName, options = {}) {
  return {
    tagName,
    isContentEditable: options.isContentEditable || false,
    closest(selector) {
      if (options.inMonaco && selector.includes('.monaco-editor')) return {};
      if (options.inContentEditable && selector.includes('[contenteditable]')) return {};
      return null;
    }
  };
}

function deleteEvent(overrides = {}) {
  return {
    key: 'Delete',
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides
  };
}

test('clear-traffic shortcut is limited to the active Traffic panel', () => {
  const target = element('DIV');

  assert.equal(context.shortcuts.isClearTrafficShortcut(deleteEvent(), target, true), true);
  assert.equal(context.shortcuts.isClearTrafficShortcut(deleteEvent({ ctrlKey: false, metaKey: true }), target, true), true);
  assert.equal(context.shortcuts.isClearTrafficShortcut(deleteEvent({ shiftKey: true }), target, true), true);
  assert.equal(context.shortcuts.isClearTrafficShortcut(deleteEvent(), target, false), false);
  assert.equal(context.shortcuts.isClearTrafficShortcut(deleteEvent({ altKey: true }), target, true), false);
  assert.equal(context.shortcuts.isClearTrafficShortcut(deleteEvent({ key: 'Backspace' }), target, true), false);
});

test('clear-traffic shortcut preserves editing shortcuts in every editor type', () => {
  const editableTargets = [
    element('INPUT'),
    element('TEXTAREA'),
    element('SELECT'),
    element('DIV', { isContentEditable: true }),
    element('SPAN', { inContentEditable: true }),
    element('TEXTAREA', { inMonaco: true }),
    element('DIV', { inMonaco: true })
  ];

  for (const target of editableTargets) {
    assert.equal(context.shortcuts.isEditableKeyboardTarget(target), true);
    assert.equal(context.shortcuts.isClearTrafficShortcut(deleteEvent(), target, true), false);
  }
});

test('plain selected-exchange Delete remains separate from clear traffic', () => {
  const keyboardSection = source.slice(handlerStart, source.indexOf('// ============ MONACO EDITOR', handlerStart));
  assert.match(keyboardSection, /isClearTrafficShortcut\(e, activeEl, trafficPanelActive\)/);
  assert.match(keyboardSection, /e\.key === 'Delete'.*!isInput && selectedRequestId/);
  assert.match(keyboardSection, /deleteSelectedRequest\(\)/);
});
