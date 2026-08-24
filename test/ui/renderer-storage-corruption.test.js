import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function between(startMarker, endMarker, fromIndex = 0) {
  const start = source.indexOf(startMarker, fromIndex);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must be present`);
  return source.slice(start, end);
}

const corruptionSource = between(
  'const rendererStorageCorruptions = new Map();',
  'function capturedConnectionHeaderNames('
);
const sendStorageSource = between(
  'function cloneSendFormFields(',
  'function preserveSendTabTransientState('
);
const protobufStorageSource = between(
  "const PROTOBUF_SCHEMA_STORAGE_KEY = 'http-freekit-protobuf-schemas';",
  'function refreshVisibleBodyViewers('
);
const themeStart = source.indexOf('var _customThemeStyleEl = null;');
const themeStorageSource = between('var _customThemeStyleEl = null;', '    loadTheme();', themeStart);

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get length() { return values.size; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); }
  };
}

function storageContext(storage, { approve = false } = {}) {
  const toasts = [];
  const errors = [];
  const context = {
    window: { localStorage: storage },
    toast: (message, type) => toasts.push({ message, type }),
    console: { error: (...args) => errors.push(args.join(' ')) },
    confirm: () => context.approve,
    approve,
    safeLocalStorageGet(key, fallback = null) {
      const value = storage.getItem(key);
      return value === null ? fallback : value;
    },
    safeLocalStorageSet(key, value) {
      storage.setItem(key, value);
      return true;
    },
    safeLocalStorageRemove(key) {
      storage.removeItem(key);
      return true;
    }
  };
  return { context, toasts, errors };
}

function corruptBackups(storage) {
  return Array.from(storage.values.entries())
    .filter(([key]) => key.startsWith('http-freekit-corrupt-backup:'));
}

test('recovery approval cannot quarantine bytes replaced after corruption was diagnosed', () => {
  const key = 'http-freekit-protobuf-schemas';
  const original = '{broken';
  const replacement = '[{"name":"fixed.proto","content":"message Fixed {}"}]';
  const storage = createStorage({ [key]: original });
  const { context, toasts } = storageContext(storage, { approve: true });
  vm.createContext(context);
  vm.runInContext(`
    ${corruptionSource}
    registerRendererStorageCorruption(
      ${JSON.stringify(key)},
      ${JSON.stringify(original)},
      'protobuf',
      'Stored Protobuf schemas',
      'invalid JSON'
    );
    globalThis.corruptionApi = {
      recover: () => quarantineRendererStorageCorruptionGroup('protobuf', 'Save Protobuf schemas'),
      clear: () => clearRendererStorageCorruption(${JSON.stringify(key)}),
      corrupt: () => hasRendererStorageCorruption('protobuf')
    };
  `, context);

  storage.setItem(key, replacement);
  assert.equal(context.corruptionApi.recover(), false);
  assert.equal(storage.getItem(key), replacement);
  assert.equal(corruptBackups(storage).length, 0);
  assert.equal(context.corruptionApi.corrupt(), true);
  assert.match(toasts.at(-1).message, /changed during recovery/i);

  context.corruptionApi.clear();
  assert.equal(context.corruptionApi.corrupt(), false);
});

test('corrupt Send workspace and journals stay byte-for-byte until explicit quarantine', async () => {
  const workspaceKey = 'http-freekit-send-workspace-v2';
  const currentWorkspaceKey = 'http-freekit-send-workspace-v3';
  const journalKey = 'http-freekit-send-journal-v1:tab-1:broken';
  const corruptWorkspace = '{"version":2,"tabs":"not-an-array"}';
  const corruptJournal = '{not-json';
  const storage = createStorage({
    [workspaceKey]: corruptWorkspace,
    [journalKey]: corruptJournal
  });
  const { context, toasts } = storageContext(storage);
  vm.createContext(context);
  vm.runInContext(`
    let activeSendTab = 'tab-1';
    ${corruptionSource}
    ${sendStorageSource}
    globalThis.sendStorageApi = {
      readWorkspace: readStoredSendWorkspace,
      readJournals: readStoredSendTabJournals,
      persist: persistSendTabs,
      corrupt: () => hasRendererStorageCorruption('send')
    };
  `, context);

  context.sendStorageApi.readWorkspace();
  context.sendStorageApi.readJournals();
  assert.equal(context.sendStorageApi.corrupt(), true);
  assert.equal(storage.getItem(workspaceKey), corruptWorkspace);
  assert.equal(storage.getItem(journalKey), corruptJournal);

  const tab = { id: 'tab-1', method: 'GET', url: 'https://example.test/' };
  assert.equal(await context.sendStorageApi.persist([tab]), null);
  assert.equal(storage.getItem(workspaceKey), corruptWorkspace);
  assert.equal(storage.getItem(journalKey), corruptJournal);
  assert.equal(corruptBackups(storage).length, 0);
  assert.match(toasts.at(-1).message, /canceled.*unchanged/i);

  context.approve = true;
  const saved = await context.sendStorageApi.persist([tab]);
  assert.equal(context.sendStorageApi.corrupt(), false);
  assert.equal(saved.tabs[0].url, 'https://example.test/');
  assert.equal(storage.getItem(journalKey), null);
  assert.equal(
    JSON.parse(storage.getItem(currentWorkspaceKey)).tabs[0].tab.url,
    'https://example.test/'
  );
  assert.deepEqual(
    corruptBackups(storage).map(([, value]) => value).sort(),
    [corruptJournal, corruptWorkspace].sort()
  );
});

test('invalid Protobuf schema structure blocks replacement until raw data is quarantined', () => {
  const schemaKey = 'http-freekit-protobuf-schemas';
  const corruptSchemas = '{"schemas":"wrong-shape"}';
  const storage = createStorage({ [schemaKey]: corruptSchemas });
  const { context, toasts } = storageContext(storage);
  context.document = {
    getElementById: id => id === 'protobufSchemaStatus'
      ? { textContent: '', title: '', style: {} }
      : null
  };
  context.window.protobuf = {
    Root: class { resolveAll() {} },
    parse() {}
  };
  vm.createContext(context);
  vm.runInContext(`
    let protobufSchemaFiles = [];
    let protobufRoot = null;
    let protobufSchemaError = '';
    ${corruptionSource}
    ${protobufStorageSource}
    globalThis.protobufStorageApi = {
      load: loadProtobufSchemas,
      save: saveProtobufSchemas,
      corrupt: () => hasRendererStorageCorruption('protobuf'),
      files: () => protobufSchemaFiles
    };
  `, context);

  context.protobufStorageApi.load();
  assert.equal(context.protobufStorageApi.corrupt(), true);
  assert.equal(storage.getItem(schemaKey), corruptSchemas);
  assert.deepEqual(Array.from(context.protobufStorageApi.files()), []);

  const candidate = [{ name: 'message.proto', content: 'message Example {}' }];
  assert.equal(context.protobufStorageApi.save(candidate), false);
  assert.equal(storage.getItem(schemaKey), corruptSchemas);
  assert.equal(corruptBackups(storage).length, 0);
  assert.match(toasts.at(-1).message, /canceled.*unchanged/i);

  context.approve = true;
  assert.equal(context.protobufStorageApi.save(candidate), true);
  assert.deepEqual(JSON.parse(storage.getItem(schemaKey)), candidate);
  assert.deepEqual(corruptBackups(storage).map(([, value]) => value), [corruptSchemas]);
});

test('corrupt theme selection and custom theme block writes until explicit recovery', () => {
  const selectionKey = 'http-freekit-theme';
  const customKey = 'http-freekit-custom-theme';
  const corruptSelection = 'neon';
  const corruptCustom = '{"bg-main":"url(https://example.test/unsafe)"}';
  const storage = createStorage({
    [selectionKey]: corruptSelection,
    [customKey]: corruptCustom
  });
  const { context, toasts } = storageContext(storage);
  const rootAttributes = new Map();
  context.CSS = { supports: () => true };
  context.document = {
    documentElement: { setAttribute: (name, value) => rootAttributes.set(name, value) },
    head: { appendChild() {} },
    createElement: () => ({ style: {}, remove() {} }),
    getElementById: () => null
  };
  context.window.matchMedia = () => ({ matches: false, addEventListener() {} });
  context.setMonacoTheme = () => {};
  vm.createContext(context);
  vm.runInContext(`
    ${corruptionSource}
    ${themeStorageSource}
    globalThis.themeStorageApi = {
      load: loadTheme,
      set: setTheme,
      corrupt: () => hasRendererStorageCorruption('theme')
    };
  `, context);

  context.themeStorageApi.load();
  assert.equal(context.themeStorageApi.corrupt(), true);
  assert.equal(rootAttributes.get('data-theme'), 'dark');
  assert.equal(storage.getItem(selectionKey), corruptSelection);
  assert.equal(storage.getItem(customKey), corruptCustom);

  assert.equal(context.themeStorageApi.set('light'), false);
  assert.equal(storage.getItem(selectionKey), corruptSelection);
  assert.equal(storage.getItem(customKey), corruptCustom);
  assert.equal(corruptBackups(storage).length, 0);
  assert.match(toasts.at(-1).message, /canceled.*unchanged/i);

  context.approve = true;
  assert.equal(context.themeStorageApi.set('light'), true);
  assert.equal(rootAttributes.get('data-theme'), 'light');
  assert.equal(storage.getItem(selectionKey), 'light');
  assert.equal(storage.getItem(customKey), null);
  assert.deepEqual(
    corruptBackups(storage).map(([, value]) => value).sort(),
    [corruptCustom, corruptSelection].sort()
  );
});
