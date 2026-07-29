import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';

import { ApiServer } from '../src/api/api-server.js';
import { trafficToHar } from '../src/api/har-converter.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

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

function requestJson(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: payload === null ? {} : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: response.statusCode,
          body: text ? JSON.parse(text) : null
        });
      });
    });
    request.once('error', reject);
    request.end(payload);
  });
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('WebSocket closed before the expected message'));
    };
    const cleanup = () => {
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    socket.on('message', onMessage);
    socket.once('close', onClose);
  });
}

function importedTraffic(id, requestPath) {
  return {
    id,
    timestamp: '2026-07-29T00:00:00.000Z',
    protocol: 'http',
    method: 'GET',
    url: `http://example.test${requestPath}`,
    host: 'example.test',
    path: requestPath,
    requestHeaders: {},
    responseHeaders: {},
    statusCode: 200,
    source: 'import'
  };
}

test('Send traverses the running proxy and creates authoritative shared traffic', async t => {
  let originHits = 0;
  let originHeaders = null;
  const origin = http.createServer((request, response) => {
    originHits++;
    originHeaders = request.headers;
    response.writeHead(207, { 'content-type': 'text/plain' });
    response.end('real origin response');
  });
  const originPort = await listen(origin);

  let api;
  const proxy = new ProxyServer(null, {
    port: 0,
    onRequest: data => api.onTrafficEvent(data)
  });
  api = new ApiServer(proxy, null, null, { port: 0 });
  api.port = 0;
  proxy.addMockRule({
    enabled: true,
    matchers: [{ type: 'url-contains', value: '/send-through-proxy' }],
    action: {
      type: 'fixed-response',
      status: 218,
      headers: { 'content-type': 'text/plain', 'x-freekit-mock': 'yes' },
      body: 'mocked by FreeKit'
    }
  });
  await proxy.start();
  await api.start();
  t.after(async () => {
    await api.stop();
    await proxy.stop();
    await close(origin);
  });

  const apiPort = api.httpServer.address().port;
  const response = await requestJson(apiPort, 'POST', '/api/send', {
    url: `http://127.0.0.1:${originPort}/send-through-proxy`,
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
      'x-http-freekit-internal-send-token': 'caller-controlled-value'
    },
    body: 'request body'
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.statusCode, 218);
  assert.equal(response.body.body, 'mocked by FreeKit');
  assert.match(response.body.trafficId, /^[0-9a-f-]{36}$/i);
  assert.equal(originHits, 0);

  const traffic = api.trafficLog.find(request => request.id === response.body.trafficId);
  assert.ok(traffic);
  assert.equal(traffic.source, 'Send');
  assert.equal(traffic.routeSource, 'mock');
  assert.equal(traffic.statusCode, 218);
  assert.equal(traffic.requestBody, 'request body');
  assert.equal(traffic.requestHeaders['x-http-freekit-internal-send-token'], undefined);

  const forwarded = await requestJson(apiPort, 'POST', '/api/send', {
    url: `http://127.0.0.1:${originPort}/real-through-proxy`,
    method: 'GET',
    headers: { 'x-http-freekit-internal-send-token': 'caller-controlled-value' },
    body: ''
  });
  assert.equal(forwarded.statusCode, 200);
  assert.equal(forwarded.body.statusCode, 207);
  assert.equal(forwarded.body.body, 'real origin response');
  assert.equal(originHits, 1);
  assert.equal(originHeaders['x-http-freekit-internal-send-token'], undefined);
  const forwardedTraffic = api.trafficLog.find(request => request.id === forwarded.body.trafficId);
  assert.ok(forwardedTraffic);
  assert.equal(forwardedTraffic.source, 'Send');
  assert.equal(forwardedTraffic.routeSource, 'proxy');
  assert.equal(forwardedTraffic.requestHeaders['x-http-freekit-internal-send-token'], undefined);

  const search = await requestJson(apiPort, 'GET', '/api/traffic/search?source=Send');
  assert.equal(search.statusCode, 200);
  assert.equal(search.body.total, 2);
  assert.equal(search.body.requests[0].id, response.body.trafficId);

  const har = trafficToHar(api.trafficLog, { maskSensitive: false });
  assert.equal(har.log.entries.length, 2);
  assert.equal(har.log.entries[0].response.status, 218);
});

test('server-assigned imported traffic is broadcast to every connected tab', async t => {
  const proxy = {
    port: 8080,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null, { port: 0 });
  api.port = 0;
  await api.start();
  t.after(() => api.stop());

  const apiPort = api.httpServer.address().port;
  const wsUrl = `ws://127.0.0.1:${apiPort}/ws`;
  const firstTab = await openWebSocket(wsUrl);
  const secondTab = await openWebSocket(wsUrl);
  t.after(() => {
    firstTab.close();
    secondTab.close();
  });

  api.trafficLog.push(importedTraffic('collision', '/existing'));
  const firstMessage = nextMessage(firstTab, message => message.type === 'traffic-imported');
  const secondMessage = nextMessage(secondTab, message => message.type === 'traffic-imported');
  const response = await requestJson(apiPort, 'POST', '/api/traffic/import', {
    requests: [importedTraffic('collision', '/imported')]
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.imported, 1);
  const [first, second] = await Promise.all([firstMessage, secondMessage]);
  assert.deepEqual(first, second);
  assert.equal(first.count, 1);
  assert.equal(first.requests.length, 1);
  assert.notEqual(first.requests[0].id, 'collision');
  assert.equal(first.requests[0].path, '/imported');
  assert.deepEqual(first.requests, api.trafficLog.slice(-1));
});

test('Send honors the configured upstream proxy without exposing its correlation header', async t => {
  let upstreamHits = 0;
  let upstreamPath = '';
  let upstreamHeaders = null;
  const upstream = http.createServer((request, response) => {
    upstreamHits++;
    upstreamPath = request.url;
    upstreamHeaders = request.headers;
    response.writeHead(209, { 'content-type': 'text/plain' });
    response.end('upstream proxy response');
  });
  const upstreamPort = await listen(upstream);

  let api;
  const proxy = new ProxyServer(null, {
    port: 0,
    onRequest: data => api.onTrafficEvent(data)
  });
  proxy.setUpstreamProxy({ host: '127.0.0.1', port: upstreamPort, type: 'http' });
  api = new ApiServer(proxy, null, null);
  api.port = 0;
  await proxy.start();
  await api.start();
  t.after(async () => {
    await api.stop();
    await proxy.stop();
    await close(upstream);
  });

  const response = await requestJson(api.httpServer.address().port, 'POST', '/api/send', {
    url: 'http://send-upstream.invalid/routed',
    method: 'GET',
    headers: {},
    body: ''
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.statusCode, 209);
  assert.equal(response.body.body, 'upstream proxy response');
  assert.equal(upstreamHits, 1);
  assert.equal(upstreamPath, 'http://send-upstream.invalid/routed');
  assert.equal(upstreamHeaders['x-http-freekit-internal-send-token'], undefined);
  const traffic = api.trafficLog.find(request => request.id === response.body.trafficId);
  assert.ok(traffic);
  assert.equal(traffic.source, 'Send');
  assert.equal(traffic.routeSource, 'proxy');
  assert.equal(traffic.usedUpstreamProxy, true);
});

test('renderer uses server-owned import and Send traffic identities', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const importStart = source.indexOf('function importHar()');
  const importEnd = source.indexOf('// ============ ACTIONS ============', importStart);
  const sendStart = source.indexOf('async function sendRequest()');
  const sendEnd = source.indexOf('function abortSendRequest()', sendStart);
  const websocketStart = source.indexOf('function handleWsMessage(msg)');
  const websocketEnd = source.indexOf('// ============ TRAFFIC ============', websocketStart);
  const importSource = source.slice(importStart, importEnd);
  const sendSource = source.slice(sendStart, sendEnd);
  const websocketSource = source.slice(websocketStart, websocketEnd);

  assert.match(importSource, /API_BASE \+ '\/api\/traffic\/import'/);
  assert.doesNotMatch(importSource, /imported\.forEach\([^)]*addRequest/);
  assert.match(websocketSource, /case 'traffic-imported':[\s\S]*addRequests\(msg\.requests\)/);
  assert.match(websocketSource, /!isPaused \|\| msg\.data\?\.source === 'Send'/);
  assert.doesNotMatch(sendSource, /addRequest\(/);
  assert.match(sendSource, /id: data\.trafficId/);
  assert.match(sendSource, /selectRequest\(data\.trafficId/);
});
