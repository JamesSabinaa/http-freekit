import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { normalizeHarEntries } from '../../src/ui/har-import.js';
import { prepareHarFormReplay } from '../../src/ui/request-export.js';
import { parseCurlCommand } from '../../src/ui/curl-parser.js';

const source = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, startMarker);
  return source.slice(start, end);
}

function harness() {
  let textareaValue = '';
  const fallback = {
    dataset: {}, style: {},
    get value() { return textareaValue; },
    set value(value) { textareaValue = String(value).replace(/\r\n?/g, '\n'); }
  };
  const elements = {
    'sendBody-fallback': fallback,
    'sendBody-monaco-container': { innerHTML: '', style: {} },
    sendMethod: { value: 'POST' }, sendUrl: { value: 'http://example.test/replay' },
    sendBodyFormat: { value: 'text' }
  };
  const tab = { id: 'tab-1', body: '', bodyEncoding: 'utf8', bodyType: 'raw' };
  const editors = [];
  const context = vm.createContext({
    TextEncoder, console,
    sendTabs: [tab], activeSendTab: tab.id,
    sendBodyEditor: null, sendBodyProgrammaticUpdateDepth: 0, sendBodySnapshot: null,
    sendHeadersList: [], sendUrlEncodedFields: [], sendMultipartFields: [], sendMultipartBoundary: '',
    document: { getElementById: id => elements[id] || null },
    normalizeSendMethod: value => value,
    cloneSendFormFields: value => value.slice(),
    getSendBodyType: () => 'raw',
    getActiveSendBodyEncoding: () => tab.bodyEncoding,
    scheduleSendExportUpdate() {}, toast() {},
    sendFormatToMonacoLanguage: () => 'plaintext',
    monacoApi: { KeyMod: { CtrlCmd: 1 }, KeyCode: { Enter: 2, Escape: 3 } },
    isMonacoEditorCurrent: () => true,
    disposeMonacoEditor() { context.sendBodyEditor = null; },
    createMonacoEditor: async (_id, options) => {
      let value = '';
      let listener = () => {};
      const editor = {
        getValue: () => value,
        setValue(next) { value = next.replace(/\r\n|\r|\n/g, '\r\n'); listener(); },
        onDidChangeModelContent(callback) { listener = callback; },
        addCommand() {}, layout() {}
      };
      editor.setValue(options.value);
      editors.push(editor);
      return editor;
    },
    setDefaultHeader(headers, key, value) { headers[key] ??= value; },
    formatToContentType: () => 'text/plain'
  });
  vm.runInContext(`
    ${between('function isCanonicalSendBase64(', 'function resendSelectedRequest(')}
    ${between('function getSendBodyValue()', 'function updateSendBodyLanguage()')}
    ${between('function snapshotActiveSendTabState(', 'function captureActiveSendTabState(')}
    ${between('async function prepareSendRequestPayload(', 'async function sendRequest()')}
  `, context);
  return { context, fallback, editors, tab };
}

for (const monaco of [false, true]) {
  for (const body of ['alpha\nbeta\n', 'alpha\r\nbeta\r\n', 'alpha\r\nbeta\ngamma\rdelta café', 'alpha\rbeta\r']) {
    test(`${monaco ? 'Monaco' : 'textarea'} preserves unedited ${JSON.stringify(body)} for payload and persistence`, async () => {
      const ui = harness();
      if (monaco) await ui.context.initSendBodyEditor('', 'text');
      ui.context.setSendBodyValue(body);
      assert.equal(ui.context.getSendBodyValue(), body);
      const payload = await ui.context.prepareSendRequestPayload({});
      assert.equal(payload.body, body);
      assert.equal(payload.byteLength, Buffer.byteLength(body));
      assert.equal(ui.context.snapshotActiveSendTabState().body, body);
      if (monaco) {
        await ui.context.initSendBodyEditor(body, 'text');
        assert.equal(ui.context.getSendBodyValue(), body, 'reinitialization preserves exact source');
      }
    });
  }

  test(`${monaco ? 'Monaco' : 'textarea'} accepts actual edits including an empty body and later loads`, async () => {
    const ui = harness();
    if (monaco) await ui.context.initSendBodyEditor('', 'text');
    ui.context.setSendBodyValue('original\r\nbody\n');
    for (const value of ['edited\nbody', '']) {
      if (monaco) ui.editors.at(-1).setValue(value);
      else { ui.fallback.value = value; ui.context.handleSendBodyUserInput(); }
      const expected = monaco ? value.replace(/\n/g, '\r\n') : value;
      assert.equal(ui.context.getSendBodyValue(), expected);
      assert.equal((await ui.context.prepareSendRequestPayload({})).body, expected);
      assert.equal(ui.context.snapshotActiveSendTabState().body, expected);
      if (monaco) {
        await ui.context.initSendBodyEditor('', 'text');
        assert.equal(ui.context.getSendBodyValue(), expected, 'reinitialization retains genuine edits too');
      }
    }
    ui.context.setSendBodyValue('new\r\nsource\rtext\n');
    assert.equal(ui.context.getSendBodyValue(), 'new\r\nsource\rtext\n');
  });

  test(`${monaco ? 'Monaco' : 'textarea'} keeps binary provenance until actual editing`, async () => {
    const ui = harness();
    if (monaco) await ui.context.initSendBodyEditor('', 'text');
    ui.tab.bodyEncoding = 'base64';
    const bytes = Buffer.from('binary\r\nbody\n');
    ui.context.setSendBodyValue('data:application/octet-stream;base64,' + bytes.toString('base64'));
    const payload = await ui.context.prepareSendRequestPayload({});
    assert.equal(payload.bodyEncoding, 'base64');
    assert.equal(payload.body, bytes.toString('base64'));
    assert.equal(payload.byteLength, bytes.length);
    if (monaco) ui.editors.at(-1).setValue('edited');
    else { ui.fallback.value = 'edited'; ui.context.handleSendBodyUserInput(); }
    assert.equal(ui.tab.bodyEncoding, 'utf8');
    assert.equal((await ui.context.prepareSendRequestPayload({})).body, 'edited');
  });
}

test('delayed Monaco creation preserves a newly loaded tab or a live textarea edit', async () => {
  for (const edit of [false, true]) {
    const ui = harness();
    let completeEditor;
    const create = ui.context.createMonacoEditor;
    ui.context.createMonacoEditor = async (...args) => {
      const editor = await create(...args);
      return new Promise(resolve => { completeEditor = () => resolve(editor); });
    };
    ui.context.setSendBodyValue('first\r\nbody\n');
    const initialization = ui.context.initSendBodyEditor('', 'text');
    await new Promise(resolve => setImmediate(resolve));
    ui.context.setSendBodyValue('second\r\nbody\r');
    if (edit) {
      ui.fallback.value = 'user\nedited';
      ui.context.handleSendBodyUserInput();
    }
    completeEditor();
    await initialization;
    const expected = edit ? 'user\nedited' : 'second\r\nbody\r';
    assert.equal(ui.context.getSendBodyValue(), expected);
    assert.equal((await ui.context.prepareSendRequestPayload({})).body, expected);
  }
});

test('failed Monaco initialization retains exact fallback source and subsequent edits', async () => {
  const ui = harness();
  ui.context.createMonacoEditor = async () => null;
  assert.equal(await ui.context.initSendBodyEditor('initial\r\nbody\n', 'text'), null);
  assert.equal(ui.context.getSendBodyValue(), 'initial\r\nbody\n');
  ui.fallback.value = 'external replacement';
  assert.equal(ui.context.getSendBodyValue(), 'external replacement');
});

test('HAR multipart and pasted cURL retain replay bytes through both editors', async () => {
  const imported = normalizeHarEntries({ log: { entries: [{
    startedDateTime: '2026-09-20T00:00:00.000Z', time: 0,
    request: {
      method: 'POST', url: 'http://example.test/form', headers: [],
      postData: { mimeType: 'multipart/form-data', params: [{ name: 'field', value: 'value café' }] }
    },
    response: { status: 200, headers: [], content: { text: '' } }
  }] } })[0];
  const reconstructed = prepareHarFormReplay(imported).request;
  const curlBody = parseCurlCommand("curl -X POST http://example.test/form --data-raw 'alpha\r\nbeta\ngamma\rdelta'").body;
  assert.equal(curlBody, 'alpha\r\nbeta\ngamma\rdelta');
  for (const monaco of [false, true]) {
    const ui = harness();
    if (monaco) await ui.context.initSendBodyEditor('', 'text');
    for (const body of [reconstructed.requestBody, curlBody]) {
      ui.context.setSendBodyValue(body);
      const payload = await ui.context.prepareSendRequestPayload({ ...reconstructed.requestHeaders });
      assert.equal(payload.body, body);
      assert.equal(payload.byteLength, Buffer.byteLength(body));
      assert.equal(ui.context.snapshotActiveSendTabState().body, body);
      if (body === reconstructed.requestBody) {
        const form = await new Response(payload.body, { headers: reconstructed.requestHeaders }).formData();
        assert.equal(form.get('field'), 'value café');
      }
    }
  }
});
