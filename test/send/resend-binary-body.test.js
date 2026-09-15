import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import zlib from 'node:zlib';

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
const bodyEditingSource = sourceBetween(
  'function getSendBodyValue()',
  'function handleSendBodyFallbackKeydown('
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

async function prepareTab(tab, initialHeaders = {}) {
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
    serializeUrlEncodedFields: () => {
      const params = new URLSearchParams();
      for (const field of tab.urlEncodedFields || []) {
        if (field.enabled !== false && field.key) params.append(field.key, field.value || '');
      }
      return params.toString();
    },
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
  const headers = { ...initialHeaders };
  const payload = await context.prepare(headers);
  return { payload: plain(payload), headers: plain(headers) };
}

function headerRowsToObject(rows) {
  return Object.fromEntries(
    (rows || []).filter(row => row.enabled !== false && row.key)
      .map(row => [row.key, row.value])
  );
}

function capturedContentEncodedRequest({ id, method = 'POST', wireBytes, contentEncoding, contentType }) {
  const proxy = new ProxyServer(null);
  const captured = {
    requestBody: proxy._safeBodyString(wireBytes, contentEncoding, contentType)
  };
  proxy._normalizeCapturedBodies(captured);
  return {
    id,
    method,
    url: 'http://example.test/replaced-by-test',
    requestHeaders: {
      'Content-Type': contentType,
      'Content-Encoding': contentEncoding,
      'Content-Length': String(wireBytes.length),
      'X-Retained': id
    },
    ...captured
  };
}

function currentExportRequest(tab) {
  const elements = {
    sendHeaders: { value: JSON.stringify(headerRowsToObject(tab.headers)) },
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
    sendUrlEncodedFields: tab.urlEncodedFields || [],
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

test('programmatic binary body loads stay base64 while a genuine edit transitions to UTF-8', async () => {
  const tab = {
    id: 'tab-binary-edit',
    body: 'data:application/octet-stream;base64,AP9B',
    bodyEncoding: 'base64',
    bodyType: 'raw',
    bodyFormat: 'text'
  };
  const fallback = { value: '', dataset: {} };
  const toasts = [];
  const context = {
    __tab: tab,
    __fallback: fallback,
    document: { getElementById: id => id === 'sendBody-fallback' ? fallback : null }
  };
  vm.createContext(context);
  vm.runInContext(`
    let sendTabs = [globalThis.__tab];
    let activeSendTab = globalThis.__tab.id;
    let sendBodyProgrammaticUpdateDepth = 0;
    let sendBodyEditor = {
      setValue(value) {
        globalThis.__fallback.value = value;
        handleSendBodyUserInput();
      },
      getValue() { return globalThis.__fallback.value; }
    };
    function getSendBodyType() { return 'raw'; }
    function scheduleSendExportUpdate() {}
    function toast(message, type) { globalThis.__toasts.push({ message, type }); }
    ${bodyEditingSource}
    globalThis.__toasts = [];
    globalThis.bodyEditApi = {
      programmatic: setSendBodyValue,
      edit(value) {
        globalThis.__fallback.value = value;
        handleSendBodyUserInput();
      }
    };
  `, Object.assign(context, { __toasts: toasts }));

  context.bodyEditApi.programmatic(tab.body);
  assert.equal(tab.bodyEncoding, 'base64');
  assert.equal(context.__toasts.length, 0);

  context.bodyEditApi.edit('deliberately edited text \u2713');
  assert.equal(tab.bodyEncoding, 'utf8');
  assert.deepEqual(JSON.parse(JSON.stringify(context.__toasts)), [{
    message: 'Binary request body was edited and will now be sent as UTF-8 text.',
    type: 'success'
  }]);

  context.bodyEditApi.edit('second edit');
  assert.equal(context.__toasts.length, 1);
  tab.body = fallback.value;
  const { payload } = await prepareTab(tab);
  assert.equal(payload.body, 'second edit');
  assert.equal(payload.bodyEncoding, 'utf8');
  assert.equal(payload.byteLength, Buffer.byteLength('second edit'));
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

test('Resend sends decoded semantic bytes without stale encoding headers and preserves raw fallbacks', async t => {
  const received = [];
  const origin = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        method: request.method,
        headers: request.headers,
        body: Buffer.concat(chunks)
      });
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

  const decodedCases = [
    {
      id: 'decoded-text',
      method: 'PROPFIND',
      decodedBytes: Buffer.from('decoded request text'),
      contentType: 'text/plain'
    },
    {
      id: 'decoded-binary',
      method: 'POST',
      decodedBytes: Buffer.from([0x00, 0xff, 0x41]),
      contentType: 'application/octet-stream'
    },
    {
      id: 'decoded-urlencoded',
      method: 'POST',
      decodedBytes: Buffer.from('sig=%2f&space=%20&tilde=~&literal=%41'),
      contentType: 'application/x-www-form-urlencoded'
    }
  ];

  for (const item of decodedCases) {
    const wireBytes = zlib.gzipSync(item.decodedBytes);
    const capture = capturedContentEncodedRequest({
      ...item,
      wireBytes,
      contentEncoding: 'gzip'
    });
    capture.url = `http://127.0.0.1:${originPort}/${item.id}`;
    assert.equal(capture.requestBodyContentDecoded, true);

    const resent = resendRequest(capture);
    assert.equal(resent.tab.method, item.method);
    assert.equal(resent.tab.headers.some(row => /content-(?:encoding|length)/i.test(row.key)), false);
    assert.equal(resent.tab.headers.some(row => row.key === 'X-Retained'), true);
    assert.deepEqual(resent.toasts, [{
      message: 'Request loaded for semantic replay with decoded body bytes. Content-Encoding and Content-Length were omitted.',
      type: 'warning'
    }]);

    const prepared = await prepareTab(resent.tab, headerRowsToObject(resent.tab.headers));
    const response = await postJson(api.httpServer.address().port, {
      url: resent.tab.url,
      method: resent.tab.method,
      headers: prepared.headers,
      body: prepared.payload.body,
      bodyEncoding: prepared.payload.bodyEncoding
    });
    assert.equal(response.statusCode, 200, item.id);
    const receivedRequest = received.at(-1);
    assert.equal(receivedRequest.method, item.method);
    assert.deepEqual(receivedRequest.body, item.decodedBytes);
    assert.equal(receivedRequest.headers['content-encoding'], undefined);
    assert.equal(receivedRequest.headers['content-length'], String(item.decodedBytes.length));
    assert.equal(receivedRequest.headers['x-retained'], item.id);
    if (item.id === 'decoded-urlencoded') {
      assert.equal(resent.tab.bodyType, 'raw');
      assert.equal(resent.tab.body, item.decodedBytes.toString('utf8'));
      const snippet = generateExportSnippet(currentExportRequest(resent.tab), 'curl');
      assert.match(snippet, /sig=%2f&space=%20&tilde=~&literal=%41/);
      assert.doesNotMatch(snippet, /sig=%2F&space=\+&tilde=%7E&literal=A/);
    }
  }

  const rawFallbacks = [
    {
      id: 'malformed-gzip',
      contentEncoding: 'gzip',
      wireBytes: Buffer.from([0x00, 0xff, 0x41])
    },
    {
      id: 'unknown-coding',
      contentEncoding: 'made-up-coding',
      wireBytes: zlib.gzipSync(Buffer.from('raw compressed bytes'))
    }
  ];
  for (const item of rawFallbacks) {
    const capture = capturedContentEncodedRequest({
      ...item,
      wireBytes: item.wireBytes,
      contentType: 'application/octet-stream'
    });
    capture.url = `http://127.0.0.1:${originPort}/${item.id}`;
    assert.equal(capture.requestBodyEncoding, 'base64');
    assert.equal(Object.hasOwn(capture, 'requestBodyContentDecoded'), false);

    const resent = resendRequest(capture);
    assert.equal(
      resent.tab.headers.find(row => row.key.toLowerCase() === 'content-encoding')?.value,
      item.contentEncoding
    );
    assert.equal(resent.tab.headers.some(row => row.key.toLowerCase() === 'content-length'), false);
    assert.deepEqual(resent.toasts, [{
      message: 'Request loaded in new Send tab',
      type: 'success'
    }]);

    const prepared = await prepareTab(resent.tab, headerRowsToObject(resent.tab.headers));
    const response = await postJson(api.httpServer.address().port, {
      url: resent.tab.url,
      method: resent.tab.method,
      headers: prepared.headers,
      body: prepared.payload.body,
      bodyEncoding: prepared.payload.bodyEncoding
    });
    assert.equal(response.statusCode, 200, item.id);
    const receivedRequest = received.at(-1);
    assert.deepEqual(receivedRequest.body, item.wireBytes);
    assert.equal(receivedRequest.headers['content-encoding'], item.contentEncoding);
    assert.equal(receivedRequest.headers['content-length'], String(item.wireBytes.length));
    assert.equal(receivedRequest.headers['x-retained'], item.id);
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

test('Resend preserves empty-name URL-encoded fields through raw Send and export', async t => {
  const received = [];
  const origin = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ body: Buffer.concat(chunks), type: request.headers['content-type'] });
    response.end('ok');
  });
  const port = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  const api = new ApiServer(proxy, null, null, { port: 0 });
  api.port = 0;
  await proxy.start();
  await api.start();
  t.after(async () => { await api.stop(); await proxy.stop(); await close(origin); });
  for (const body of ['=alpha&name=beta', 'name=beta&=one&=two', '=', '=a%20b&name=%2f', 'name=beta']) {
    const { tab } = resendRequest({
      id: 'empty-name', method: 'POST', url: `http://127.0.0.1:${port}/`,
      requestBody: body, requestBodyEncoding: 'utf8',
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }
    });
    assert.equal(tab.bodyType, body === 'name=beta' ? 'urlencoded' : 'raw');
    if (tab.bodyType === 'raw') assert.equal(tab.urlEncodedFields.length, 0);
    const prepared = await prepareTab(tab, headerRowsToObject(tab.headers));
    assert.equal(prepared.payload.body, body);
    const result = await postJson(api.httpServer.address().port, {
      url: tab.url, method: tab.method, headers: prepared.headers,
      body: prepared.payload.body, bodyEncoding: prepared.payload.bodyEncoding
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(received.at(-1).body, Buffer.from(body));
    assert.equal(received.at(-1).type, 'application/x-www-form-urlencoded');
    const snippet = generateExportSnippet(currentExportRequest(tab), 'curl');
    assert.ok(snippet.includes(body), snippet);
  }
});
