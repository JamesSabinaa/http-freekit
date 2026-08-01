import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const sendStart = source.indexOf('async function sendRequest()');
const sendEnd = source.indexOf('function abortSendRequest()', sendStart);
assert.ok(sendStart >= 0 && sendEnd > sendStart, 'sendRequest must be present');
const sendSource = source.slice(sendStart, sendEnd);

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createHarness() {
  const response = deferred();
  const state = {
    loading: [],
    renderedStatuses: [],
    bodyRenders: [],
    savedTabs: [],
    tabRenders: 0
  };
  const elements = {
    sendMethod: { value: 'GET' },
    sendUrl: { value: 'https://a.example.test/slow?one=1' },
    sendHeaders: { value: '{}' },
    sendResponse: { style: { display: 'none' } },
    sendEmptyResponse: { style: { display: 'flex' } },
    sendResDuration: { textContent: '-' },
    sendResHeaders: { innerHTML: '' },
    sendViewInTraffic: { style: { display: 'none' }, onclick: null }
  };
  const context = {
    AbortController,
    API_BASE: 'http://127.0.0.1:8080',
    URL,
    document: {
      getElementById: id => elements[id] || null,
      querySelector: () => null
    },
    prepareSendRequestPayload: async () => ({
      body: '',
      bodyEncoding: 'utf8',
      displayBody: '',
      byteLength: 0
    }),
    fetch: async () => response.promise,
    setSendLoading: value => state.loading.push(value),
    toast: error => assert.fail(`unexpected toast: ${error}`),
    renderHeaders: headers => JSON.stringify(headers),
    getBodyViewModes: () => [{ value: 'text' }],
    renderSendResponseStatus: (...status) => state.renderedStatuses.push(status),
    setStandaloneBodyViewer: (...args) => state.bodyRenders.push(args),
    renderSendTabs: () => { state.tabRenders++; },
    saveSendTabState: () => state.savedTabs.push(context.sendApi.active()),
    switchPanel() {},
    selectRequest() {}
  };
  vm.createContext(context);
  vm.runInContext(`
    let currentSendAbort = null;
    let activeSendTab = 'tab-1';
    let sendTabs = [
      { id: 'tab-1', response: null },
      { id: 'tab-2', response: null }
    ];
    ${sendSource}
    globalThis.sendApi = {
      send: sendRequest,
      active: () => activeSendTab,
      setActive: id => { activeSendTab = id; },
      close: id => { sendTabs = sendTabs.filter(tab => tab.id !== id); },
      tabs: () => sendTabs
    };
  `, context);

  return { api: context.sendApi, elements, response, state };
}

function successfulResponse() {
  return {
    json: async () => ({
      statusCode: 200,
      statusMessage: 'OK',
      headers: { 'content-type': 'text/plain' },
      body: 'response from A',
      bodyEncoding: 'utf8',
      bodySize: 15,
      duration: 125,
      trafficId: 'traffic-a'
    })
  };
}

test('slow Send response stays with its initiating background tab', async () => {
  const harness = createHarness();
  const request = harness.api.send();
  harness.api.setActive('tab-2');
  harness.response.resolve(successfulResponse());
  await request;

  const [tabA, tabB] = harness.api.tabs();
  assert.equal(tabA.response.trafficId, 'traffic-a');
  assert.equal(tabA.response.body, 'response from A');
  assert.equal(tabB.response, null);
  assert.equal(harness.elements.sendResponse.style.display, 'none');
  assert.equal(harness.elements.sendEmptyResponse.style.display, 'flex');
  assert.deepEqual(harness.state.renderedStatuses, []);
  assert.deepEqual(harness.state.bodyRenders, []);
  assert.deepEqual(harness.state.savedTabs, []);
  assert.deepEqual(harness.state.loading, [true, false]);
});

test('slow Send response is discarded when its initiating tab was closed', async () => {
  const harness = createHarness();
  const request = harness.api.send();
  harness.api.close('tab-1');
  harness.api.setActive('tab-2');
  harness.response.resolve(successfulResponse());
  await request;

  assert.deepEqual(Array.from(harness.api.tabs(), tab => tab.id), ['tab-2']);
  assert.equal(harness.api.tabs()[0].response, null);
  assert.equal(harness.state.tabRenders, 0);
  assert.deepEqual(harness.state.renderedStatuses, []);
  assert.deepEqual(harness.state.loading, [true, false]);
});

test('Send response still renders and saves when its initiating tab is active', async () => {
  const harness = createHarness();
  const request = harness.api.send();
  harness.response.resolve(successfulResponse());
  await request;

  assert.equal(harness.api.tabs()[0].response.trafficId, 'traffic-a');
  assert.equal(harness.elements.sendResponse.style.display, 'block');
  assert.equal(harness.elements.sendEmptyResponse.style.display, 'none');
  assert.deepEqual(harness.state.renderedStatuses, [[200, 'OK']]);
  assert.equal(harness.state.bodyRenders.length, 1);
  assert.deepEqual(harness.state.savedTabs, ['tab-1']);
  assert.deepEqual(harness.state.loading, [true, false]);
});
