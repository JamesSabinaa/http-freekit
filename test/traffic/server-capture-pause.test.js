import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

function createApi() {
  return new ApiServer({
    port: 8080,
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null,
    getStats: () => ({})
  }, null, null);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function requestJson(port, requestPath, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const encodedBody = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: encodedBody === null ? undefined : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(encodedBody)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end(encodedBody);
  });
}

test('paused capture drops whole new proxy lifecycles but completes rows retained before Pause', () => {
  const api = createApi();
  const broadcasts = [];
  const rotated = [];
  api._broadcast = message => broadcasts.push(structuredClone(message));
  api._maybeAutoRotateProxyOnError = data => rotated.push(data.id);

  api.onTrafficEvent({
    id: 'before-pause',
    trafficLifecycleId: 'before-life',
    source: 'proxy',
    _pending: true,
    _trafficLifecycleComplete: false
  });
  api._setCapturePaused(true);

  assert.equal(api.onTrafficEvent({
    id: 'during-pause',
    trafficLifecycleId: 'paused-life',
    source: 'proxy',
    statusCode: 503
  }), false);
  api.onTrafficEvent({
    id: 'before-pause',
    trafficLifecycleId: 'before-life',
    source: 'proxy',
    _update: true,
    statusCode: 204
  });
  api.onTrafficEvent({
    id: 'send-while-paused',
    trafficLifecycleId: 'send-life',
    source: 'Send',
    statusCode: 200
  });

  assert.deepEqual(api.trafficLog.map(request => [request.id, request.statusCode]), [
    ['before-pause', 204],
    ['send-while-paused', 200]
  ]);
  assert.deepEqual(rotated, ['during-pause', 'before-pause']);
  assert.deepEqual(
    broadcasts.filter(message => message.type === 'request').map(message => message.data.id),
    ['before-pause', 'send-while-paused']
  );
  assert.deepEqual(
    broadcasts.filter(message => message.type === 'request-update').map(message => message.data.id),
    ['before-pause']
  );
});

test('proxy decisions suppress long paused lifecycles and their WebSocket frames through Resume', async () => {
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  const rotated = [];
  proxy.onRequest = data => api.onTrafficEvent(data);
  proxy.onSuppressedRequestCompletion = data => api.onSuppressedTrafficCompletion(data);
  api._maybeAutoRotateProxyOnError = data => rotated.push(data.id);
  api.maxClearedPendingTrafficIds = 1;
  api.clearedPendingTrafficTtlMs = 1;
  api._setCapturePaused(true);

  const pending = (id, protocol = 'http') => ({
    id,
    protocol,
    method: protocol === 'ws' ? 'WS' : 'GET',
    url: `${protocol}://capture.test/${id}`,
    host: 'capture.test',
    path: `/${id}`,
    requestHeaders: {},
    requestBody: '',
    requestBodySize: 0,
    timestamp: 1_000,
    source: 'proxy',
    tls: null,
    remote: null
  });
  const first = pending('paused-first');
  const second = pending('paused-second');
  const socket = pending('paused-socket', 'ws');

  assert.equal(proxy._emitPendingRequest(first, 'first-life'), false);
  assert.equal(proxy._emitPendingRequest(second, 'second-life'), false);
  assert.equal(proxy._emitPendingRequest(socket, 'socket-life'), false);
  assert.equal(proxy._pendingTrafficLogDecisions.size, 3);

  // Neither an unrelated API retention bound nor elapsed wall time may turn a
  // rejected pending lifecycle into a later captured completion.
  api._clearedPendingTrafficNow = () => 10_000;
  api._setCapturePaused(false);
  const complete = request => ({
    ...request,
    statusCode: 200,
    responseHeaders: {},
    responseBody: '',
    responseBodySize: 0,
    duration: 9_000
  });
  assert.equal(proxy._emitRequestUpdate(complete(first), 'first-life'), false);
  assert.equal(proxy._emitRequestUpdate(complete(second), 'second-life'), false);

  const frame = {
    fin: true,
    rsv1: false,
    rsv2: false,
    rsv3: false,
    compressed: false,
    opcode: 1,
    masked: false,
    payload: Buffer.from('hidden'),
    timestamp: 10_001
  };
  assert.equal(await proxy._emitWsFrame(
    frame,
    'server',
    socket.id,
    1,
    null,
    socket.timestamp,
    'socket-life'
  ), false);
  assert.equal(proxy._emitRequestUpdate(complete(socket), 'socket-life'), false);

  assert.deepEqual(api.trafficLog, []);
  assert.equal(proxy._pendingTrafficLogDecisions.size, 0);
  assert.deepEqual(rotated, ['paused-first', 'paused-second', 'paused-socket']);

  const startup = fs.readFileSync(path.join(process.cwd(), 'src', 'index.js'), 'utf8');
  assert.match(startup, /onSuppressedRequestCompletion:[\s\S]*api\.onSuppressedTrafficCompletion\(data\)/);
});

test('capture state API validates, applies, and broadcasts one shared state', async t => {
  const api = createApi();
  api.captureStateSessionId = 'capture-session-a';
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  const invalid = await requestJson(port, '/api/traffic/capture', {
    method: 'PUT',
    body: { paused: 'yes' }
  });
  assert.equal(invalid.statusCode, 400);

  const paused = await requestJson(port, '/api/traffic/capture', {
    method: 'PUT',
    body: { paused: true }
  });
  const duplicate = await requestJson(port, '/api/traffic/capture', {
    method: 'PUT',
    body: { paused: true }
  });
  const current = await requestJson(port, '/api/traffic/capture');

  assert.deepEqual(paused, {
    statusCode: 200,
    body: {
      success: true,
      paused: true,
      sessionId: 'capture-session-a',
      revision: 1
    }
  });
  assert.deepEqual(duplicate, paused);
  assert.deepEqual(current, {
    statusCode: 200,
    body: { paused: true, sessionId: 'capture-session-a', revision: 1 }
  });
  assert.deepEqual(broadcasts, [{
    type: 'capture-state',
    paused: true,
    sessionId: 'capture-session-a',
    revision: 1
  }]);
  assert.notEqual(createApi().captureStateSessionId, api.captureStateSessionId);
});

test('renderer requests authoritative pause changes and renders server broadcasts', async () => {
  const renderer = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = renderer.indexOf('function applyCapturePausedState(');
  const end = renderer.indexOf('// ============ TRAFFIC ============', start);
  const toggleStart = renderer.indexOf('function togglePause(');
  const toggleEnd = renderer.indexOf('function downloadCert()', toggleStart);
  const pauseSource = renderer.slice(start, end) + renderer.slice(toggleStart, toggleEnd);
  const websocketStart = renderer.indexOf('function handleWsMessage(msg)');
  const websocketEnd = renderer.indexOf('// ============ TRAFFIC ============', websocketStart);
  const websocketSource = renderer.slice(websocketStart, websocketEnd);
  const button = {
    attributes: new Map(),
    style: {},
    setAttribute(name, value) { this.attributes.set(name, value); }
  };
  const requests = [];
  let renders = 0;
  let resolveFetch;
  const context = vm.createContext({
    API_BASE: '',
    console,
    document: { getElementById: id => id === 'pauseBtn' ? button : null },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return await new Promise(resolve => {
        resolveFetch = () => resolve({
          ok: true,
          json: async () => ({
            success: true,
            paused: true,
            sessionId: 'capture-session-a',
            revision: 1
          })
        });
      });
    },
    renderTraffic: () => { renders += 1; },
    toast: () => {}
  });
  vm.runInContext(`
    let isPaused = false;
    let captureStateSessionId = null;
    let captureStateRevision = -1;
    let pauseMutationPending = false;
    ${pauseSource}
    globalThis.applyPauseForTest = applyCapturePausedState;
    globalThis.togglePauseForTest = togglePause;
  `, context);

  const toggle = context.togglePauseForTest();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/traffic/capture');
  assert.equal(requests[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(requests[0].options.body), { paused: true });
  context.applyPauseForTest(true, 'capture-session-a', 1);
  context.applyPauseForTest(false, 'capture-session-a', 2);
  resolveFetch();
  await toggle;

  // A WebSocket init may establish a new server epoch. Responses/messages
  // from the old epoch must not replace that newly initialized state.
  context.applyPauseForTest(true, 'capture-session-a', 3);
  context.applyPauseForTest(false, 'capture-session-b', 0, true);
  context.applyPauseForTest(true, 'capture-session-a', 4);

  assert.equal(button.title, 'Pause capture');
  assert.equal(button.attributes.get('aria-pressed'), 'false');
  assert.equal(button.attributes.get('aria-disabled'), 'false');
  assert.equal(renders, 4);
  assert.match(websocketSource, /case 'init':[\s\S]*msg\.captureStateSessionId,[\s\S]*msg\.captureStateRevision,[\s\S]*true/);
  assert.match(websocketSource, /case 'capture-state':[\s\S]*applyCapturePausedState\(msg\.paused === true, msg\.sessionId, msg\.revision\)/);
  assert.doesNotMatch(websocketSource, /!isPaused \|\| msg\.data\?\.source === 'Send'/);
});
