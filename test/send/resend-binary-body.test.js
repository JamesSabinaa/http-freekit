import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';
import { normalizeHarEntries } from '../../src/ui/har-import.js';
import { generateExportSnippet } from '../../src/ui/request-export.js';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function sourceBetween(startMarker, endMarker, fromIndex = 0) {
  const start = rendererSource.indexOf(startMarker, fromIndex);
  const end = rendererSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} source must be present`);
  return rendererSource.slice(start, end);
}

const binaryBodyHelpers = sourceBetween(
  'function isCanonicalSendBase64(',
  'function resendSelectedRequest('
);
const resendSource = sourceBetween(
  'function resendSelectedRequest(',
  '// Track collapsed state'
);
const prepareSource = sourceBetween(
  'async function prepareSendRequestPayload(',
  'async function sendRequest()'
);
const currentExportSource = sourceBetween(
  'function getCurrentSendExportRequest(',
  'function scheduleSendExportUpdate('
);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function resendRequest(request) {
  let loadedTab = null;
  const toasts = [];
  const persisted = [];
  const context = {
    __request: request,
    URLSearchParams,
    activeSendTab: 'tab-1',
    sendTabs: [],
    getSendBodyType: () => 'raw',
    trafficActionRequest: () => request,
    saveSendTabState() {},
    findHeaderKey: (headers, name) => Object.keys(headers || {})
      .find(key => key.toLowerCase() === name.toLowerCase()) || null,
    allocateSendTabId: () => 'tab-binary',
    safeLocalStorageSet() {},
    persistSendTabs(tabs) { persisted.push(...tabs); },
    document: { querySelector: () => null },
    loadSendTabState(tab) { loadedTab = tab; },
    renderSendTabs() {},
    toast(message, type) { toasts.push({ message, type }); }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${binaryBodyHelpers}
    ${resendSource}
    resendSelectedRequest(__request.id);
  `, context);
  return { tab: loadedTab, toasts, persisted };
}

async function prepareTab(tab) {
  const context = {
    __tab: tab,
    TextEncoder,
    sendTabs: [tab],
    activeSendTab: tab.id,
    document: {
      getElementById: id => id === 'sendBodyFormat' ? { value: tab.bodyFormat || 'text' } : null
    },
    getSendBodyType: () => tab.bodyType,
    getSendBodyValue: () => tab.body,
    setDefaultHeader(headers, name, value) {
      if (!Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase())) {
        headers[name] = value;
      }
    },
    findHeaderKey: (headers, name) => Object.keys(headers)
      .find(key => key.toLowerCase() === name.toLowerCase()) || null,
    formatToContentType: () => 'text/plain',
    serializeUrlEncodedFields: () => '',
    serializeMultipartFields: async () => new Uint8Array(),
    bytesToBase64: () => '',
    getMultipartDisplayBody: () => '',
    createMultipartBoundary: () => 'unused-boundary',
    sendMultipartFields: [],
    sendMultipartBoundary: ''
  };
  vm.createContext(context);
  vm.runInContext(`
    ${binaryBodyHelpers}
    ${prepareSource}
    globalThis.prepare = prepareSendRequestPayload;
  `, context);
  const headers = {};
  const payload = await context.prepare(headers);
  return { payload: plain(payload), headers: plain(headers) };
}

function currentExportRequest(tab) {
  const elements = {
    sendHeaders: { value: '{}' },
    sendBodyFormat: { value: tab.bodyFormat },
    sendUrl: { value: tab.url },
    sendMethod: { value: tab.method }
  };
  const context = {
    sendTabs: [tab],
    activeSendTab: tab.id,
    document: { getElementById: id => elements[id] || null },
    syncSendHeadersToHidden() {},
    getSendBodyType: () => tab.bodyType,
    getSendBodyValue: () => tab.body,
    serializeUrlEncodedFields: () => '',
    setDefaultHeader(headers, name, value) { if (!headers[name]) headers[name] = value; },
    formatToContentType: () => 'text/plain',
    cloneSendFormFields: fields => fields || [],
    sendMultipartFields: [],
    sendUrlEncodedFields: [],
    sendMultipartBoundary: '',
    createMultipartBoundary: () => 'boundary'
  };
  vm.createContext(context);
  vm.runInContext(`
    ${binaryBodyHelpers}
    ${currentExportSource}
    globalThis.result = getCurrentSendExportRequest();
  `, context);
  return plain(context.result);
}

function capturedRequest(bytes) {
  const proxy = new ProxyServer(null);
  const captured = {
    requestBody: proxy._safeBodyString(bytes, undefined, 'application/octet-stream')
  };
  proxy._normalizeCapturedBodies(captured);
  return {
    id: 'captured-binary',
    method: 'POST',
    url: 'http://example.test/upload',
    requestHeaders: { 'content-type': 'application/octet-stream' },
    ...captured
  };
}

function importedRequest(bytes) {
  return normalizeHarEntries({
    log: {
      entries: [{
        startedDateTime: '2026-08-15T00:00:00.000Z',
        time: 1,
        request: {
          method: 'POST',
          url: 'http://example.test/upload',
          headers: [{ name: 'Content-Type', value: 'application/octet-stream' }],
          postData: {
            mimeType: 'application/octet-stream',
            text: bytes.toString('base64'),
            encoding: 'base64'
          }
        },
        response: { status: 200, headers: [] }
      }]
    }
  }, { createId: () => 'imported-binary' })[0];
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise(resolve => server.close(resolve));
}

function postJson(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/send',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: response.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    request.once('error', reject);
    request.end(payload);
  });
}

test('captured and HAR-imported binary bodies remain byte-exact through Resend preparation', async () => {
  const bytes = Buffer.from([0x00, 0xff, 0x41]);
  for (const request of [capturedRequest(bytes), importedRequest(bytes)]) {
    const { tab, toasts, persisted } = resendRequest(request);
    assert.ok(tab, request.id);
    assert.equal(tab.body, `data:application/octet-stream;base64,${bytes.toString('base64')}`);
    assert.equal(tab.bodyEncoding, 'base64');
    assert.equal(tab.bodyType, 'raw');
    assert.deepEqual(toasts, [{ message: 'Request loaded in new Send tab', type: 'success' }]);
    assert.equal(persisted[0].bodyEncoding, 'base64');

    const { payload, headers } = await prepareTab(tab);
    assert.deepEqual(payload, {
      body: bytes.toString('base64'),
      bodyEncoding: 'base64',
      displayBody: tab.body,
      byteLength: bytes.length
    });
    assert.equal(headers['Content-Type'], 'application/octet-stream');

    const exported = currentExportRequest(tab);
    assert.equal(exported.requestBodyEncoding, 'base64');
    const snippet = generateExportSnippet(exported, 'javascript-node');
    assert.match(snippet, /Buffer\.from\("AP9B", 'base64'\)/);
    assert.equal(snippet.includes(tab.body), false);
  }
});

test('malformed and truncated binary captures fail closed before creating a Send tab', async () => {
  for (const request of [
    {
      ...capturedRequest(Buffer.from([0x00, 0xff, 0x41])),
      id: 'malformed',
      requestBody: 'data:application/octet-stream;base64,AAA'
    },
    {
      ...capturedRequest(Buffer.from([0x00, 0xff, 0x41])),
      id: 'truncated',
      requestBodyTruncated: true,
      requestBodyCapturedSize: 3,
      requestBodyDecodedSize: 9
    }
  ]) {
    const result = resendRequest(request);
    assert.equal(result.tab, null);
    assert.equal(result.persisted.length, 0);
    assert.equal(result.toasts[0].type, 'error');
    assert.match(result.toasts[0].message, /malformed|incomplete/i);
  }

  const malformedTab = {
    id: 'tab-malformed',
    body: 'data:application/octet-stream;base64,A===',
    bodyEncoding: 'base64',
    bodyType: 'raw',
    bodyFormat: 'text'
  };
  await assert.rejects(
    prepareTab(malformedTab),
    /not a complete, canonical base64 data URI/
  );
  await assert.rejects(
    prepareTab({ ...malformedTab, body: 'data:application/octet-stream;base64,AB==' }),
    /not a complete, canonical base64 data URI/
  );
});

test('ordinary UTF-8 and empty Resend bodies retain text semantics', async () => {
  for (const body of ['plain text ✓', '', 'data:text/plain;base64,SGVsbG8=']) {
    const request = {
      id: `text-${body.length}`,
      method: 'POST',
      url: 'http://example.test/text',
      requestHeaders: { 'content-type': 'text/plain' },
      requestBody: body,
      requestBodyEncoding: 'utf8'
    };
    const { tab } = resendRequest(request);
    assert.equal(tab.bodyEncoding, 'utf8');
    const { payload } = await prepareTab(tab);
    assert.equal(payload.body, body);
    assert.equal(payload.bodyEncoding, 'utf8');
    assert.equal(payload.byteLength, Buffer.byteLength(body));
  }
});

test('Resend preserves exact custom methods and rejects malformed methods atomically', () => {
  const customMethod = "MiXeD!#$%&'*+-.^_`|~09AZ";
  const custom = resendRequest({
    id: 'custom-method',
    method: customMethod,
    url: 'http://example.test/custom',
    requestHeaders: {},
    requestBody: ''
  });
  assert.equal(custom.tab.method, customMethod);
  assert.equal(custom.persisted[0].method, customMethod);

  const omitted = resendRequest({
    id: 'legacy-omitted-method',
    url: 'http://example.test/legacy',
    requestHeaders: {},
    requestBody: ''
  });
  assert.equal(omitted.tab.method, 'GET');

  for (const method of ['', null, '<img src=x>', 'GET /smuggled']) {
    const invalid = resendRequest({
      id: `invalid-${String(method)}`,
      method,
      url: 'http://example.test/rejected',
      requestHeaders: {},
      requestBody: ''
    });
    assert.equal(invalid.tab, null);
    assert.equal(invalid.persisted.length, 0);
    assert.equal(invalid.toasts.length, 1);
    assert.equal(invalid.toasts[0].type, 'error');
    assert.match(invalid.toasts[0].message, /method.*valid HTTP token/i);
  }
});

test('Send API decodes canonical base64 and rejects malformed encodings before outbound I/O', async t => {
  const receivedBodies = [];
  const origin = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      receivedBodies.push(Buffer.concat(chunks));
      response.end('ok');
    });
  });
  const originPort = await listen(origin);

  let api;
  const proxy = new ProxyServer(null, {
    port: 0,
    onRequest: data => api.onTrafficEvent(data)
  });
  api = new ApiServer(proxy, null, null, { port: 0 });
  api.port = 0;
  await proxy.start();
  await api.start();
  t.after(async () => {
    await api.stop();
    await proxy.stop();
    await close(origin);
  });

  const bytes = Buffer.from([0x00, 0xff, 0x41]);
  const binaryResponse = await postJson(api.httpServer.address().port, {
    url: `http://127.0.0.1:${originPort}/binary`,
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes.toString('base64'),
    bodyEncoding: 'base64'
  });
  assert.equal(binaryResponse.statusCode, 200);
  assert.deepEqual(receivedBodies, [bytes]);

  const text = 'ordinary text ✓';
  const textResponse = await postJson(api.httpServer.address().port, {
    url: `http://127.0.0.1:${originPort}/text`,
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: text,
    bodyEncoding: 'utf8'
  });
  assert.equal(textResponse.statusCode, 200);
  assert.deepEqual(receivedBodies, [bytes, Buffer.from(text)]);

  for (const invalid of [
    { body: 'AAA', bodyEncoding: 'base64' },
    { body: 'A===', bodyEncoding: 'base64' },
    { body: 'AB==', bodyEncoding: 'base64' },
    { body: 'AAF=', bodyEncoding: 'base64' },
    { body: 'AP%2FB', bodyEncoding: 'base64' },
    { body: 'text', bodyEncoding: 'unknown' },
    { body: { nested: true }, bodyEncoding: 'utf8' },
    { body: null, bodyEncoding: 'base64' }
  ]) {
    const response = await postJson(api.httpServer.address().port, {
      url: `http://127.0.0.1:${originPort}/must-not-run`,
      method: 'POST',
      headers: {},
      ...invalid
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /body|base64/i);
  }
  assert.equal(receivedBodies.length, 2);
});
