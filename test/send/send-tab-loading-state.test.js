import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must be present`);
  return source.slice(start, end);
}

const loadSource = section('function loadSendTabState(', 'function inferCurlSendBodyFormat(');
const loadingSource = section('function setSendLoading(', 'function findHeaderKey(');

test('switching Send tabs restores that tab own loading and Abort state', () => {
  const elements = {
    sendMethod: { value: '' },
    sendUrl: { value: '' },
    sendBodyFormat: { value: '' },
    sendBodyType: { value: '' },
    sendResponse: { style: {} },
    sendEmptyResponse: { style: {} },
    sendResBodyMode: { style: {} },
    sendViewInTraffic: { style: {} },
    sendBtn: { disabled: false, style: {} },
    sendBtnArrow: { style: {} },
    sendBtnSpinner: { style: {} },
    sendAbortBtn: { style: {} }
  };
  const context = {
    document: { getElementById: id => elements[id] || null },
    normalizeSendTab: tab => tab,
    renderSendHeaders() {},
    cloneSendFormFields: fields => [...fields],
    setSendBodyValue() {},
    updateSendBodyLanguage() {},
    updateSendBodyType() {},
    updateSendMethodColor() {},
    disposeBodyEditor() {}
  };
  vm.createContext(context);
  vm.runInContext(`
    let activeSendTab = 'tab-1';
    let sendHeadersList = [];
    let sendUrlEncodedFields = [];
    let sendMultipartFields = [];
    let sendMultipartBoundary = '';
    const standaloneBodyViewers = Object.create(null);
    const sendAbortControllers = new Map([['tab-1', { signal: { aborted: false } }]]);
    ${loadingSource}
    ${loadSource}
    globalThis.loadingApi = {
      load: loadSendTabState,
      setActive(id) { activeSendTab = id; },
      markLoading(id) { sendAbortControllers.set(id, { signal: { aborted: false } }); }
    };
  `, context);

  const tab = id => ({
    id,
    method: 'GET',
    url: '',
    headers: [],
    body: '',
    bodyType: 'raw',
    bodyFormat: 'text',
    urlEncodedFields: [],
    multipartFields: [],
    multipartBoundary: '',
    response: null
  });

  context.loadingApi.load(tab('tab-1'));
  assert.equal(elements.sendBtn.disabled, true);
  assert.equal(elements.sendAbortBtn.style.display, 'inline-flex');

  context.loadingApi.setActive('tab-2');
  context.loadingApi.load(tab('tab-2'));
  assert.equal(elements.sendBtn.disabled, false);
  assert.equal(elements.sendAbortBtn.style.display, 'none');

  context.loadingApi.markLoading('tab-2');
  context.loadingApi.load(tab('tab-2'));
  assert.equal(elements.sendBtn.disabled, true);
  assert.equal(elements.sendAbortBtn.style.display, 'inline-flex');
});
