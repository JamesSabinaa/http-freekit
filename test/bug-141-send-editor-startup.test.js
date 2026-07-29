import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const start = source.indexOf('function initializeSendTabs()');
const end = source.indexOf('function prepopulateSendUrl', start);
const initSource = source.slice(start, end);

test('Send startup reconciles editor presentation without reloading stored form state', () => {
  const awaitIndex = initSource.indexOf('await initSendBodyEditor');
  const afterAwait = initSource.slice(awaitIndex);

  assert.notEqual(awaitIndex, -1);
  assert.doesNotMatch(afterAwait, /loadSendTabState/);
  assert.match(afterAwait, /updateSendBodyLanguage\(\)/);
  assert.match(afterAwait, /updateSendBodyType\(\)/);
});

test('edits made while Monaco loads are not overwritten when startup finishes', async () => {
  let runEditorInitialization;
  let finishEditorInitialization;
  let loadCount = 0;
  let languageUpdates = 0;
  let typeUpdates = 0;
  const liveForm = { method: '', url: '', body: '' };
  const sendTabs = [{
    id: 'tab-1',
    method: 'GET',
    url: 'https://stored.example',
    body: 'stored body',
    bodyFormat: 'text'
  }];
  const editorReady = new Promise(resolve => { finishEditorInitialization = resolve; });

  const context = {
    activeSendTab: 'tab-1',
    sendTabs,
    renderSendHeaders() {},
    renderSendTabs() {},
    loadSendTabState(tab) {
      loadCount += 1;
      liveForm.method = tab.method;
      liveForm.url = tab.url;
      liveForm.body = tab.body;
    },
    setTimeout(callback) { runEditorInitialization = callback; },
    initSendBodyEditor() { return editorReady; },
    updateSendBodyLanguage() { languageUpdates += 1; },
    updateSendBodyType() { typeUpdates += 1; }
  };

  vm.runInNewContext(`${initSource}\ninitializeSendTabs();`, context);
  assert.deepEqual(liveForm, {
    method: 'GET',
    url: 'https://stored.example',
    body: 'stored body'
  });

  const initialization = runEditorInitialization();
  liveForm.method = 'POST';
  liveForm.url = 'https://edited.example';
  liveForm.body = 'edited while loading';
  finishEditorInitialization();
  await initialization;

  assert.deepEqual(liveForm, {
    method: 'POST',
    url: 'https://edited.example',
    body: 'edited while loading'
  });
  assert.equal(loadCount, 1);
  assert.equal(languageUpdates, 1);
  assert.equal(typeUpdates, 1);
});

test('Send state is loaded synchronously and stored bodies survive pre-Monaco tab changes', () => {
  const captureStart = source.indexOf('function captureActiveSendTabState()');
  const captureEnd = source.indexOf('function saveSendTabState()', captureStart);
  const captureSource = source.slice(captureStart, captureEnd);

  assert.ok(initSource.indexOf('loadSendTabState(startupTab)') < initSource.indexOf('setTimeout'));
  assert.match(captureSource, /tab\.body = getSendBodyValue\(\)/);
  assert.match(source, /restoreSendTabs\(\);\s*initializeSendTabs\(\);/);
});
