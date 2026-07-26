import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const appSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'index.html'), 'utf8');

function between(startText, endText) {
  const start = appSource.indexOf(startText);
  const end = appSource.indexOf(endText, start + startText.length);
  assert.notEqual(start, -1, `${startText} should exist`);
  assert.notEqual(end, -1, `${endText} should follow ${startText}`);
  return appSource.slice(start, end);
}

function createMonacoReadyHarness(overrides = {}) {
  const warnings = [];
  const context = {
    console: { warn: (...args) => warnings.push(args) },
    setTimeout,
    clearTimeout,
    ...overrides
  };
  vm.createContext(context);
  vm.runInContext(`
    ${between('let monacoApi = null;', 'const monacoInstances = [];')}
    globalThis.ready = monacoReady;
    globalThis.timeoutMs = MONACO_LOAD_TIMEOUT_MS;
    globalThis.getMonacoApi = () => monacoApi;
  `, context);
  return { context, warnings };
}

test('index bootstrap tolerates a missing or throwing AMD loader', () => {
  const loaderIndex = indexSource.indexOf('<script src="/vendor/monaco/vs/loader.js"></script>');
  const scriptStart = indexSource.indexOf('<script>', loaderIndex) + '<script>'.length;
  const scriptEnd = indexSource.indexOf('</script>', scriptStart);
  const bootstrap = indexSource.slice(scriptStart, scriptEnd);

  assert.doesNotThrow(() => vm.runInNewContext(bootstrap, {
    window: {},
    console: { warn: () => {} }
  }));

  const throwingRequire = () => {};
  throwingRequire.config = () => { throw new Error('bad loader'); };
  assert.doesNotThrow(() => vm.runInNewContext(bootstrap, {
    window: { require: throwingRequire },
    console: { warn: () => {} }
  }));
});

test('Monaco readiness settles to null for missing require, AMD errors, and initialization errors', async () => {
  const missing = createMonacoReadyHarness();
  assert.equal(await missing.context.ready, null);
  assert.equal(missing.context.getMonacoApi(), null);

  const amdError = createMonacoReadyHarness({
    require: (_modules, _success, fail) => fail(new Error('asset unavailable'))
  });
  assert.equal(await amdError.context.ready, null);
  assert.equal(amdError.context.getMonacoApi(), null);

  const initializationError = createMonacoReadyHarness({
    require: (_modules, success) => success({
      editor: {
        create: () => ({}),
        defineTheme: () => { throw new Error('theme setup failed'); }
      }
    })
  });
  assert.equal(await initializationError.context.ready, null);
  assert.equal(initializationError.context.getMonacoApi(), null);
});

test('Monaco readiness exposes the API only after successful initialization', async () => {
  const themes = [];
  const monaco = {
    editor: {
      create: () => ({}),
      defineTheme: name => themes.push(name)
    }
  };
  const harness = createMonacoReadyHarness({
    require: (_modules, success) => success(monaco)
  });

  assert.equal(await harness.context.ready, monaco);
  assert.equal(harness.context.getMonacoApi(), monaco);
  assert.deepEqual(themes, ['httptoolkit-dark', 'httptoolkit-light']);
});

test('Monaco readiness has a five-second bounded timeout and ignores late success', async () => {
  let timeoutCallback;
  let timeoutDelay;
  let loadSuccess;
  const harness = createMonacoReadyHarness({
    require: (_modules, success) => { loadSuccess = success; },
    setTimeout: (callback, delay) => {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return 1;
    },
    clearTimeout: () => {}
  });

  assert.equal(harness.context.timeoutMs, 5000);
  assert.equal(timeoutDelay, 5000);
  timeoutCallback();
  assert.equal(await harness.context.ready, null);

  loadSuccess({ editor: { create: () => ({}), defineTheme: () => {} } });
  assert.equal(harness.context.getMonacoApi(), null);
});

test('editor creation and ResizeObserver exceptions settle to null with cleanup', async () => {
  async function runCreation(editorFactory, ResizeObserverClass) {
    const container = {};
    const context = {
      console: { warn: () => {} },
      document: {
        getElementById: id => id === 'body-monaco' ? container : null,
        body: { contains: candidate => candidate === container }
      },
      ResizeObserver: ResizeObserverClass,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      }
    };
    vm.createContext(context);
    vm.runInContext(`
      let sendBodyEditor = null;
      const activeBodyEditors = {};
      const monacoReady = Promise.resolve({ editor: { create: globalThis.editorFactory } });
      function getMonacoTheme() { return 'test-theme'; }
      ${between('const monacoInstances = [];', 'async function createMonacoEditor')}
      ${between('async function createMonacoEditor', 'function getMonacoTheme')}
      globalThis.create = createMonacoEditor;
    `, Object.assign(context, { editorFactory }));
    return context.create('body-monaco', { value: 'body' });
  }

  assert.equal(await runCreation(
    () => { throw new Error('editor init failed'); },
    class { observe() {} disconnect() {} }
  ), null);

  let disposed = 0;
  let disconnected = 0;
  assert.equal(await runCreation(
    () => ({ dispose: () => { disposed += 1; } }),
    class {
      observe() { throw new Error('resize setup failed'); }
      disconnect() { disconnected += 1; }
    }
  ), null);
  assert.equal(disposed, 1);
  assert.equal(disconnected, 1);
});

test('body viewers keep populated fallback content through Monaco failure', async () => {
  const wrapper = { dataset: {} };
  const monacoContainer = { style: { display: 'block' } };
  const fallback = { style: { display: 'none' }, innerHTML: '' };
  const elements = {
    body: wrapper,
    'body-monaco': monacoContainer,
    'body-fallback': fallback
  };
  const context = {
    console: { warn: () => {} },
    document: {
      getElementById: id => elements[id] || null,
      body: { contains: () => true }
    },
    window: { innerHeight: 1000 }
  };
  vm.createContext(context);
  vm.runInContext(`
    const bodySchemaTypeOverrides = {};
    const activeBodyEditors = {};
    function disposeBodyEditor() {}
    function viewModeToMonacoLanguage() { return 'json'; }
    function getMonacoBodyValue(body) { return body; }
    async function createMonacoEditor() { return null; }
    function isMonacoEditorCurrent() { return false; }
    function disposeMonacoEditor() {}
    function updateProtobufTypeSelect() {}
    function isMonacoViewMode() { return true; }
    function formatBodyAs(body, _contentType, mode) { return mode + ':' + body; }
    ${between('async function initBodyMonacoEditor', '// Switch body view mode')}
    globalThis.render = renderBodyViewer;
  `, context);

  context.render('body', '{"ok":true}', 'application/json', 'json');
  assert.equal(fallback.style.display, 'block');
  assert.equal(fallback.innerHTML, 'json:{"ok":true}');
  assert.equal(monacoContainer.style.display, 'none');

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fallback.style.display, 'block');
  assert.equal(fallback.innerHTML, 'json:{"ok":true}');
  assert.equal(monacoContainer.style.display, 'none');

  fallback.style.display = 'none';
  monacoContainer.style.display = 'block';
  vm.runInContext(`createMonacoEditor = async () => { throw new Error('observer failed'); };`, context);
  context.render('body', 'still visible', 'text/plain', 'text');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fallback.style.display, 'block');
  assert.equal(fallback.innerHTML, 'text:still visible');
  assert.equal(monacoContainer.style.display, 'none');
});

test('read-only export viewers restore populated fallbacks when Monaco is unavailable', async () => {
  const exportContainer = { style: { display: 'block' } };
  const exportFallback = { style: { display: 'none' }, textContent: '' };
  const sendContainer = { style: { display: 'block' } };
  const sendFallback = { style: { display: 'none' }, textContent: '' };
  const elements = {
    exportFormat: { value: 'curl' },
    'exportSnippetContent-monaco': exportContainer,
    'exportSnippetContent-fallback': exportFallback,
    sendExportFormat: { value: 'curl' },
    'sendExportContent-monaco': sendContainer,
    'sendExportContent-fallback': sendFallback
  };
  const context = {
    console: { warn: () => {} },
    document: { getElementById: id => elements[id] || null },
    window: { _currentExportRequest: { url: 'https://example.test/' } }
  };
  vm.createContext(context);
  vm.runInContext(`
    const activeBodyEditors = {};
    let monacoApi = null;
    let sendExportCreating = false;
    function generateExportSnippet() { return 'curl https://example.test/'; }
    function disposeBodyEditor() {}
    function exportFormatToMonacoLanguage() { return 'shell'; }
    async function createMonacoEditor() { return null; }
    function isMonacoEditorCurrent() { return false; }
    function disposeMonacoEditor() {}
    function autoSizeExportEditor() {}
    function getCurrentSendExportRequest() { return {}; }
    ${between('function updateExportSnippet()', 'function getCurrentSendExportRequest()')}
    ${between('async function updateSendExportSnippet()', 'function copySendExportSnippet()')}
    globalThis.updateExport = updateExportSnippet;
    globalThis.updateSendExport = updateSendExportSnippet;
  `, context);

  context.updateExport();
  await context.updateSendExport();
  await Promise.resolve();

  assert.equal(exportFallback.textContent, 'curl https://example.test/');
  assert.equal(exportFallback.style.display, 'block');
  assert.equal(exportContainer.style.display, 'none');
  assert.equal(sendFallback.textContent, 'curl https://example.test/');
  assert.equal(sendFallback.style.display, 'block');
  assert.equal(sendContainer.style.display, 'none');
});

test('Send textarea fallback preserves editing, formatting, payload, and Ctrl+Enter', async () => {
  const container = { innerHTML: 'stale', style: { display: 'block' } };
  const fallback = { value: '', dataset: {}, style: { display: 'none' } };
  const format = { value: 'json' };
  const elements = {
    'sendBody-monaco-container': container,
    'sendBody-fallback': fallback,
    sendBodyFormat: format
  };
  const toasts = [];
  let sends = 0;
  const context = {
    console: { warn: () => {} },
    document: { getElementById: id => elements[id] || null },
    TextEncoder
  };
  vm.createContext(context);
  vm.runInContext(`
    let sendBodyEditor = null;
    let monacoApi = null;
    function disposeMonacoEditor() {}
    function sendFormatToMonacoLanguage() { return 'json'; }
    async function createMonacoEditor() { return null; }
    function isMonacoEditorCurrent() { return false; }
    function scheduleSendExportUpdate() {}
    function sendRequest() { globalThis.sends += 1; }
    function handleSendEscapeShortcut() {}
    function toast(message, type) { globalThis.toasts.push({ message, type }); }
    function beautifyMarkup(value) { return value; }
    function beautifyJs(value) { return value; }
    function beautifyCss(value) { return value; }
    function getSendBodyType() { return 'raw'; }
    function setDefaultHeader(headers, name, value) { headers[name] = value; }
    function formatToContentType() { return 'application/json'; }
    ${between('function getSendBodyValue()', 'function createMultipartBoundary()')}
    ${between('async function prepareSendRequestPayload(headers)', 'async function sendRequest()')}
    globalThis.toasts = [];
    globalThis.sends = 0;
    globalThis.harness = {
      initSendBodyEditor,
      getSendBodyValue,
      setSendBodyValue,
      formatSendBody,
      handleSendBodyFallbackKeydown,
      prepareSendRequestPayload
    };
  `, context);

  assert.equal(await context.harness.initSendBodyEditor('{"stored":true}', 'json'), null);
  assert.equal(fallback.value, '{"stored":true}');
  assert.equal(fallback.style.display, 'block');
  assert.equal(container.style.display, 'none');

  context.harness.setSendBodyValue('{"answer":42}');
  context.harness.formatSendBody();
  assert.equal(context.harness.getSendBodyValue(), '{\n  "answer": 42\n}');
  assert.deepEqual(JSON.parse(JSON.stringify(context.toasts)), [
    { message: 'JSON formatted', type: 'success' }
  ]);

  const headers = {};
  const payload = await context.harness.prepareSendRequestPayload(headers);
  assert.equal(payload.body, '{\n  "answer": 42\n}');
  assert.equal(payload.bodyEncoding, 'utf8');
  assert.equal(headers['Content-Type'], 'application/json');

  let prevented = false;
  context.harness.handleSendBodyFallbackKeydown({
    key: 'Enter',
    ctrlKey: true,
    metaKey: false,
    preventDefault: () => { prevented = true; }
  });
  assert.equal(prevented, true);
  assert.equal(context.sends, 1);
});
