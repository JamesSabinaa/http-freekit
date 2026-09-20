import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import vm from 'node:vm';
import { ApiServer } from '../../src/api/api-server.js';
import { normalizeSendUrl } from '../../src/ui/send-url.js';

const source = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, startMarker);
  return source.slice(start, end);
}

function createHarness({ body = 'request café', bodyEncoding = 'utf8' } = {}) {
  const requests = [], renders = [], savedBodies = [], toasts = [];
  let releaseResponse;
  const response = new Promise(resolve => { releaseResponse = resolve; });
  const elements = {
    sendMethod: { value: 'POST' },
    sendUrl: { value: 'http://example.test/send' },
    sendHeaders: { value: '{}' },
    sendBody: { value: body },
    sendBodyFormat: { value: 'text' },
    sendResponse: { style: {} }, sendEmptyResponse: { style: {} },
    sendResDuration: {}, sendResHeaders: {}, sendViewInTraffic: { style: {} }
  };
  const tab = { id: 'tab-1', body, bodyEncoding, response: null };
  const context = vm.createContext({
    AbortController, TextEncoder, URL, normalizeSendUrl,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    document: { getElementById: id => elements[id] || null },
    API_BASE: 'http://127.0.0.1:8080',
    activeSendTab: tab.id, sendTabs: [tab], sendAbortControllers: new Map(),
    getSendBodyType: () => 'raw', getSendBodyValue: () => elements.sendBody.value,
    formatToContentType: () => 'text/plain',
    throwIfSendAborted: signal => signal.throwIfAborted(),
    assertSendManagementRequestSize() {}, setSendLoading() {},
    renderHeaders: headers => JSON.stringify(headers),
    renderSendResponseStatus() {}, renderSendTabs() {},
    setStandaloneBodyViewer: (...args) => renders.push(args),
    saveSendTabState: () => { savedBodies.push(elements.sendBody.value); },
    toast: (...args) => toasts.push(args),
    fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { json: () => response };
    }
  });
  vm.runInContext(`
    ${section('function findHeaderValues(', 'function matchesFilter(')}
    ${section('function isGrpcContentType(', 'function viewModeToMonacoLanguage(')}
    ${section('function bodyToBytes(', 'function readProtoVarint(')}
    ${section('function isCanonicalSendBase64(', 'function resendSelectedRequest(')}
    ${section('function findHeaderKey(headers, name)', 'async function sendRequest()')}
    ${section('async function sendRequest()', 'function abortSendRequest()')}
  `, context);
  return { context, elements, tab, requests, renders, savedBodies, toasts, releaseResponse };
}

for (const [label, headers, contentType, mode] of [
  ['repeated fields', { 'content-type': ['text/plain', 'text/plain'] }, 'text/plain, text/plain', 'text'],
  ['singleton array', { 'Content-Type': ['text/plain'] }, 'text/plain', 'text'],
  ['mixed-case fields', { 'Content-Type': ['application/json'], 'CONTENT-TYPE': 'application/json' }, 'application/json, application/json', 'json'],
  ['empty array', { 'content-type': [] }, '', 'text'],
  ['absent field', {}, '', 'text']
]) {
  test(`Send displays ${label} without losing an in-flight request draft`, async () => {
    const harness = createHarness();
    const pending = harness.context.sendRequest();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.requests[0].body, 'request café');
    assert.equal(harness.requests[0].bodyEncoding, 'utf8');
    harness.elements.sendBody.value = 'newer unsent draft';
    const body = mode === 'json' ? '{"message":"café"}' : 'response café';
    harness.releaseResponse({ statusCode: 200, statusMessage: 'OK', headers, body,
      bodyEncoding: 'utf8', bodySize: Buffer.byteLength(body), duration: 12 });
    await pending;

    assert.deepEqual(harness.toasts, []);
    assert.equal(harness.tab.response.statusCode, 200);
    assert.equal(harness.tab.response.contentType, contentType);
    assert.equal(harness.tab.response.mode, mode);
    assert.equal(harness.tab.response.responseHeaders, headers);
    assert.equal(harness.tab.response.body, body);
    const render = harness.renders[0];
    assert.equal(render[2], contentType);
    assert.equal(render[5].request.requestBodySize, Buffer.byteLength('request café'));
    assert.equal(harness.elements.sendBody.value, 'newer unsent draft');
    assert.deepEqual(harness.savedBodies, ['newer unsent draft']);
    assert.equal(harness.context.sendAbortControllers.size, 0);
  });
}

for (const decoded of [false, true]) {
  test(`repeated Content-Type preserves ${decoded ? 'decoded preview' : 'binary response'} provenance and request bytes`, async () => {
    const upload = Buffer.from([0x00, 0xff, 0x41]);
    const body = `data:application/octet-stream;base64,${upload.toString('base64')}`;
    const harness = createHarness({ body, bodyEncoding: 'base64' });
    const headers = { 'Content-Type': ['application/octet-stream', 'application/octet-stream'] };
    const previewBytes = Buffer.from([0xff, 0x42]);
    const previewBody = `data:application/octet-stream;base64,${previewBytes.toString('base64')}`;
    const pending = harness.context.sendRequest();
    harness.releaseResponse({ statusCode: 200, headers, body, bodyEncoding: 'base64',
      bodySize: upload.length, duration: 1,
      ...(decoded ? { previewBody, previewBodyEncoding: 'base64', previewBodyContentDecoded: true } : {}) });
    await pending;

    assert.deepEqual(harness.toasts, []);
    assert.deepEqual(Buffer.from(harness.requests[0].body, 'base64'), upload);
    assert.equal(harness.requests[0].bodyEncoding, 'base64');
    assert.equal(harness.tab.response.responseHeaders, headers);
    assert.equal(harness.tab.response.bodyEncoding, 'base64');
    assert.equal(harness.tab.response.bodyContentDecoded, decoded);
    assert.equal(harness.tab.response.body, decoded ? previewBody : body);
    const render = harness.renders[0];
    assert.equal(render[5].request.requestBodySize, upload.length);
    assert.equal(render[5].request.requestBodyEncoding, 'base64');
    assert.equal(render[5].request.responseBodyContentDecoded, decoded);
    assert.deepEqual(Buffer.from(harness.context.bodyToBytes(render[1], render[5])), decoded ? previewBytes : upload);
    assert.equal(harness.elements.sendBody.value, body);
    assert.deepEqual(harness.savedBodies, [body]);
  });
}

test('a real Send response with duplicate Content-Type fields reaches the renderer', async t => {
  const origin = http.createServer((_request, response) => {
    response.setHeader('Content-Type', ['text/plain', 'text/plain']);
    response.end('origin café');
  });
  t.after(() => new Promise(resolve => origin.close(resolve)));
  await new Promise((resolve, reject) => {
    origin.once('error', reject);
    origin.listen(0, '127.0.0.1', resolve);
  });
  const result = await ApiServer.prototype._sendRequest.call(
    {}, `http://127.0.0.1:${origin.address().port}/`, 'GET', {}, ''
  );
  assert.deepEqual(result.headers['content-type'], ['text/plain', 'text/plain']);
  const harness = createHarness();
  const pending = harness.context.sendRequest();
  harness.releaseResponse(result);
  await pending;
  assert.deepEqual(harness.toasts, []);
  assert.equal(harness.tab.response.body, 'origin café');
  assert.equal(harness.tab.response.bodyEncoding, 'utf8');
  assert.equal(harness.tab.response.responseHeaders, result.headers);
  assert.equal(harness.renders.length, 1);
});
