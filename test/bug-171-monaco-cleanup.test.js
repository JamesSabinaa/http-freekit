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

  assert.match(bodyDisposal, /disposeMonacoEditor\(existing\)/);
  assert.doesNotMatch(bodyDisposal, /existing\.dispose/);
  assert.match(sendInitialization, /disposeMonacoEditor\(sendBodyEditor\)/);
  assert.doesNotMatch(sendInitialization, /sendBodyEditor\.dispose/);
  assert.match(creation, /instance\.mutationObserver = mutationObserver/);
  assert.match(creation, /disposeMonacoEditor\(editor\)/);
});
