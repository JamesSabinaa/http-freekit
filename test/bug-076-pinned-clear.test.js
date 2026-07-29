import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../src/api/api-server.js';

function createApi() {
  return new ApiServer({
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
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

test('pin and Clear retain one authoritative lifecycle across API consumers and reloads', async t => {
  const api = createApi();
  api.trafficLog = [
    { id: 'shared', trafficLifecycleId: 'old', method: 'GET', host: 'pinned.test' },
    { id: 'shared', trafficLifecycleId: 'current', method: 'POST', host: 'removed.test' }
  ];
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(structuredClone(message));
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  const pinned = await requestJson(
    port,
    '/api/traffic/shared/pin?trafficLifecycleId=old',
    { method: 'PUT', body: { pinned: true } }
  );
  assert.deepEqual(pinned, {
    statusCode: 200,
    body: {
      success: true,
      requestId: 'shared',
      trafficLifecycleId: 'old',
      pinned: true,
      revision: 1
    }
  });

  const cleared = await requestJson(port, '/api/traffic/clear', { method: 'POST' });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.body.success, true);
  assert.deepEqual(cleared.body.retainedTraffic, [
    { id: 'shared', trafficLifecycleId: 'old' }
  ]);
  assert.deepEqual(api.trafficLog, [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    host: 'pinned.test',
    pinned: true
  }]);

  const detail = await requestJson(port, '/api/traffic/shared');
  assert.equal(detail.body.pinned, true);
  const search = await requestJson(port, '/api/traffic/search?host=pinned.test');
  assert.equal(search.body.total, 1);
  const exported = await requestJson(port, '/api/traffic/export');
  assert.deepEqual(exported.body.requests, api.trafficLog);
  assert.deepEqual(broadcasts, [
    {
      type: 'traffic-pinned',
      requestId: 'shared',
      trafficLifecycleId: 'old',
      pinned: true,
      revision: 1
    },
    {
      type: 'traffic-cleared',
      clearId: cleared.body.clearId,
      retainedTraffic: [{ id: 'shared', trafficLifecycleId: 'old' }]
    }
  ]);
});

test('pin mutations reject ambiguous identities and invalid state without changing traffic', async t => {
  const api = createApi();
  api.trafficLog = [
    { id: 'shared', trafficLifecycleId: 'first' },
    { id: 'shared', trafficLifecycleId: 'second' }
  ];
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  const ambiguous = await requestJson(port, '/api/traffic/shared/pin', {
    method: 'PUT',
    body: { pinned: true }
  });
  assert.equal(ambiguous.statusCode, 409);
  assert.match(ambiguous.body.error, /provide trafficLifecycleId/);

  const invalid = await requestJson(
    port,
    '/api/traffic/shared/pin?trafficLifecycleId=first',
    { method: 'PUT', body: { pinned: 'yes' } }
  );
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(api.trafficLog, [
    { id: 'shared', trafficLifecycleId: 'first' },
    { id: 'shared', trafficLifecycleId: 'second' }
  ]);
  assert.deepEqual(broadcasts, []);
});

test('unpinning makes a previously retained exchange eligible for the next Clear', async t => {
  const api = createApi();
  api.trafficLog = [{ id: 'kept', trafficLifecycleId: 'life', pinned: true }];
  api._broadcast = () => {};
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  const unpinned = await requestJson(port, '/api/traffic/kept/pin?trafficLifecycleId=life', {
    method: 'PUT',
    body: { pinned: false }
  });
  assert.equal(unpinned.statusCode, 200);
  const cleared = await requestJson(port, '/api/traffic/clear', { method: 'POST' });

  assert.deepEqual(cleared.body.retainedTraffic, []);
  assert.deepEqual(api.trafficLog, []);
});

test('a pinned pending lifecycle can complete after repeated Clear operations', () => {
  const api = createApi();
  const lifecycleToken = Symbol('pending');
  const pending = {
    id: 'slow',
    trafficLifecycleId: 'slow-life',
    _trafficLifecycleToken: lifecycleToken,
    _pending: true,
    method: 'GET'
  };
  api._broadcast = () => {};
  api.onTrafficEvent(pending);
  const generation = pending._trafficClearGeneration;
  api.trafficLog[0].pinned = true;

  api._clearTraffic();
  api._clearTraffic();
  api.onTrafficEvent({
    id: 'slow',
    trafficLifecycleId: 'slow-life',
    _trafficLifecycleToken: lifecycleToken,
    _trafficClearGeneration: generation,
    _update: true,
    method: 'GET',
    statusCode: 200
  });

  assert.deepEqual(api.trafficLog, [{
    id: 'slow',
    trafficLifecycleId: 'slow-life',
    method: 'GET',
    statusCode: 200,
    pinned: true
  }]);
  assert.equal(api._pendingTrafficIds.size, 0);
  assert.equal(api._pendingTrafficLifecycles.size, 0);
  assert.equal(api._retainedTrafficGenerations.size, 0);
});

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const identityStart = rendererSource.indexOf('function normalizeTrafficLifecycleId(');
const identityEnd = rendererSource.indexOf('function isSelectedTrafficRequest(', identityStart);
const stateStart = rendererSource.indexOf('const appliedTrafficClearIds = new Set();');
const stateEnd = rendererSource.indexOf('function connectWebSocket()', stateStart);
const actionStart = rendererSource.indexOf('const trafficPinInFlight = new Set();');
const actionEnd = rendererSource.indexOf('function updatePinIcon(', actionStart);
assert.notEqual(identityStart, -1);
assert.notEqual(identityEnd, -1);
assert.notEqual(stateStart, -1);
assert.notEqual(stateEnd, -1);
assert.notEqual(actionStart, -1);
assert.notEqual(actionEnd, -1);

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function rendererResponse(body, { ok = true, status = ok ? 200 : 500 } = {}) {
  return { ok, status, json: async () => body };
}

function createRenderer(fetch) {
  const toasts = [];
  const fetchCalls = [];
  let renders = 0;
  const pinIcons = [];
  const context = {
    API_BASE: '',
    encodeURIComponent,
    fetch: async (...args) => {
      fetchCalls.push(args);
      return fetch(...args);
    },
    toast: (message, type) => toasts.push({ message, type }),
    renderTraffic: () => { renders++; },
    updatePinIcon: pinned => pinIcons.push(pinned),
    applyFilter: () => {},
    closeDetail: () => {},
    isWebSocketConnection: () => false,
    wsExpandedConnections: new Set(),
    wsConnectionKey: () => ''
  };
  vm.createContext(context);
  vm.runInContext(`
    let requests = [
      { id: 'shared', trafficLifecycleId: 'old' },
      { id: 'shared', trafficLifecycleId: 'current' }
    ];
    let selectedRequestId = 'shared';
    let selectedRequestLifecycleId = 'old';
    let requestCounter = requests.length;
    let vsRenderStart = 0;
    let vsRenderEnd = 0;
    ${rendererSource.slice(identityStart, identityEnd)}
    function isSelectedTrafficRequest(request) {
      return selectedRequestId !== null && trafficRequestMatchesIdentity(
        request,
        selectedRequestId,
        selectedRequestLifecycleId
      );
    }
    function getSelectedTrafficRequest(collection = requests) {
      return findTrafficRequestByIdentity(
        collection,
        selectedRequestId,
        selectedRequestLifecycleId
      );
    }
    ${rendererSource.slice(stateStart, stateEnd)}
    function trafficActionRequest(requestId = selectedRequestId, trafficLifecycleId) {
      const resolvedLifecycleId = trafficLifecycleId === undefined && requestId === selectedRequestId
        ? selectedRequestLifecycleId
        : trafficLifecycleId;
      return findTrafficRequestByIdentity(requests, requestId, resolvedLifecycleId);
    }
    ${rendererSource.slice(actionStart, actionEnd)}
    globalThis.snapshot = () => ({
      requests,
      selectedRequestId,
      selectedRequestLifecycleId,
      inFlight: trafficPinInFlight.size
    });
  `, context);
  return {
    context,
    fetchCalls,
    toasts,
    pinIcons,
    get renders() { return renders; },
    snapshot() {
      return JSON.parse(JSON.stringify(context.snapshot()));
    }
  };
}

test('renderer pins only after authoritative confirmation and applies broadcast/response once', async () => {
  const pending = deferred();
  const renderer = createRenderer(() => pending.promise);
  const pinning = renderer.context.togglePinRequest();

  assert.equal(renderer.snapshot().requests[0].pinned, undefined);
  renderer.context.applyTrafficPinned('shared', 'old', true, 1);
  pending.resolve(rendererResponse({
    success: true,
    requestId: 'shared',
    trafficLifecycleId: 'old',
    pinned: true,
    revision: 1
  }));
  await pinning;

  assert.equal(renderer.fetchCalls[0][0], '/api/traffic/shared/pin?trafficLifecycleId=old');
  assert.equal(renderer.fetchCalls[0][1].method, 'PUT');
  assert.deepEqual(JSON.parse(renderer.fetchCalls[0][1].body), { pinned: true });
  assert.equal(renderer.snapshot().requests[0].pinned, true);
  assert.equal(renderer.snapshot().requests[1].pinned, undefined);
  assert.equal(renderer.renders, 1);
  assert.deepEqual(renderer.pinIcons, [true]);
  assert.deepEqual(renderer.toasts, [{ message: 'Exchange pinned', type: 'success' }]);
  assert.equal(renderer.snapshot().inFlight, 0);

  renderer.context.applyTrafficPinned('shared', 'old', false, 0);
  assert.equal(renderer.snapshot().requests[0].pinned, true);
  renderer.context.applyTrafficCleared('clear-one', [
    { id: 'shared', trafficLifecycleId: 'old' }
  ]);
  assert.deepEqual(renderer.snapshot().requests, [
    { id: 'shared', trafficLifecycleId: 'old', pinned: true }
  ]);
});

test('renderer preserves pin state when the authoritative mutation fails', async () => {
  const renderer = createRenderer(async () => rendererResponse(
    { error: 'pin unavailable' },
    { ok: false, status: 503 }
  ));

  await renderer.context.togglePinRequest();

  assert.equal(renderer.snapshot().requests[0].pinned, undefined);
  assert.equal(renderer.renders, 0);
  assert.deepEqual(renderer.toasts, [{
    message: 'Failed to update pin: pin unavailable',
    type: 'error'
  }]);
  assert.equal(renderer.snapshot().inFlight, 0);
});
