import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'styles.css'), 'utf8');
const presentationStart = source.indexOf('function getSendMultipartFilePresentation');
const presentationEnd = source.indexOf('function addSendFormField', presentationStart);
assert.notEqual(presentationStart, -1);
assert.notEqual(presentationEnd, -1);

function escapeText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeAttribute(value) {
  return escapeText(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function createRenderer(fields) {
  const container = { innerHTML: '' };
  const context = {
    document: {
      getElementById(id) {
        return id === 'sendFormBodyRows' ? container : null;
      }
    },
    esc: escapeText,
    escapeHtmlAttribute: escapeAttribute,
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
    fileName: '<payload>" onmouseover="alert(1).bin',
    enabled: true
  }]);

  renderer.render();

  assert.match(renderer.container.innerHTML, />Choose file again<input class="send-file-input" type="file"/);
  assert.doesNotMatch(renderer.container.innerHTML, /<input[^>]*\shidden(?:\s|>|=)/);
  assert.match(renderer.container.innerHTML, /send-file-name send-file-name-missing/);
  assert.match(renderer.container.innerHTML, /title="The browser did not retain &quot;&lt;payload&gt;&quot; onmouseover=&quot;alert\(1\)\.bin&quot;\./);
  assert.doesNotMatch(renderer.container.innerHTML, /title="[^"]*" onmouseover=/);
  assert.match(renderer.container.innerHTML, />Unavailable after reload: &lt;payload&gt;" onmouseover="alert\(1\)\.bin</);
  assert.doesNotMatch(renderer.container.innerHTML, />Unavailable after reload: <payload>/);
});

test('the file input remains keyboard focusable with a visible focus indicator', () => {
  assert.match(styles, /\.send-file-input\s*\{[^}]*opacity:\s*0;/s);
  assert.doesNotMatch(styles, /\.send-file-input\s*\{[^}]*(?:display:\s*none|visibility:\s*hidden)/s);
  assert.match(styles, /\.send-file-picker-label:focus-within\s*\{[^}]*outline:/s);
});
