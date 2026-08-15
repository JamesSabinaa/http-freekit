import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'index.html'), 'utf8');
const sendStart = rendererSource.indexOf('async function sendRequest()');
const sendEnd = rendererSource.indexOf('// ============ CONFIG', sendStart);
assert.ok(sendStart >= 0 && sendEnd > sendStart, 'Send request source must be present');
const sendSource = rendererSource.slice(sendStart, sendEnd);

const INTERNAL_SEND_HEADER = 'x-http-freekit-internal-send-token';
const MIXED_METHOD = 'MiXeD-Custom';
const PUNCTUATION_METHOD = "MiXeD!#$%&'*+-.^_`|~09AZ";

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

function requestJson(port, body) {
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

function requestThroughProxy(proxyPort, targetUrl, method, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: targetUrl,
      method,
      headers
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}

function createRawOrigin() {
  const requests = [];
  const server = net.createServer(socket => {
    let raw = Buffer.alloc(0);
    let handled = false;
    const completeRequest = () => {
      const headerEnd = raw.indexOf('\r\n\r\n');
      if (headerEnd === -1) return null;
      const lines = raw.subarray(0, headerEnd).toString('latin1').split('\r\n');
      const requestLine = lines.shift();
      const headers = Object.create(null);
      for (const line of lines) {
        const separator = line.indexOf(':');
        if (separator > 0) {
          headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
        }
      }

      const wireBody = raw.subarray(headerEnd + 4);
      const contentLength = Number.parseInt(headers['content-length'], 10);
      if (Number.isFinite(contentLength)) {
        if (wireBody.length < contentLength) return null;
        return { requestLine, headers, body: wireBody.subarray(0, contentLength) };
      }
      if (headers['transfer-encoding']?.toLowerCase() === 'chunked') {
        const chunks = [];
        let offset = 0;
        while (true) {
          const lineEnd = wireBody.indexOf('\r\n', offset);
          if (lineEnd === -1) return null;
          const size = Number.parseInt(
            wireBody.subarray(offset, lineEnd).toString('ascii').split(';', 1)[0],
            16
          );
          if (!Number.isFinite(size)) throw new Error('Invalid chunk size from proxy');
          offset = lineEnd + 2;
          if (size === 0) {
            if (wireBody.length < offset + 2) return null;
            return { requestLine, headers, body: Buffer.concat(chunks) };
          }
          if (wireBody.length < offset + size + 2) return null;
          chunks.push(wireBody.subarray(offset, offset + size));
          offset += size + 2;
        }
      }
      return { requestLine, headers, body: Buffer.alloc(0) };
    };
    socket.on('data', chunk => {
      if (handled) return;
      raw = Buffer.concat([raw, chunk]);
      const parsed = completeRequest();
      if (!parsed) return;
      handled = true;
      requests.push({
        requestLine: parsed.requestLine,
        method: parsed.requestLine.split(' ', 1)[0],
        headers: parsed.headers,
        body: parsed.body.toString('utf8')
      });
      socket.end(
        'HTTP/1.1 207 Multi-Status\r\n' +
        'Content-Type: text/plain\r\n' +
        'Content-Length: 0\r\n' +
        'Connection: close\r\n\r\n'
      );
    });
  });
  return { server, requests };
}

async function runRendererSend(method) {
  const fetchCalls = [];
  const toasts = [];
  let prepared = 0;
  const methodInput = {
    value: method,
    validationMessage: '',
    ariaInvalid: null,
    focused: false,
    setCustomValidity(value) { this.validationMessage = value; },
    setAttribute(name, value) { if (name === 'aria-invalid') this.ariaInvalid = value; },
    removeAttribute(name) { if (name === 'aria-invalid') this.ariaInvalid = null; },
    focus() { this.focused = true; }
  };
  const elements = {
    sendMethod: methodInput,
    sendUrl: { value: 'https://example.test/resource' },
    sendHeaders: { value: '{}' }
  };
  const context = {
    AbortController,
    API_BASE: 'http://127.0.0.1:8080',
    activeSendTab: 'tab-1',
    document: { getElementById: id => elements[id] || null },
    prepareSendRequestPayload: async () => {
      prepared++;
      return { body: '', bodyEncoding: 'utf8' };
    },
    setSendLoading() {},
    toast: (...args) => toasts.push(args),
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return { json: async () => ({ error: 'stop after payload capture' }) };
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    let currentSendAbort = null;
    ${sendSource}
    globalThis.callSendRequest = sendRequest;
  `, context);
  await context.callSendRequest();
  return { fetchCalls, methodInput, prepared, toasts };
}

test('Send method editor accepts custom tokens while retaining standard verb suggestions', () => {
  assert.match(indexHtml, /<input[^>]*id="sendMethod"[^>]*list="sendMethodOptions"[^>]*value="GET"/);
  assert.match(indexHtml, /<input[^>]*id="sendMethod"[^>]*autocapitalize="off"/);
  assert.doesNotMatch(indexHtml, /<select[^>]*id="sendMethod"/);
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
    assert.match(indexHtml, new RegExp(`<option value="${method}"></option>`));
  }
});

test('renderer payloads preserve exact custom methods and reject invalid editor values before preparation', async () => {
  for (const method of [PUNCTUATION_METHOD, 'PROPFIND', 'POST']) {
    const result = await runRendererSend(method);
    assert.equal(result.prepared, 1, method);
    assert.equal(result.fetchCalls.length, 1, method);
    assert.equal(JSON.parse(result.fetchCalls[0].options.body).method, method);
    assert.equal(result.methodInput.validationMessage, '');
    assert.equal(result.methodInput.ariaInvalid, null);
  }

  for (const method of ['', '<img src=x>', 'GET /smuggled']) {
    const result = await runRendererSend(method);
    assert.equal(result.prepared, 0, String(method));
    assert.equal(result.fetchCalls.length, 0, String(method));
    assert.equal(result.methodInput.ariaInvalid, 'true');
    assert.equal(result.methodInput.focused, true);
    assert.match(result.methodInput.validationMessage, /valid HTTP token/i);
    assert.match(result.toasts[0][0], /valid HTTP token/i);
  }
});

test('internal Send method contexts are authenticated, stripped, and one-shot', async t => {
  const origin = createRawOrigin();
  const originPort = await listen(origin.server);
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin.server);
  });

  const targetUrl = `http://127.0.0.1:${originPort}/one-shot`;
  const proxyPort = proxy.server.address().port;
  const context = proxy._registerInternalSendRequest(5000, MIXED_METHOD);
  const firstStatus = await requestThroughProxy(proxyPort, targetUrl, 'POST', {
    [context.headerName]: context.token
  });
  assert.equal(firstStatus, 207);
  assert.equal(origin.requests[0].method, MIXED_METHOD);
  assert.equal(origin.requests[0].headers[INTERNAL_SEND_HEADER], undefined);

  const replayStatus = await requestThroughProxy(proxyPort, targetUrl, 'POST', {
    [context.headerName]: context.token
  });
  assert.equal(replayStatus, 207);
  assert.equal(origin.requests[1].method, 'POST');
  assert.equal(origin.requests[1].headers[INTERNAL_SEND_HEADER], undefined);

  const spoofStatus = await requestThroughProxy(proxyPort, targetUrl, 'POST', {
    [INTERNAL_SEND_HEADER]: 'caller-controlled-spoof'
  });
  assert.equal(spoofStatus, 207);
  assert.equal(origin.requests[2].method, 'POST');
  assert.equal(origin.requests[2].headers[INTERNAL_SEND_HEADER], undefined);
  assert.equal(proxy._internalSendTokens.size, 0);
  assert.equal(proxy._internalSendRequestIds.size, 0);
});

test('Send API immediately cancels internal context after synchronous request construction failure', async t => {
  const proxy = new ProxyServer(null, { port: 0 });
  const api = new ApiServer(proxy, null, null, { port: 0 });
  api.port = 0;
  await proxy.start();
  await api.start();
  t.after(async () => {
    await api.stop();
    await proxy.stop();
  });

  let registrationCount = 0;
  let cancellationCount = 0;
  let registeredContext = null;
  const registeredTimers = new Set();
  const clearedTimers = new Set();
  const originalRegister = proxy._registerInternalSendRequest.bind(proxy);
  const originalCancel = proxy._cancelInternalSendRequest.bind(proxy);
  const originalClearTimeout = globalThis.clearTimeout;
  t.mock.method(proxy, '_registerInternalSendRequest', (...args) => {
    registrationCount++;
    const result = originalRegister(...args);
    registeredContext = proxy._internalSendRequestIds.get(result.requestId);
    registeredTimers.add(registeredContext.timer);
    return result;
  });
  t.mock.method(proxy, '_cancelInternalSendRequest', token => {
    cancellationCount++;
    return originalCancel(token);
  });
  t.mock.method(globalThis, 'clearTimeout', timer => {
    if (registeredTimers.has(timer)) clearedTimers.add(timer);
    return originalClearTimeout(timer);
  });

  const response = await requestJson(api.httpServer.address().port, {
    url: 'http://127.0.0.1/never-sent',
    method: 'GET',
    headers: { 'bad header': 'invalid' },
    body: ''
  });

  assert.equal(response.statusCode, 500);
  assert.match(response.body.error, /Header name must be a valid HTTP token/i);
  assert.equal(registrationCount, 1);
  assert.equal(cancellationCount, 1);
  assert.equal(proxy.requestCount, 0);
  assert.equal(proxy._internalSendTokens.size, 0);
  assert.equal(proxy._internalSendRequestIds.size, 0);
  assert.ok(registeredContext);
  assert.equal(clearedTimers.has(registeredContext.timer), true);

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellationCount, 1, 'later failure delivery must not cancel the context twice');
});

test('Send API restores exact methods before mocks, capture, and upstream forwarding', async t => {
  const origin = createRawOrigin();
  const originPort = await listen(origin.server);
  let api;
  const proxy = new ProxyServer(null, {
    port: 0,
    onRequest: data => api.onTrafficEvent(data)
  });
  proxy.addMockRule({
    enabled: true,
    matchers: [
      { type: 'method', value: MIXED_METHOD },
      { type: 'url-contains', value: '/method-mock' }
    ],
    action: {
      type: 'fixed-response',
      status: 219,
      headers: { 'content-type': 'text/plain' },
      body: 'custom method matched'
    }
  });
  api = new ApiServer(proxy, null, null, { port: 0 });
  api.port = 0;
  await proxy.start();
  await api.start();
  t.after(async () => {
    await api.stop();
    await proxy.stop();
    await close(origin.server);
  });

  const apiPort = api.httpServer.address().port;
  const mocked = await requestJson(apiPort, {
    url: `http://127.0.0.1:${originPort}/method-mock`,
    method: MIXED_METHOD,
    headers: {},
    body: ''
  });
  assert.equal(mocked.statusCode, 200);
  assert.equal(mocked.body.statusCode, 219);
  assert.equal(mocked.body.body, 'custom method matched');
  assert.equal(origin.requests.length, 0);
  const mockedTraffic = api.trafficLog.find(row => row.id === mocked.body.trafficId);
  assert.equal(mockedTraffic.method, MIXED_METHOD);
  assert.equal(mockedTraffic.source, 'Send');
  assert.equal(mockedTraffic.routeSource, 'mock');

  const forwardedRequests = [
    { method: PUNCTUATION_METHOD, body: '' },
    { method: 'PROPFIND', body: '' },
    { method: 'PATCH', body: '' },
    { method: 'gEt', body: 'case-sensitive request body' },
    { method: 'GET', body: 'uppercase GET request body' },
    { method: 'HEAD', body: 'uppercase HEAD request body' },
    { method: 'CONNECT', body: '' }
  ];
  for (const { method, body } of forwardedRequests) {
    const response = await requestJson(apiPort, {
      url: `http://127.0.0.1:${originPort}/forward-${origin.requests.length}`,
      method,
      headers: { [INTERNAL_SEND_HEADER]: 'caller-controlled-value' },
      body
    });
    assert.equal(response.statusCode, 200, method);
    assert.equal(response.body.statusCode, 207, method);
    const traffic = api.trafficLog.find(row => row.id === response.body.trafficId);
    assert.equal(traffic.method, method, method);
    assert.equal(traffic.requestBody, body, method);
    assert.equal(traffic.source, 'Send', method);
    assert.equal(traffic.routeSource, 'proxy', method);
  }

  const omitted = await requestJson(apiPort, {
    url: `http://127.0.0.1:${originPort}/omitted`,
    headers: {},
    body: ''
  });
  assert.equal(omitted.statusCode, 200);
  assert.equal(omitted.body.statusCode, 207);
  assert.deepEqual(origin.requests.map(request => request.method), [
    ...forwardedRequests.map(request => request.method),
    'GET'
  ]);
  assert.deepEqual(origin.requests.map(request => request.body), [
    ...forwardedRequests.map(request => request.body),
    ''
  ]);
  assert.ok(origin.requests.every(request => request.headers[INTERNAL_SEND_HEADER] === undefined));

  const originCount = origin.requests.length;
  for (const method of ['', null, '<img src=x>', 'GET /smuggled', 42]) {
    const rejected = await requestJson(apiPort, {
      url: `http://127.0.0.1:${originPort}/must-not-run`,
      method,
      headers: {},
      body: ''
    });
    assert.equal(rejected.statusCode, 400, String(method));
    assert.match(rejected.body.error, /method.*HTTP token/i, String(method));
  }
  assert.equal(origin.requests.length, originCount);
  assert.equal(proxy._internalSendTokens.size, 0);
  assert.equal(proxy._internalSendRequestIds.size, 0);
});

test('direct Send frames exact GET and HEAD bodies without a proxy', async t => {
  const origin = createRawOrigin();
  const originPort = await listen(origin.server);
  t.after(() => close(origin.server));
  const api = new ApiServer({ port: 0 }, null, null, {
    sendConnectTimeoutMs: 1000,
    sendIdleTimeoutMs: 1000,
    sendTotalTimeoutMs: 5000
  });
  const directRequests = [
    { method: 'GET', body: 'direct GET body' },
    { method: 'HEAD', body: 'direct HEAD body' }
  ];

  for (const { method, body } of directRequests) {
    const result = await api._sendRequest(
      `http://127.0.0.1:${originPort}/direct-${method.toLowerCase()}`,
      method,
      {},
      body
    );
    assert.equal(result.statusCode, 207, method);
  }

  assert.deepEqual(origin.requests.map(request => request.method), ['GET', 'HEAD']);
  assert.deepEqual(origin.requests.map(request => request.body), directRequests.map(request => request.body));
  for (let index = 0; index < directRequests.length; index++) {
    assert.equal(
      origin.requests[index].headers['content-length'],
      String(Buffer.byteLength(directRequests[index].body)),
      directRequests[index].method
    );
    assert.equal(origin.requests[index].headers['transfer-encoding'], undefined);
  }
});
