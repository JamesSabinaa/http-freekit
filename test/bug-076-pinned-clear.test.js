import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../src/api/api-server.js';

function createApi(options = {}) {
  return new ApiServer({
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  }, null, null, options);
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
  assert.equal(cleared.body.revision, 1);
  const retainedRequest = {
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    host: 'pinned.test',
    pinned: true
  };
  assert.deepEqual(cleared.body.retainedTraffic, [retainedRequest]);
  assert.deepEqual(api.trafficLog, [retainedRequest]);

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
      revision: 1,
      retainedTraffic: [retainedRequest]
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
  const ambiguousDetail = await requestJson(port, '/api/traffic/shared');
  assert.equal(ambiguousDetail.statusCode, 409);
  const exactDetail = await requestJson(port, '/api/traffic/shared?trafficLifecycleId=first');
  assert.equal(exactDetail.statusCode, 200);
  assert.equal(exactDetail.body.trafficLifecycleId, 'first');

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

test('Clear chunks retained snapshots without exceeding the WebSocket ceiling', async () => {
  const api = createApi();
  const retainedTraffic = [
    {
      id: 'one',
      trafficLifecycleId: 'one-life',
      protocol: 'http',
      responseBody: 'a'.repeat(700),
      pinned: true
    },
    {
      id: 'two',
      trafficLifecycleId: 'two-life',
      protocol: 'http',
      responseBody: 'b'.repeat(700),
      pinned: true
    }
  ];
  const placeholderChunk = Number.MAX_SAFE_INTEGER;
  const sampleClearId = '00000000-0000-4000-8000-000000000000';
  api.maxWsBufferedBytes = Math.max(...retainedTraffic.map(request =>
    Buffer.byteLength(JSON.stringify(api._trafficClearBroadcastMessage(
      sampleClearId,
      [request],
      placeholderChunk,
      placeholderChunk,
      placeholderChunk
    )))
  )) + 8;
  assert.equal(api._messageFitsWsBuffer(api._trafficClearBroadcastMessage(
    sampleClearId,
    retainedTraffic,
    0,
    1
  )), false);

  const client = {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    terminateCalls: 0,
    send(payload, callback) {
      this.sent.push(payload);
      callback();
    },
    terminate() { this.terminateCalls++; }
  };
  api.clients.add(client);
  api.trafficLog = retainedTraffic;
  const result = api._clearTraffic();
  for (let attempt = 0; attempt < 10 && client.sent.length < 2; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.deepEqual(result.retainedTraffic, retainedTraffic);
  assert.equal(client.terminateCalls, 0);
  assert.equal(api.clients.has(client), true);
  assert.ok(client.sent.length > 1);
  assert.ok(client.sent.every(payload => Buffer.byteLength(payload) <= api.maxWsBufferedBytes));
  const messages = client.sent.map(payload => JSON.parse(payload));
  assert.ok(messages.every((message, index) =>
    message.type === 'traffic-cleared' &&
    message.clearId === result.clearId &&
    message.revision === result.revision &&
    message.chunkIndex === index &&
    message.chunkCount === messages.length
  ));
  assert.deepEqual(messages.flatMap(message => message.retainedTraffic), retainedTraffic);
});

test('WebSocket frames cannot become independently pinned or import invalid pin state', async t => {
  const api = createApi();
  api.trafficLog = [{
    id: 'frame',
    trafficLifecycleId: 'frame-life',
    parentId: 'socket',
    protocol: 'ws-frame'
  }];
  api._broadcast = () => {};
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  const pin = await requestJson(port, '/api/traffic/frame/pin?trafficLifecycleId=frame-life', {
    method: 'PUT',
    body: { pinned: true }
  });
  assert.equal(pin.statusCode, 400);
  assert.match(pin.body.error, /pin the parent connection/);
  assert.equal(api.trafficLog[0].pinned, undefined);

  const invalidBoolean = api._getTrafficImportValidationError([{
    id: 'imported',
    timestamp: Date.now(),
    pinned: 'yes'
  }]);
  assert.equal(invalidBoolean, 'requests[0].pinned must be a boolean');
  const pinnedFrame = api._getTrafficImportValidationError([{
    id: 'imported-frame',
    parentId: 'socket',
    protocol: 'ws-frame',
    timestamp: Date.now(),
    pinned: true
  }]);
  assert.equal(pinnedFrame, 'requests[0].pinned cannot be true for WebSocket frames');
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

test('a pinned WebSocket keeps post-Clear frames without growing generation history', () => {
  const api = createApi();
  const lifecycleToken = Symbol('socket');
  const socket = {
    id: 'socket',
    trafficLifecycleId: 'socket-life',
    _trafficLifecycleToken: lifecycleToken,
    _pending: true,
    protocol: 'ws'
  };
  api._broadcast = () => {};
  api.onTrafficEvent(socket);
  const originalGeneration = socket._trafficClearGeneration;
  api.trafficLog[0].pinned = true;

  api._clearTraffic();
  api._clearTraffic();
  api._clearTraffic();

  const retainedGenerations = api._retainedTrafficGenerations.get(
    api._trafficIdentityKey('socket', 'socket-life')
  );
  assert.equal(retainedGenerations.size, 1);
  assert.equal(retainedGenerations.has(originalGeneration), true);

  api.onTrafficEvent({
    id: 'frame',
    trafficLifecycleId: 'frame-life',
    parentId: 'socket',
    parentTrafficLifecycleId: 'socket-life',
    _trafficClearGeneration: originalGeneration,
    protocol: 'ws-frame',
    requestBody: 'hello'
  });

  assert.deepEqual(api.trafficLog.map(request => request.id), ['socket', 'frame']);
  assert.equal(api.trafficLog[1].requestBody, 'hello');
});

test('a deleted retained lifecycle expires after its old-generation completion', async t => {
  let now = 0;
  const api = createApi({
    clearedPendingTrafficTtlMs: 5,
    clearedPendingTrafficNow: () => now
  });
  const lifecycleToken = Symbol('socket');
  const socket = {
    id: 'socket',
    trafficLifecycleId: 'socket-life',
    _trafficLifecycleToken: lifecycleToken,
    _pending: true,
    protocol: 'wss'
  };
  api._broadcast = () => {};
  api.onTrafficEvent(socket);
  const originalGeneration = socket._trafficClearGeneration;
  api.trafficLog[0].pinned = true;
  api._clearTraffic();

  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));
  const deleted = await requestJson(
    port,
    '/api/traffic/socket?trafficLifecycleId=socket-life',
    { method: 'DELETE' }
  );
  assert.equal(deleted.statusCode, 200);
  const identityKey = api._trafficIdentityKey('socket', 'socket-life');
  assert.equal(api._deletedTrafficIdentities.get(identityKey), Infinity);

  api.onTrafficEvent({
    id: 'socket',
    trafficLifecycleId: 'socket-life',
    _trafficLifecycleToken: lifecycleToken,
    _trafficClearGeneration: originalGeneration,
    _update: true,
    protocol: 'wss',
    statusCode: 101
  });

  assert.equal(api._deletedTrafficIdentities.get(identityKey), 5);
  now = 6;
  api._pruneDeletedTrafficIdentities();
  assert.equal(api._deletedTrafficIdentities.has(identityKey), false);
});

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const identityStart = rendererSource.indexOf('function normalizeTrafficLifecycleId(');
const identityEnd = rendererSource.indexOf('function isSelectedTrafficRequest(', identityStart);
const mergeStart = rendererSource.indexOf('function mergeServerTrafficRequest(');
const mergeEnd = rendererSource.indexOf('function mergeTrafficDumpPins(', mergeStart);
const stateStart = rendererSource.indexOf('const appliedTrafficClearIds = new Set();');
const stateEnd = rendererSource.indexOf('function connectWebSocket()', stateStart);
const actionStart = rendererSource.indexOf('const trafficPinInFlight = new Set();');
const actionEnd = rendererSource.indexOf('function updatePinIcon(', actionStart);
assert.notEqual(identityStart, -1);
assert.notEqual(identityEnd, -1);
assert.notEqual(mergeStart, -1);
assert.notEqual(mergeEnd, -1);
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
  const shownDetails = [];
  const hydratedDetails = [];
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
    showDetail: request => shownDetails.push(structuredClone(request)),
    hydrateDeferredTrafficRequest: request => hydratedDetails.push(structuredClone(request)),
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
    ${rendererSource.slice(mergeStart, mergeEnd)}
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
    globalThis.setRequests = value => { requests = value; };
  `, context);
  return {
    context,
    fetchCalls,
    toasts,
    pinIcons,
    shownDetails,
    hydratedDetails,
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

test('renderer replaces stale rows and restores missed retained rows from Clear', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  renderer.context.setRequests([
    { id: 'shared', trafficLifecycleId: 'old', method: 'GET', _pending: true },
    { id: 'removed', trafficLifecycleId: 'gone', method: 'DELETE' }
  ]);

  renderer.context.applyTrafficCleared('authoritative-clear', [
    {
      id: 'shared',
      trafficLifecycleId: 'old',
      method: 'GET',
      statusCode: 200,
      pinned: true
    },
    {
      id: 'missed',
      trafficLifecycleId: 'missed-life',
      method: 'POST',
      statusCode: 201,
      pinned: true
    }
  ]);

  assert.deepEqual(renderer.snapshot().requests, [
    {
      id: 'shared',
      trafficLifecycleId: 'old',
      method: 'GET',
      statusCode: 200,
      pinned: true
    },
    {
      id: 'missed',
      trafficLifecycleId: 'missed-life',
      method: 'POST',
      statusCode: 201,
      pinned: true
    }
  ]);
  assert.deepEqual(renderer.shownDetails, [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    statusCode: 200,
    pinned: true
  }]);
});

test('renderer applies chunked Clear snapshots only after the final chunk', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  const before = renderer.snapshot().requests;
  const firstApplied = renderer.context.applyTrafficClearedMessage({
    type: 'traffic-cleared',
    clearId: 'chunked-clear',
    chunkIndex: 0,
    chunkCount: 2,
    retainedTraffic: [{
      id: 'shared',
      trafficLifecycleId: 'old',
      method: 'GET',
      statusCode: 200,
      pinned: true
    }]
  });
  assert.equal(firstApplied, false);
  assert.deepEqual(renderer.snapshot().requests, before);

  const finalApplied = renderer.context.applyTrafficClearedMessage({
    type: 'traffic-cleared',
    clearId: 'chunked-clear',
    chunkIndex: 1,
    chunkCount: 2,
    retainedTraffic: [{
      id: 'missed',
      trafficLifecycleId: 'missed-life',
      method: 'POST',
      statusCode: 201,
      pinned: true
    }]
  });
  assert.equal(finalApplied, true);
  assert.deepEqual(renderer.snapshot().requests.map(request => request.id), ['shared', 'missed']);
});

test('a newer Clear response supersedes incomplete older chunks', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  renderer.context.applyTrafficClearedMessage({
    type: 'traffic-cleared',
    clearId: 'older-clear',
    revision: 1,
    chunkIndex: 0,
    chunkCount: 2,
    retainedTraffic: [{ id: 'older-one', pinned: true }]
  });

  const newerApplied = renderer.context.applyTrafficCleared(
    'newer-clear',
    [{ id: 'newer', pinned: true }],
    2
  );
  const olderCompleted = renderer.context.applyTrafficClearedMessage({
    type: 'traffic-cleared',
    clearId: 'older-clear',
    revision: 1,
    chunkIndex: 1,
    chunkCount: 2,
    retainedTraffic: [{ id: 'older-two', pinned: true }]
  });

  assert.equal(newerApplied, true);
  assert.equal(olderCompleted, false);
  assert.deepEqual(renderer.snapshot().requests.map(request => request.id), ['newer']);
});

test('REST Clear completion upgrades a deferred WebSocket snapshot', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  renderer.context.applyTrafficCleared('large-clear', [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    pinned: true,
    _deferredTrafficDetail: true
  }]);
  assert.equal(renderer.hydratedDetails.length, 1);

  const upgraded = renderer.context.applyTrafficCleared('large-clear', [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    responseBody: 'complete body',
    pinned: true
  }]);

  assert.equal(upgraded, true);
  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'shared',
    trafficLifecycleId: 'old',
    method: 'GET',
    responseBody: 'complete body',
    pinned: true
  }]);
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
