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

function requestJson(port, requestPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

test('DELETE traffic removes the authoritative lifecycle and its WebSocket frames', async t => {
  const api = createApi();
  api.trafficLog = [
    { id: 'shared', trafficLifecycleId: 'old', protocol: 'wss', host: 'deleted.test' },
    {
      id: 'old-frame',
      protocol: 'ws-frame',
      parentId: 'shared',
      parentTrafficLifecycleId: 'old'
    },
    { id: 'shared', trafficLifecycleId: 'current', protocol: 'wss', host: 'retained.test' },
    {
      id: 'current-frame',
      protocol: 'ws-frame',
      parentId: 'shared',
      parentTrafficLifecycleId: 'current'
    },
    { id: 'unrelated', protocol: 'http', host: 'retained.test' }
  ];
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  const response = await requestJson(
    port,
    '/api/traffic/shared?trafficLifecycleId=old',
    'DELETE'
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    success: true,
    requestId: 'shared',
    trafficLifecycleId: 'old',
    webSocketConnection: true,
    removed: 2
  });
  assert.deepEqual(api.trafficLog.map(request => request.id), [
    'shared',
    'current-frame',
    'unrelated'
  ]);
  assert.equal(api.trafficLog[0].trafficLifecycleId, 'current');
  assert.deepEqual(broadcasts, [{
    type: 'traffic-deleted',
    requestId: 'shared',
    trafficLifecycleId: 'old',
    webSocketConnection: true,
    removed: 2
  }]);

  const search = await requestJson(port, '/api/traffic/search?host=deleted.test');
  assert.deepEqual(search.body, { total: 0, requests: [] });
  const exported = await requestJson(port, '/api/traffic/export');
  assert.equal(exported.body.requests.some(request =>
    request.id === 'shared' && request.trafficLifecycleId === 'old'
  ), false);
});

test('DELETE traffic rejects an ambiguous ID without changing or broadcasting state', async t => {
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

  const response = await requestJson(port, '/api/traffic/shared', 'DELETE');

  assert.equal(response.statusCode, 409);
  assert.match(response.body.error, /provide trafficLifecycleId/);
  assert.equal(api.trafficLog.length, 2);
  assert.deepEqual(broadcasts, []);
});

test('a late completion cannot restore a deleted pending traffic lifecycle', async t => {
  const api = createApi();
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);
  const lifecycleToken = Symbol('pending');
  api.onTrafficEvent({
    id: 'slow',
    trafficLifecycleId: 'slow-lifecycle',
    _trafficLifecycleToken: lifecycleToken,
    _pending: true,
    method: 'GET'
  });
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  const response = await requestJson(
    port,
    '/api/traffic/slow?trafficLifecycleId=slow-lifecycle',
    'DELETE'
  );
  assert.equal(response.statusCode, 200);
  api.onTrafficEvent({
    id: 'slow',
    trafficLifecycleId: 'slow-lifecycle',
    _trafficLifecycleToken: lifecycleToken,
    _update: true,
    method: 'GET',
    statusCode: 200
  });
  api.onTrafficEvent({
    id: 'slow',
    trafficLifecycleId: 'slow-lifecycle',
    _update: true,
    statusCode: 201
  });

  assert.deepEqual(api.trafficLog, []);
  assert.equal(api._pendingTrafficIds.has('slow'), false);
  assert.equal(api._deletedPendingTrafficIdentities.size, 1);
  assert.deepEqual(broadcasts.map(message => message.type), ['request', 'traffic-deleted']);
});

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const identityStart = rendererSource.indexOf('function normalizeTrafficLifecycleId(');
const identityEnd = rendererSource.indexOf('function isSelectedTrafficRequest(', identityStart);
const deletionStateStart = rendererSource.indexOf('function applyTrafficDeleted(');
const deletionStateEnd = rendererSource.indexOf('function connectWebSocket()', deletionStateStart);
const actionStart = rendererSource.indexOf('const trafficDeleteInFlight = new Set();');
const actionEnd = rendererSource.indexOf('function resendSelectedRequest(', actionStart);
assert.notEqual(identityStart, -1);
assert.notEqual(identityEnd, -1);
assert.notEqual(deletionStateStart, -1);
assert.notEqual(deletionStateEnd, -1);
assert.notEqual(actionStart, -1);
assert.notEqual(actionEnd, -1);
assert.match(rendererSource, /case 'traffic-deleted':\s*applyTrafficDeleted\(/);

function rendererResponse(body, { ok = true, status = ok ? 200 : 500 } = {}) {
  return { ok, status, json: async () => body };
}

function createRenderer(fetch) {
  const toasts = [];
  const fetchCalls = [];
  const context = {
    API_BASE: '',
    confirm: () => true,
    encodeURIComponent,
    fetch: async (...args) => {
      fetchCalls.push(args);
      return fetch(...args);
    },
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(`
    let requests = [
      { id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', pinned: false },
      {
        id: 'old-frame', protocol: 'ws-frame', parentId: 'socket',
        parentTrafficLifecycleId: 'old'
      },
      { id: 'socket', trafficLifecycleId: 'current', protocol: 'wss', pinned: false },
      {
        id: 'current-frame', protocol: 'ws-frame', parentId: 'socket',
        parentTrafficLifecycleId: 'current'
      }
    ];
    let selectedRequestId = 'socket';
    let selectedRequestLifecycleId = 'old';
    let requestCounter = requests.length;
    let filterCalls = 0;
    let closeCalls = 0;
    const wsExpandedConnections = new Set();
    function isWebSocketConnection(request) {
      return request?.protocol === 'ws' || request?.protocol === 'wss';
    }
    function wsConnectionKey(request) {
      return JSON.stringify(['lifecycle', request.id, request.trafficLifecycleId]);
    }
    function applyFilter() { filterCalls++; }
    function closeDetail() {
      selectedRequestId = null;
      selectedRequestLifecycleId = null;
      closeCalls++;
    }
    ${rendererSource.slice(identityStart, identityEnd)}
    function getSelectedTrafficRequest(collection = requests) {
      if (selectedRequestId === null) return null;
      return findTrafficRequestByIdentity(
        collection,
        selectedRequestId,
        selectedRequestLifecycleId
      );
    }
    function trafficActionRequest(requestId = selectedRequestId, trafficLifecycleId) {
      const resolvedLifecycleId = trafficLifecycleId === undefined && requestId === selectedRequestId
        ? selectedRequestLifecycleId
        : trafficLifecycleId;
      return findTrafficRequestByIdentity(requests, requestId, resolvedLifecycleId);
    }
    ${rendererSource.slice(deletionStateStart, deletionStateEnd)}
    ${rendererSource.slice(actionStart, actionEnd)}
  `, context);
  return {
    context,
    fetchCalls,
    toasts,
    snapshot() {
      return JSON.parse(JSON.stringify(vm.runInContext(`({
        requests,
        selectedRequestId,
        selectedRequestLifecycleId,
        requestCounter,
        filterCalls,
        closeCalls,
        inFlight: trafficDeleteInFlight.size
      })`, context)));
    }
  };
}

test('renderer deletes only after server confirmation and applies its broadcast idempotently', async () => {
  let resolveFetch;
  const pendingFetch = new Promise(resolve => { resolveFetch = resolve; });
  const renderer = createRenderer(() => pendingFetch);
  const deleting = renderer.context.deleteSelectedRequest();

  assert.equal(renderer.snapshot().requests.length, 4);
  renderer.context.applyTrafficDeleted('socket', 'old', true);
  resolveFetch(rendererResponse({
    success: true,
    requestId: 'socket',
    trafficLifecycleId: 'old',
    webSocketConnection: true,
    removed: 2
  }));
  await deleting;

  assert.equal(renderer.fetchCalls[0][0], '/api/traffic/socket?trafficLifecycleId=old');
  assert.equal(renderer.fetchCalls[0][1].method, 'DELETE');
  assert.deepEqual(renderer.snapshot(), {
    requests: [
      { id: 'socket', trafficLifecycleId: 'current', protocol: 'wss', pinned: false },
      {
        id: 'current-frame',
        protocol: 'ws-frame',
        parentId: 'socket',
        parentTrafficLifecycleId: 'current'
      }
    ],
    selectedRequestId: null,
    selectedRequestLifecycleId: null,
    requestCounter: 2,
    filterCalls: 1,
    closeCalls: 1,
    inFlight: 0
  });
  assert.deepEqual(renderer.toasts, [{ message: 'Exchange deleted', type: 'success' }]);
});

test('renderer preserves the exchange when authoritative deletion fails', async () => {
  const renderer = createRenderer(async () =>
    rendererResponse({ error: 'delete unavailable' }, { ok: false, status: 503 }));

  await renderer.context.deleteSelectedRequest();

  const state = renderer.snapshot();
  assert.equal(state.requests.length, 4);
  assert.equal(state.selectedRequestId, 'socket');
  assert.equal(state.filterCalls, 0);
  assert.equal(state.closeCalls, 0);
  assert.equal(state.inFlight, 0);
  assert.deepEqual(renderer.toasts, [{
    message: 'Failed to delete exchange: delete unavailable',
    type: 'error'
  }]);
});
