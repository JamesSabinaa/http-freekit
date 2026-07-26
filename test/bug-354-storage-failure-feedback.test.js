import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function storageHelpersContext(storage) {
  const toasts = [];
  const context = {
    window: { localStorage: storage },
    document: { getElementById: id => id === 'toastContainer' ? {} : null },
    console: { warn() {} },
    toast: (message, type) => toasts.push({ message, type })
  };
  const start = source.indexOf('let localStoragePersistenceWarningShown');
  const end = source.indexOf('function buildTrafficViewHash', start);
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { context, toasts };
}

function protobufContext({ setResult = true, removeResult = true } = {}) {
  const toasts = [];
  let input;
  const context = {
    window: {},
    document: {
      createElement() {
        input = { click() {} };
        return input;
      },
      getElementById() { return null; }
    },
    safeLocalStorageGet: () => null,
    safeLocalStorageSet: () => setResult,
    safeLocalStorageRemove: () => removeResult,
    toast: (message, type) => toasts.push({ message, type }),
    renderDetailCards() {},
    renderBodyViewer() {},
    selectedRequestId: null,
    standaloneBodyViewers: {},
    bodySchemaTypeOverrides: { viewer: 'saved.Type' }
  };
  const start = source.indexOf("const PROTOBUF_SCHEMA_STORAGE_KEY");
  const end = source.indexOf('function updateProtobufTypeSelect', start);
  vm.createContext(context);
  vm.runInContext(
    'var protobufSchemaFiles = [{ name: "old.proto", content: "old" }];' +
      'var protobufRoot = { existing: true }; var protobufSchemaError = "";\n' +
      source.slice(start, end),
    context
  );
  return { context, input: () => input, toasts };
}

function themeContext(storage) {
  const toasts = [];
  const calls = [];
  let input;
  const context = {
    document: {
      createElement() {
        input = { click() {} };
        return input;
      },
      getElementById() { return null; }
    },
    safeLocalStorageGet: (key, fallback = null) => storage.has(key) ? storage.get(key) : fallback,
    safeLocalStorageSet: (key, value) => {
      calls.push(['set', key, value]);
      return storage.set(key, value);
    },
    safeLocalStorageRemove: key => {
      calls.push(['remove', key]);
      return storage.remove(key);
    },
    sanitizeCustomThemeData: value => value,
    applyCustomThemeData: value => calls.push(['apply', value]),
    renderCustomThemeSwatches: value => calls.push(['render', value]),
    setTheme: (value, persist) => calls.push(['theme', value, persist]),
    toast: (message, type) => toasts.push({ message, type }),
    _customThemeStyleEl: null
  };
  const start = source.indexOf('function uploadCustomTheme');
  const end = source.indexOf('function updateCustomThemeSection', start);
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { calls, context, input: () => input, toasts };
}

test('routine storage failures show one actionable warning without throwing', () => {
  const { context, toasts } = storageHelpersContext({
    setItem() { throw new Error('quota exceeded'); },
    removeItem() { throw new Error('blocked'); }
  });

  assert.equal(context.safeLocalStorageSet('send-tabs', 'value'), false);
  assert.equal(context.safeLocalStorageSet('traffic-scroll', '12'), false);
  assert.equal(context.safeLocalStorageRemove('active-tab'), false);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].type, 'error');
  assert.match(toasts[0].message, /storage permissions|free up browser storage/);

  assert.equal(context.safeLocalStorageSet('explicit-action', 'value', false), false);
  assert.equal(toasts.length, 1);
});

test('protobuf import and clear retain live state when storage fails', async () => {
  const imported = protobufContext({ setResult: false });
  imported.context.importProtobufSchemas();
  await imported.input().onchange({
    target: { files: [{ name: 'new.proto', text: async () => 'message New {}' }] }
  });

  assert.deepEqual(
    plain(vm.runInContext('protobufSchemaFiles', imported.context)),
    [{ name: 'old.proto', content: 'old' }]
  );
  assert.equal(imported.toasts.length, 1);
  assert.equal(imported.toasts[0].type, 'error');
  assert.doesNotMatch(imported.toasts[0].message, /^Imported /);

  const cleared = protobufContext({ removeResult: false });
  cleared.context.clearProtobufSchemas();
  assert.deepEqual(
    plain(vm.runInContext('protobufSchemaFiles', cleared.context)),
    [{ name: 'old.proto', content: 'old' }]
  );
  assert.deepEqual(plain(cleared.context.bodySchemaTypeOverrides), { viewer: 'saved.Type' });
  assert.equal(cleared.toasts.length, 1);
  assert.equal(cleared.toasts[0].type, 'error');
  assert.doesNotMatch(cleared.toasts[0].message, /schemas cleared/);
});

test('custom-theme upload does not apply or report success when saving fails', async () => {
  const values = new Map();
  const ui = themeContext({
    has: key => values.has(key),
    get: key => values.get(key),
    set: () => false,
    remove: () => false
  });

  ui.context.uploadCustomTheme();
  ui.input().onchange({
    target: { files: [{ text: async () => '{"bg":"#123456"}' }] }
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(ui.calls.some(call => ['apply', 'render', 'theme'].includes(call[0])), false);
  assert.deepEqual(ui.toasts.map(toast => toast.type), ['error']);
  assert.doesNotMatch(ui.toasts[0].message, /loaded|applied/);
});

test('custom-theme upload rolls back its first write when theme selection cannot persist', async () => {
  const values = new Map([
    ['http-freekit-custom-theme', '{"bg":"#000000"}']
  ]);
  const ui = themeContext({
    has: key => values.has(key),
    get: key => values.get(key),
    set: (key, value) => {
      if (key === 'http-freekit-theme') return false;
      values.set(key, value);
      return true;
    },
    remove: key => values.delete(key)
  });

  ui.context.uploadCustomTheme();
  ui.input().onchange({
    target: { files: [{ text: async () => '{"bg":"#123456"}' }] }
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(values.get('http-freekit-custom-theme'), '{"bg":"#000000"}');
  assert.equal(ui.calls.some(call => ['apply', 'render', 'theme'].includes(call[0])), false);
  assert.deepEqual(ui.toasts.map(toast => toast.type), ['error']);
});

test('custom-theme removal retains the live theme when removeItem fails', () => {
  const values = new Map([
    ['http-freekit-theme', 'custom'],
    ['http-freekit-custom-theme', '{"bg":"#123456"}']
  ]);
  const ui = themeContext({
    has: key => values.has(key),
    get: key => values.get(key),
    set: (key, value) => { values.set(key, value); return true; },
    remove: () => false
  });

  ui.context.removeCustomTheme();

  assert.equal(values.get('http-freekit-theme'), 'custom');
  assert.equal(values.get('http-freekit-custom-theme'), '{"bg":"#123456"}');
  assert.equal(ui.calls.some(call => call[0] === 'theme'), false);
  assert.deepEqual(ui.toasts.map(toast => toast.type), ['error']);
  assert.doesNotMatch(ui.toasts[0].message, /theme removed/);
});

test('startup theme restoration applies without rewriting local storage', () => {
  const start = source.indexOf('function loadTheme');
  const end = source.indexOf('// Re-apply theme', start);
  const loadThemeSource = source.slice(start, end);

  assert.match(loadThemeSource, /setTheme\(saved, false\)/);
  assert.doesNotMatch(loadThemeSource, /safeLocalStorageSet/);
});
