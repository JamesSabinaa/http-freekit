import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
function between(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}

function themeHarness(storage = new Map(), canWrite = true) {
  const attributes = new Map();
  const select = { value: '' };
  const applied = [];
  const corrupt = [];
  const context = vm.createContext({
    document: {
      documentElement: {
        setAttribute: (name, value) => attributes.set(name, value),
        getAttribute: name => attributes.get(name)
      },
      getElementById: id => id === 'themeSelect' ? select : null
    },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    safeLocalStorageGet: key => storage.get(key) ?? null,
    safeLocalStorageSet: (key, value) => { if (!canWrite) return false; storage.set(key, value); return true; },
    clearRendererStorageCorruption() {},
    registerRendererStorageCorruption: (...args) => corrupt.push(args),
    quarantineRendererStorageCorruptionGroup: () => true,
    setMonacoTheme: name => applied.push(name),
    toast() {},
    connectWebSocket() {}
  });
  vm.runInContext(between('function getMonacoTheme()', 'function setMonacoTheme('), context);
  vm.runInContext(between('// ============ CUSTOM THEME', '// ============ AUTO-UPDATER UI'), context);
  return { context, attributes, select, applied, corrupt, storage };
}

test('High Contrast selection persists, restores and selects the matching editor palette', () => {
  const current = themeHarness();
  assert.equal(current.context.setTheme('high-contrast'), true);
  assert.equal(current.attributes.get('data-theme'), 'high-contrast');
  assert.equal(current.select.value, 'high-contrast');
  assert.equal(current.storage.get('http-freekit-theme'), 'high-contrast');
  assert.equal(current.context.getMonacoTheme(), 'httptoolkit-high-contrast');
  assert.equal(current.applied.at(-1), 'httptoolkit-high-contrast');

  const restored = themeHarness(current.storage);
  assert.equal(restored.attributes.get('data-theme'), 'high-contrast');
  assert.equal(restored.select.value, 'high-contrast');
  assert.equal(restored.applied.at(-1), 'httptoolkit-high-contrast');
  assert.deepEqual(restored.corrupt, []);
  for (const [theme, editor] of [['light', 'httptoolkit-light'], ['dark', 'httptoolkit-dark']]) {
    assert.equal(restored.context.setTheme(theme), true);
    assert.equal(restored.context.getMonacoTheme(), editor);
    assert.equal(restored.applied.at(-1), editor);
  }
});

test('failed High Contrast persistence leaves the active theme and editor unchanged', () => {
  const current = themeHarness(new Map([['http-freekit-theme', 'light']]), false);
  assert.equal(current.context.setTheme('high-contrast'), false);
  assert.equal(current.attributes.get('data-theme'), 'light');
  assert.equal(current.select.value, 'light');
  assert.equal(current.storage.get('http-freekit-theme'), 'light');
  assert.equal(current.applied.at(-1), 'httptoolkit-light');
});
