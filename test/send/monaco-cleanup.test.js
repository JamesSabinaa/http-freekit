import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function between(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(start, -1, `${startText} should exist`);
  assert.notEqual(end, -1, `${endText} should follow ${startText}`);
  return source.slice(start, end);
}

test('central Monaco cleanup is idempotent and releases every retained resource', () => {
  const lifecycleSource = between(
    'const monacoInstances = [];',
    'async function createMonacoEditor'
  );
  const context = {};
  vm.runInNewContext(`
    let sendBodyEditor = null;
    const activeBodyEditors = {};
    ${lifecycleSource}
    globalThis.harness = {
      activeBodyEditors,
      monacoInstances,
      disposeMonacoEditor,
      setSendBodyEditor(editor) { sendBodyEditor = editor; },
      getSendBodyEditor() { return sendBodyEditor; }
    };
  `, context);

  const calls = { dispose: 0, resize: 0, mutation: 0 };
  const editor = { dispose: () => { calls.dispose += 1; } };
  context.harness.activeBodyEditors.body = editor;
  context.harness.setSendBodyEditor(editor);
  context.harness.monacoInstances.push({
    editor,
    resizeObserver: { disconnect: () => { calls.resize += 1; } },
    mutationObserver: { disconnect: () => { calls.mutation += 1; } }
  });

  context.harness.disposeMonacoEditor(editor);
  context.harness.disposeMonacoEditor(editor);

  assert.deepEqual(calls, { dispose: 1, resize: 1, mutation: 1 });
  assert.equal(context.harness.monacoInstances.length, 0);
  assert.equal(context.harness.activeBodyEditors.body, undefined);
  assert.equal(context.harness.getSendBodyEditor(), null);
});

test('all Monaco disposal paths use centralized lifecycle cleanup', () => {
  const bodyDisposal = between('function disposeBodyEditor', 'function getMonacoBodyValue');
  const sendInitialization = between('async function initSendBodyEditor', 'function updateSendBodyLanguage');
  const creation = between('async function createMonacoEditor', 'function getMonacoTheme');

  assert.match(bodyDisposal, /disposeMonacoContainer\(containerId\)/);
  assert.match(sendInitialization, /disposeMonacoEditor\(sendBodyEditor\)/);
  assert.doesNotMatch(sendInitialization, /sendBodyEditor\.dispose/);
  assert.match(creation, /claimMonacoContainer\(containerId\)/);
  assert.match(creation, /monacoContainerGenerations\.get\(containerId\) !== generation/);
  assert.match(creation, /document\.getElementById\(containerId\) !== container/);
  assert.match(creation, /instance\.mutationObserver = mutationObserver/);
  assert.match(creation, /disposeMonacoEditor\(editor\)/);
});

test('deferred Monaco initialization leaves only the latest container owner alive', async () => {
  const lifecycleSource = between(
    'const monacoInstances = [];',
    'async function createMonacoEditor'
  );
  const creationSource = between(
    'async function createMonacoEditor',
    'function getMonacoTheme'
  );
  const context = { console };
  vm.runInNewContext(`
    let sendBodyEditor = null;
    const activeBodyEditors = {};
    let resolveMonaco;
    const monacoReady = new Promise(resolve => { resolveMonaco = resolve; });
    let currentContainer = { id: 'persistent-container' };
    const createdEditors = [];
    const resizeObservers = [];
    const mutationObservers = [];
    const document = {
      getElementById(id) {
        return id === 'persistent-container' ? currentContainer : null;
      },
      body: {
        contains(container) { return container === currentContainer; }
      }
    };
    class ResizeObserver {
      constructor(callback) {
        this.callback = callback;
        this.disconnectCount = 0;
        resizeObservers.push(this);
      }
      observe(container) { this.container = container; }
      disconnect() { this.disconnectCount += 1; }
    }
    class MutationObserver {
      constructor(callback) {
        this.callback = callback;
        this.disconnectCount = 0;
        mutationObservers.push(this);
      }
      observe(container) { this.container = container; }
      disconnect() { this.disconnectCount += 1; }
    }
    const monaco = {
      editor: {
        create(container, options) {
          const editor = {
            container,
            options,
            disposeCount: 0,
            layout() {},
            dispose() { this.disposeCount += 1; }
          };
          createdEditors.push(editor);
          return editor;
        }
      }
    };
    function getMonacoTheme() { return 'test-theme'; }
    ${lifecycleSource}
    ${creationSource}
    globalThis.harness = {
      createMonacoEditor,
      disposeMonacoContainer,
      loadMonaco() { resolveMonaco(monaco); },
      replaceContainer() { currentContainer = { id: 'persistent-container' }; },
      createdEditors,
      resizeObservers,
      mutationObservers,
      monacoInstances
    };
  `, context);

  const first = context.harness.createMonacoEditor('persistent-container', { value: 'first' });
  const second = context.harness.createMonacoEditor('persistent-container', { value: 'second' });
  assert.equal(context.harness.createdEditors.length, 0);

  context.harness.loadMonaco();
  const [firstEditor, secondEditor] = await Promise.all([first, second]);

  assert.equal(firstEditor, null);
  assert.equal(secondEditor.options.value, 'second');
  assert.equal(context.harness.createdEditors.length, 1);
  assert.equal(context.harness.monacoInstances.length, 1);

  const staleReplacement = context.harness.createMonacoEditor(
    'persistent-container',
    { value: 'stale replacement' }
  );
  const latestReplacement = context.harness.createMonacoEditor(
    'persistent-container',
    { value: 'latest replacement' }
  );
  const [staleEditor, latestEditor] = await Promise.all([staleReplacement, latestReplacement]);

  assert.equal(staleEditor, null);
  assert.equal(latestEditor.options.value, 'latest replacement');
  assert.equal(secondEditor.disposeCount, 1);
  assert.equal(context.harness.resizeObservers[0].disconnectCount, 1);
  assert.equal(context.harness.mutationObservers[0].disconnectCount, 1);
  assert.equal(context.harness.monacoInstances.length, 1);

  const replacedContainerCreation = context.harness.createMonacoEditor('persistent-container');
  context.harness.replaceContainer();
  assert.equal(await replacedContainerCreation, null);
  assert.equal(latestEditor.disposeCount, 1);
  assert.equal(context.harness.monacoInstances.length, 0);

  const finalEditor = await context.harness.createMonacoEditor('persistent-container');
  context.harness.disposeMonacoContainer('persistent-container');
  context.harness.disposeMonacoContainer('persistent-container');

  assert.equal(finalEditor.disposeCount, 1);
  assert.equal(context.harness.monacoInstances.length, 0);
  assert.equal(context.harness.resizeObservers.at(-1).disconnectCount, 1);
  assert.equal(context.harness.mutationObservers.at(-1).disconnectCount, 1);
});
