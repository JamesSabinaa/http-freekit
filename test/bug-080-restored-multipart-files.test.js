import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const presentationStart = source.indexOf('function getSendMultipartFilePresentation');
const presentationEnd = source.indexOf('function addSendFormField', presentationStart);
assert.notEqual(presentationStart, -1);
assert.notEqual(presentationEnd, -1);

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function createRenderer(fields) {
  const container = { innerHTML: '' };
  const context = {
    document: {
      getElementById(id) {
        return id === 'sendFormBodyRows' ? container : null;
      }
    },
    esc: escapeHtml,
    getSendBodyType: () => 'multipart',
    getActiveSendFormFields: () => fields
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(presentationStart, presentationEnd)}
    globalThis.presentation = getSendMultipartFilePresentation;
    globalThis.render = renderSendFormFields;`, context);
  return { container, presentation: context.presentation, render: context.render };
}

test('restored multipart metadata is presented as unavailable', () => {
  const renderer = createRenderer([]);
  const state = renderer.presentation({ type: 'file', fileName: 'payload.bin' });

  assert.deepEqual(JSON.parse(JSON.stringify(state)), {
    buttonLabel: 'Choose file again',
    displayName: 'Unavailable after reload: payload.bin',
    title: 'The browser did not retain "payload.bin". Choose it again before sending.',
    missing: true
  });
});

test('a live selected file remains authoritative over remembered metadata', () => {
  const renderer = createRenderer([]);
  const state = renderer.presentation({
    type: 'file',
    fileName: 'stale.bin',
    file: { name: 'selected.bin', type: 'application/octet-stream' }
  });

  assert.deepEqual(JSON.parse(JSON.stringify(state)), {
    buttonLabel: 'Replace file',
    displayName: 'selected.bin',
    title: 'selected.bin',
    missing: false
  });
});

test('a new empty file row keeps the ordinary unselected state', () => {
  const renderer = createRenderer([]);
  const state = renderer.presentation({ type: 'file' });

  assert.deepEqual(JSON.parse(JSON.stringify(state)), {
    buttonLabel: 'Choose file',
    displayName: 'No file selected',
    title: 'No file selected',
    missing: false
  });
});

test('restored multipart rows render an explicit warning and reselection control', () => {
  const renderer = createRenderer([{
    key: 'upload',
    type: 'file',
    fileName: '<payload>.bin',
    enabled: true
  }]);

  renderer.render();

  assert.match(renderer.container.innerHTML, />Choose file again<input type="file"/);
  assert.match(renderer.container.innerHTML, /send-file-name send-file-name-missing/);
  assert.match(renderer.container.innerHTML, /Unavailable after reload: &lt;payload&gt;\.bin/);
  assert.doesNotMatch(renderer.container.innerHTML, /Unavailable after reload: <payload>\.bin/);
});
