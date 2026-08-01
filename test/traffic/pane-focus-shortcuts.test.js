import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const appSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'index.html'), 'utf8');
const shortcutStart = appSource.indexOf('function isEditableKeyboardTarget(');
const shortcutEnd = appSource.indexOf('// ============ MONACO EDITOR', shortcutStart);
assert.ok(shortcutStart >= 0 && shortcutEnd > shortcutStart);
const shortcutSource = appSource.slice(shortcutStart, shortcutEnd);

function paneTag(id) {
  return html.match(new RegExp(`<div[^>]*id="${id}"[^>]*>`))?.[0];
}

function createHarness() {
  let keydownHandler;
  const trafficPanel = { classList: { contains: name => name === 'active' } };
  const document = {
    activeElement: { tagName: 'DIV', isContentEditable: false, closest: () => null },
    addEventListener(type, handler) {
      if (type === 'keydown') keydownHandler = handler;
    },
    getElementById(id) {
      if (id === 'panel-traffic') return trafficPanel;
      if (id === 'trafficTableWrapper') return trafficList;
      if (id === 'trafficGrid') return trafficGrid;
      if (id === 'detailPanel') return detailPane;
      return null;
    },
    querySelector() {
      throw new Error('pane focus shortcuts must use their rendered IDs');
    }
  };
  const trafficList = { focus: () => { document.activeElement = trafficList; } };
  const trafficGrid = { focus: () => { document.activeElement = trafficGrid; } };
  const detailPane = { focus: () => { document.activeElement = detailPane; } };

  vm.runInNewContext(shortcutSource, { document });
  assert.equal(typeof keydownHandler, 'function');

  return {
    document,
    trafficList,
    trafficGrid,
    detailPane,
    press(key, modifier = 'ctrlKey') {
      let prevented = 0;
      keydownHandler({
        key,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault: () => { prevented++; },
        [modifier]: true
      });
      return prevented;
    }
  };
}

test('traffic list and detail panes are labeled programmatic focus targets', () => {
  for (const [id, label] of [
    ['trafficTableWrapper', 'Traffic list pane'],
    ['detailPanel', 'Request detail pane']
  ]) {
    const tag = paneTag(id);
    assert.ok(tag, `${id} must be rendered`);
    assert.match(tag, /role="region"/);
    assert.match(tag, new RegExp(`aria-label="${label}"`));
    assert.match(tag, /tabindex="-1"/);
  }
});

test('Ctrl+[ focuses the rendered Traffic grid owner', () => {
  const harness = createHarness();

  assert.equal(harness.press('['), 1);
  assert.equal(harness.document.activeElement, harness.trafficGrid);
});

test('Command+] focuses the rendered request detail pane', () => {
  const harness = createHarness();

  assert.equal(harness.press(']', 'metaKey'), 1);
  assert.equal(harness.document.activeElement, harness.detailPane);
});
