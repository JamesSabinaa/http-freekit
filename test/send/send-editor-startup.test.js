import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const start = source.indexOf('function initializeSendTabs()');
const end = source.indexOf('function prepopulateSendUrl', start);
const initSource = source.slice(start, end);
const editorStart = source.indexOf('async function initSendBodyEditor(');
const languageStart = source.indexOf('function updateSendBodyLanguage()', editorStart);
const languageEnd = source.indexOf('/** @deprecated', languageStart);
const bodyTypeStart = source.indexOf('function getSendBodyType()');
const bodyTypeEnd = source.indexOf('function getSendMultipartFilePresentation(', bodyTypeStart);
const switchStart = source.indexOf('function switchSendTab(');
const switchEnd = source.indexOf('function addSendTab(', switchStart);

for (const boundary of [editorStart, languageStart, languageEnd, bodyTypeStart, bodyTypeEnd, switchStart, switchEnd]) {
  assert.notEqual(boundary, -1);
}

test('Send startup reconciles editor presentation without reloading stored form state', () => {
  const awaitIndex = initSource.indexOf('await initSendBodyEditor');
  const afterAwait = initSource.slice(awaitIndex);

  assert.notEqual(awaitIndex, -1);
  assert.doesNotMatch(afterAwait, /loadSendTabState/);
  assert.match(afterAwait, /updateSendBodyLanguage\(\)/);
  assert.match(afterAwait, /updateSendBodyType\(\)/);
});

test('a tab switch and live body presentation edits survive delayed Monaco startup', async () => {
  let runEditorInitialization;
  let finishEditorInitialization;
  let editorOptions;
  let loadCount = 0;
  let saveCount = 0;
  let layoutCount = 0;
  const elements = {
    'sendBody-monaco-container': { innerHTML: '', style: {} },
    'sendBody-fallback': { value: '', dataset: {}, style: {} },
    sendRawBodyEditor: { style: {} },
    sendFormBodyEditor: { style: {} },
    sendBodyFormat: { value: 'text', style: {} },
    sendBodyFormatBtn: { style: {} },
    sendBodyType: { value: 'raw' },
    sendMethod: { value: '' },
    sendUrl: { value: '' }
  };
  const sendTabs = [
    {
      id: 'tab-a', method: 'GET', url: 'https://a.example', body: 'stored A',
      bodyFormat: 'text', bodyType: 'raw'
    },
    {
      id: 'tab-b', method: 'POST', url: 'https://b.example', body: 'stored B',
      bodyFormat: 'xml', bodyType: 'urlencoded'
    }
  ];
  const editorReady = new Promise(resolve => { finishEditorInitialization = resolve; });
  const model = { language: null };
  let editorValue = '';
  const editor = {
    getValue() { return editorValue; },
    setValue(value) { editorValue = value; },
    getModel() { return model; },
    onDidChangeModelContent() {},
    layout() { layoutCount += 1; }
  };

  const context = {
    activeSendTab: 'tab-a',
    sendTabs,
    console,
    document: { getElementById(id) { return elements[id] || null; } },
    __monacoApi: {
      editor: {
        setModelLanguage(editorModel, language) { editorModel.language = language; }
      }
    },
    renderSendHeaders() {},
    renderSendTabs() {},
    loadSendTabState(tab) {
      loadCount += 1;
      elements.sendMethod.value = tab.method;
      elements.sendUrl.value = tab.url;
      elements['sendBody-fallback'].value = tab.body;
      elements['sendBody-fallback'].dataset.bodyInitialized = 'true';
      elements.sendBodyFormat.value = tab.bodyFormat;
      elements.sendBodyType.value = tab.bodyType;
    },
    setTimeout(callback) { runEditorInitialization = callback; },
    createMonacoEditor(_containerId, options) {
      editorOptions = options;
      editorValue = options.value;
      model.language = options.language;
      return editorReady;
    },
    isMonacoEditorCurrent() { return true; },
    disposeMonacoEditor() {},
    registerSendEditorShortcuts() {},
    sendFormatToMonacoLanguage(format) { return format === 'text' ? 'plaintext' : format; },
    scheduleSendExportUpdate() {},
    createMultipartBoundary() { return 'boundary'; },
    renderSendFormFields() {},
    saveSendTabState() { saveCount += 1; },
    safeLocalStorageSet() {}
  };

  vm.createContext(context);
  vm.runInContext(`
    let sendBodyEditor = null;
    let monacoApi = __monacoApi;
    let sendUrlEncodedFields = [];
    let sendMultipartFields = [];
    let sendMultipartBoundary = '';
    ${source.slice(editorStart, languageStart)}
    ${source.slice(languageStart, languageEnd)}
    ${source.slice(bodyTypeStart, bodyTypeEnd)}
    ${source.slice(switchStart, switchEnd)}
    ${initSource}
  `, context);

  context.initializeSendTabs();
  assert.equal(elements.sendUrl.value, 'https://a.example');

  const initialization = runEditorInitialization();
  assert.equal(editorOptions.value, 'stored A');
  assert.equal(editorOptions.language, 'plaintext');

  context.switchSendTab('tab-b');
  elements.sendMethod.value = 'PATCH';
  elements.sendUrl.value = 'https://edited-b.example';
  elements['sendBody-fallback'].value = 'edited B while loading';
  elements.sendBodyFormat.value = 'json';
  elements.sendBodyType.value = 'raw';
  finishEditorInitialization(editor);
  await initialization;

  assert.equal(context.activeSendTab, 'tab-b');
  assert.equal(elements.sendMethod.value, 'PATCH');
  assert.equal(elements.sendUrl.value, 'https://edited-b.example');
  assert.equal(editorValue, 'edited B while loading');
  assert.equal(model.language, 'json');
  assert.equal(elements.sendRawBodyEditor.style.display, 'block');
  assert.equal(elements.sendFormBodyEditor.style.display, 'none');
  assert.equal(elements['sendBody-monaco-container'].style.display, 'block');
  assert.equal(elements['sendBody-fallback'].style.display, 'none');
  assert.equal(loadCount, 2);
  assert.equal(saveCount, 1);
  assert.equal(layoutCount, 2);
});

test('Send state is loaded synchronously and stored bodies survive pre-Monaco tab changes', () => {
  const captureStart = source.indexOf('function captureActiveSendTabState()');
  const captureEnd = source.indexOf('function saveSendTabState()', captureStart);
  const captureSource = source.slice(captureStart, captureEnd);

  assert.ok(initSource.indexOf('loadSendTabState(startupTab)') < initSource.indexOf('setTimeout'));
  assert.match(captureSource, /tab\.body = getSendBodyValue\(\)/);
  assert.match(source, /restoreSendTabs\(\);\s*initializeSendTabs\(\);/);
});
