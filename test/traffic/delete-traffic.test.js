import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../../src/api/api-server.js';

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

function requestJson(port, requestPath, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers
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
  assert.match(response.body.trafficGeneration, /^[0-9a-f-]{36}$/i);
  const trafficGeneration = response.body.trafficGeneration;
  assert.deepEqual(response.body, {
    success: true,
    requestId: 'shared',
    trafficLifecycleId: 'old',
    trafficGeneration,
    webSocketConnection: true,
    clearRevision: 0,
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
    trafficGeneration,
    webSocketConnection: true,
    clearRevision: 0,
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

test('DELETE rejects duplicate or nested lifecycle query values before mutation', async t => {
  const api = createApi();
  api.trafficLog = [{ id: 'shared', trafficLifecycleId: 'first' }];
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  for (const query of [
    'trafficLifecycleId=first&trafficLifecycleId=first',
    'trafficLifecycleId%5Bnested%5D=first'
  ]) {
    const response = await requestJson(port, `/api/traffic/shared?${query}`, 'DELETE');
    assert.equal(response.statusCode, 400);
  }
  assert.deepEqual(api.trafficLog, [{ id: 'shared', trafficLifecycleId: 'first' }]);
  assert.deepEqual(broadcasts, []);
});

test('a stale traffic session precondition rejects DELETE before mutation', async t => {
  const api = createApi();
  api.trafficLog = [{ id: 'shared', trafficLifecycleId: 'life-1' }];
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  const response = await requestJson(
    port,
    '/api/traffic/shared?trafficLifecycleId=life-1',
    'DELETE',
    { 'x-http-freekit-traffic-session': 'stale-session' }
  );

  assert.equal(response.statusCode, 409);
  assert.deepEqual(api.trafficLog, [{ id: 'shared', trafficLifecycleId: 'life-1' }]);
  assert.deepEqual(broadcasts, []);
});

test('an empty lifecycle query never deletes a newer same-ID lifecycle', async t => {
  const api = createApi();
  const replacement = { id: 'shared', trafficLifecycleId: 'life-2' };
  api.trafficLog = [replacement];
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  const staleDelete = await requestJson(
    port,
    '/api/traffic/shared?trafficLifecycleId=',
    'DELETE'
  );
  assert.equal(staleDelete.statusCode, 404);
  assert.deepEqual(api.trafficLog, [replacement]);
  assert.deepEqual(broadcasts, []);

  const legacy = { id: 'shared', trafficLifecycleId: null };
  api.trafficLog.unshift(legacy);
  const exactDelete = await requestJson(
    port,
    '/api/traffic/shared?trafficLifecycleId=',
    'DELETE'
  );
  assert.equal(exactDelete.statusCode, 200);
  assert.equal(exactDelete.body.trafficLifecycleId, null);
  assert.deepEqual(api.trafficLog, [replacement]);
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
  assert.equal(api._deletedTrafficIdentities.size, 1);
  assert.deepEqual(broadcasts.map(message => message.type), ['request', 'traffic-deleted']);
});

test('deleting an active WebSocket suppresses later frames and its final update', async t => {
  let now = 0;
  const api = createApi({
    maxClearedPendingTrafficIds: 1,
    clearedPendingTrafficTtlMs: 5,
    clearedPendingTrafficNow: () => now
  });
  const lifecycleToken = Symbol('active-websocket');
  api._broadcast = () => {};
  api.onTrafficEvent({
    id: 'socket',
    trafficLifecycleId: 'socket-lifecycle',
    _trafficLifecycleToken: lifecycleToken,
    _pending: true,
    protocol: 'wss'
  });
  api.onTrafficEvent({
    id: 'socket',
    trafficLifecycleId: 'socket-lifecycle',
    _trafficLifecycleToken: lifecycleToken,
    _trafficLifecycleComplete: false,
    _update: true,
    protocol: 'wss',
    statusCode: 101
  });
  assert.equal(api._pendingTrafficIds.has('socket'), true);

  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));
  const response = await requestJson(
    port,
    '/api/traffic/socket?trafficLifecycleId=socket-lifecycle',
    'DELETE'
  );
  assert.equal(response.statusCode, 200);
  const socketIdentity = api._trafficIdentityKey('socket', 'socket-lifecycle');
  assert.equal(api._deletedTrafficIdentities.get(socketIdentity), Infinity);

  for (const id of ['completed-one', 'completed-two']) {
    api.trafficLog.push({ id, protocol: 'http' });
    const completedResponse = await requestJson(port, `/api/traffic/${id}`, 'DELETE');
    assert.equal(completedResponse.statusCode, 200);
  }
  now = 10;
  api._pruneDeletedTrafficIdentities();
  assert.equal(api._deletedTrafficIdentities.get(socketIdentity), Infinity);

  api.onTrafficEvent({
    id: 'frame-after-delete',
    protocol: 'ws-frame',
    parentId: 'socket',
    parentTrafficLifecycleId: 'socket-lifecycle'
  });
  api.onTrafficEvent({
    id: 'socket',
    trafficLifecycleId: 'socket-lifecycle',
    _update: true,
    protocol: 'wss',
    statusCode: 101,
    duration: 5000
  });

  assert.deepEqual(api.trafficLog, []);
  assert.equal(api._deletedTrafficIdentities.size, 1);
  assert.equal(api._deletedTrafficIdentities.get(socketIdentity), 15);
});

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const identityStart = rendererSource.indexOf('function normalizeTrafficLifecycleId(');
const identityEnd = rendererSource.indexOf('function isSelectedTrafficRequest(', identityStart);
const generationStart = rendererSource.indexOf('function mergeServerTrafficRequest(');
const generationEnd = rendererSource.indexOf('function mergeTrafficDumpPins(', generationStart);
const clearStateStart = rendererSource.indexOf('const appliedTrafficClearIds = new Set();');
const clearStateEnd = rendererSource.indexOf('function applyTrafficPinned(', clearStateStart);
const deletionStateStart = rendererSource.indexOf('function applyTrafficDeleted(');
const deletionStateEnd = rendererSource.indexOf('function connectWebSocket()', deletionStateStart);
const actionStart = rendererSource.indexOf('const trafficDeleteInFlight = new Set();');
const actionEnd = rendererSource.indexOf('function resendSelectedRequest(', actionStart);
assert.notEqual(identityStart, -1);
assert.notEqual(identityEnd, -1);
assert.notEqual(generationStart, -1);
assert.notEqual(generationEnd, -1);
assert.notEqual(clearStateStart, -1);
assert.notEqual(clearStateEnd, -1);
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
      const response = await fetch(...args);
      const trafficGeneration = args[1]?.headers?.['X-HTTP-FreeKit-Traffic-Generation'];
      return {
        ...response,
        json: async () => {
          const body = await response.json();
          return body && typeof body === 'object' &&
              body.trafficGeneration === undefined && trafficGeneration
            ? { ...body, trafficGeneration }
            : body;
        }
      };
    },
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(`
    let requests = [
      {
        id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', pinned: false,
        trafficGeneration: '00000000-0000-4000-8000-000000000001'
      },
      {
        id: 'old-frame', protocol: 'ws-frame', parentId: 'socket',
        parentTrafficLifecycleId: 'old'
      },
      {
        id: 'socket', trafficLifecycleId: 'current', protocol: 'wss', pinned: false,
        trafficGeneration: '00000000-0000-4000-8000-000000000002'
      },
      {
        id: 'current-frame', protocol: 'ws-frame', parentId: 'socket',
        parentTrafficLifecycleId: 'current'
      }
    ];
    let selectedRequestId = 'socket';
    let selectedRequestLifecycleId = 'old';
    let captureStateSessionId = 'session-a';
    let trafficConnectionEpoch = 0;
    let trafficDumpReady = true;
    let requestCounter = requests.length;
    let filterCalls = 0;
    let closeCalls = 0;
    let vsRenderStart = 0;
    let vsRenderEnd = 0;
    const wsExpandedConnections = new Set();
    function isWebSocketConnection(request) {
      return request?.protocol === 'ws' || request?.protocol === 'wss';
    }
    function wsConnectionKey(request) {
      return JSON.stringify(['lifecycle', request.id, request.trafficLifecycleId]);
    }
    function applyFilter() { filterCalls++; }
    function showDetail() {}
    function hydrateDeferredTrafficRequest() {}
    function closeDetail() {
      selectedRequestId = null;
      selectedRequestLifecycleId = null;
      closeCalls++;
    }
    ${rendererSource.slice(identityStart, identityEnd)}
    ${rendererSource.slice(generationStart, generationEnd)}
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
    function restoreTrafficDump(serverRequests) {
      requests = serverRequests.map((request, index) => ({
        trafficGeneration: request.trafficGeneration || 'dump-generation-' + index,
        ...request
      }));
      requestCounter = requests.length;
      applyFilter();
    }
    ${rendererSource.slice(clearStateStart, clearStateEnd)}
    ${rendererSource.slice(deletionStateStart, deletionStateEnd)}
    ${rendererSource.slice(actionStart, actionEnd)}
    let testGenerationCounter = 10;
    globalThis.setRequests = value => {
      requests = value.map(request => {
        if (!request.trafficGeneration) {
          request.trafficGeneration = 'test-generation-' + testGenerationCounter++;
        }
        return request;
      });
    };
    globalThis.setSelection = (requestId, lifecycleId) => {
      selectedRequestId = requestId;
      selectedRequestLifecycleId = lifecycleId;
    };
    globalThis.setTrafficSession = value => { captureStateSessionId = value; };
    globalThis.requestAt = index => requests[index];
    globalThis.serverGenerationAt = index => requests[index]?.trafficGeneration;
    globalThis.unpinAt = index => { delete requests[index].pinned; };
    globalThis.authorizeRequestUpdateAt = (index, value) => {
      requests[index] = mergeTrafficRequestUpdate(requests[index], value);
      return requests[index];
    };
    globalThis.installClearReplacement = (value, revision) => {
      if (!value.trafficGeneration) {
        value.trafficGeneration = 'clear-generation-' + testGenerationCounter++;
      }
      requests = [value];
      latestTrafficClearRevision = revision;
      selectedRequestId = value.id;
      selectedRequestLifecycleId = normalizeTrafficLifecycleId(value.trafficLifecycleId);
    };
  `, context);
  return {
    context,
    fetchCalls,
    toasts,
    snapshot() {
      return JSON.parse(JSON.stringify(vm.runInContext(`({
        requests: requests.map(({ trafficGeneration, ...request }) => request),
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
  renderer.context.applyTrafficDeleted('socket', 'old', true, 0);
  resolveFetch(rendererResponse({
    success: true,
    requestId: 'socket',
    trafficLifecycleId: 'old',
    webSocketConnection: true,
    clearRevision: 0,
    removed: 2
  }));
  await deleting;

  assert.equal(renderer.fetchCalls[0][0], '/api/traffic/socket?trafficLifecycleId=old');
  assert.equal(renderer.fetchCalls[0][1].method, 'DELETE');
  assert.equal(
    renderer.fetchCalls[0][1].headers['X-HTTP-FreeKit-Traffic-Session'],
    'session-a'
  );
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

test('renderer never applies a pending delete response to a reused traffic identity', async () => {
  let resolveFetch;
  const pendingFetch = new Promise(resolve => { resolveFetch = resolve; });
  const renderer = createRenderer(() => pendingFetch);
  renderer.context.setRequests([{
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'ORIGINAL'
  }]);
  renderer.context.setSelection('socket', 'old');
  const deleting = renderer.context.deleteSelectedRequest();

  renderer.context.setRequests([{
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'REPLACEMENT'
  }]);
  resolveFetch(rendererResponse({
    success: true,
    requestId: 'socket',
    trafficLifecycleId: 'old',
    webSocketConnection: true,
    clearRevision: 0,
    removed: 1
  }));
  await deleting;

  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'REPLACEMENT'
  }]);
  assert.deepEqual(renderer.toasts, [{
    message: 'Failed to delete exchange: The exchange changed while deletion was pending.',
    type: 'error'
  }]);
  assert.equal(renderer.snapshot().inFlight, 0);

});

test('an old-session delete response cannot mutate the new renderer session', async () => {
  let resolveFetch;
  const pendingFetch = new Promise(resolve => { resolveFetch = resolve; });
  const renderer = createRenderer(() => pendingFetch);
  renderer.context.setRequests([{
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'CURRENT'
  }]);
  renderer.context.setSelection('socket', 'old');
  const deleting = renderer.context.deleteSelectedRequest();

  renderer.context.setTrafficSession('session-b');
  renderer.context.applyTrafficServerSessionBoundary('session-a', 'session-b');
  renderer.context.setRequests([{
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'NEW-SESSION'
  }]);
  resolveFetch(rendererResponse({
    success: true,
    requestId: 'socket',
    trafficLifecycleId: 'old',
    webSocketConnection: true,
    clearRevision: 0,
    removed: 1
  }));
  await deleting;

  assert.equal(renderer.snapshot().requests[0].marker, 'NEW-SESSION');
  assert.match(renderer.toasts.at(-1).message, /server session changed/i);
});

test('a new server session clears selected traffic before Delete can use an old identity', async () => {
  const renderer = createRenderer(() => assert.fail('pre-dump Delete must not fetch'));
  renderer.context.beginTrafficDumpSync();
  renderer.context.setTrafficSession('session-b');
  assert.equal(
    renderer.context.applyTrafficServerSessionBoundary('session-a', 'session-b'),
    true
  );

  await renderer.context.deleteSelectedRequest();

  assert.deepEqual(renderer.snapshot().requests, []);
  assert.equal(renderer.snapshot().selectedRequestId, null);
  assert.equal(renderer.fetchCalls.length, 0);
});

test('a rejected delete response and late event leave duplicate identities untouched', async () => {
  let resolveFetch;
  const pendingFetch = new Promise(resolve => { resolveFetch = resolve; });
  const renderer = createRenderer(() => pendingFetch);
  renderer.context.setRequests([{
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'ORIGINAL'
  }]);
  renderer.context.setSelection('socket', 'old');
  const original = renderer.context.requestAt(0);
  const deleting = renderer.context.deleteSelectedRequest();
  renderer.context.setRequests([
    original,
    { id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'DUPLICATE' }
  ]);

  resolveFetch(rendererResponse({
    success: true,
    requestId: 'socket',
    trafficLifecycleId: 'old',
    webSocketConnection: true,
    clearRevision: 0,
    removed: 1
  }));
  await deleting;

  assert.equal(renderer.context.applyTrafficDeleted('socket', 'old', true, 0), false);
  assert.equal(renderer.snapshot().requests.length, 2);
  assert.match(renderer.toasts.at(-1).message, /exchange changed/i);
});

test('renderer applies a pending delete broadcast after an authorized generation transfer', async () => {
  let resolveFetch;
  const pendingFetch = new Promise(resolve => { resolveFetch = resolve; });
  const renderer = createRenderer(() => pendingFetch);
  renderer.context.setRequests([{
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'ORIGINAL'
  }]);
  renderer.context.setSelection('socket', 'old');
  const deleting = renderer.context.deleteSelectedRequest();
  renderer.context.authorizeRequestUpdateAt(0, {
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'UPDATED'
  });

  assert.equal(renderer.context.applyTrafficDeleted('socket', 'old', true, 0), true);
  resolveFetch(rendererResponse({
    success: true,
    requestId: 'socket',
    trafficLifecycleId: 'old',
    webSocketConnection: true,
    clearRevision: 0,
    removed: 1
  }));
  await deleting;

  assert.deepEqual(renderer.snapshot().requests, []);
  assert.deepEqual(renderer.toasts, [{ message: 'Exchange deleted', type: 'success' }]);
});

test('a REST-first Clear echo cannot resurrect an exchange deleted after its snapshot', async () => {
  let resolveFetch;
  const pendingFetch = new Promise(resolve => { resolveFetch = resolve; });
  const renderer = createRenderer(() => pendingFetch);
  renderer.context.setRequests([
    { id: 'socket', trafficLifecycleId: 'old', protocol: 'wss' },
    { id: 'retained', trafficLifecycleId: 'keep', protocol: 'http' }
  ]);
  renderer.context.setSelection('socket', 'old');
  assert.equal(renderer.context.applyTrafficCleared('rest-clear', [
    { id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', pinned: true },
    { id: 'retained', trafficLifecycleId: 'keep', protocol: 'http', pinned: true }
  ], 1, 0, 'rest'), true);
  renderer.context.unpinAt(0);
  const deleting = renderer.context.deleteSelectedRequest();

  resolveFetch(rendererResponse({
    success: true,
    requestId: 'socket',
    trafficLifecycleId: 'old',
    webSocketConnection: true,
    clearRevision: 1,
    removed: 1
  }));
  await deleting;
  assert.deepEqual(renderer.snapshot().requests.map(request => request.id), ['retained']);

  assert.equal(renderer.context.applyTrafficClearedMessage({
    type: 'traffic-cleared',
    clearId: 'rest-clear',
    revision: 1,
    pinRevision: 0,
    retainedTraffic: [
      { id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', pinned: true },
      { id: 'retained', trafficLifecycleId: 'keep', protocol: 'http', pinned: true }
    ]
  }), true);
  assert.deepEqual(renderer.snapshot().requests.map(request => request.id), ['retained']);
  assert.equal(renderer.context.applyTrafficDeleted('socket', 'old', true, 1), false);
  assert.deepEqual(renderer.snapshot().requests.map(request => request.id), ['retained']);
});

test('a reused generation Delete event cannot tombstone a REST Clear replay barrier', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  const retainedGeneration = '00000000-0000-4000-8000-0000000000a1';
  const reusedGeneration = '00000000-0000-4000-8000-0000000000b2';
  renderer.context.setRequests([{
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', pinned: true,
    trafficGeneration: retainedGeneration
  }]);
  assert.equal(renderer.context.applyTrafficCleared('generation-barrier', [{
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', pinned: true,
    trafficGeneration: retainedGeneration
  }], 1, 0, 'rest'), true);

  renderer.context.setRequests([{
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'REUSED',
    trafficGeneration: reusedGeneration
  }]);
  assert.equal(renderer.context.applyTrafficDeleted(
    'socket', 'old', true, 1, reusedGeneration
  ), true);
  assert.deepEqual(renderer.snapshot().requests, []);

  assert.equal(renderer.context.applyTrafficClearedMessage({
    type: 'traffic-cleared',
    clearId: 'generation-barrier',
    revision: 1,
    pinRevision: 0,
    retainedTraffic: [{
      id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', pinned: true,
      trafficGeneration: retainedGeneration
    }]
  }), true);
  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', pinned: true
  }]);
  assert.equal(renderer.context.serverGenerationAt(0), retainedGeneration);
});

test('a delayed Delete event cannot remove an exact-identity replacement generation', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  const oldGeneration = '00000000-0000-4000-8000-0000000000a1';
  const replacementGeneration = '00000000-0000-4000-8000-0000000000b2';
  renderer.context.setRequests([{
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'REPLACEMENT',
    trafficGeneration: replacementGeneration
  }]);

  assert.equal(renderer.context.applyTrafficDeleted(
    'socket', 'old', true, 0, oldGeneration
  ), false);
  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'REPLACEMENT'
  }]);
  assert.equal(renderer.context.serverGenerationAt(0), replacementGeneration);
});

test('Delete responses tombstone a REST Clear barrier across queued dump replacement or removal', async () => {
  for (const scenario of ['started-before-replacement', 'started-before-removal', 'started-after']) {
    let resolveFetch;
    const pendingFetch = new Promise(resolve => { resolveFetch = resolve; });
    const renderer = createRenderer(() => pendingFetch);
    renderer.context.setRequests([
      { id: 'socket', trafficLifecycleId: 'old', protocol: 'wss' },
      { id: 'retained', trafficLifecycleId: 'keep', protocol: 'http' }
    ]);
    renderer.context.setSelection('socket', 'old');
    renderer.context.applyTrafficCleared('delete-barrier', [
      { id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', pinned: true },
      { id: 'retained', trafficLifecycleId: 'keep', protocol: 'http', pinned: true }
    ], 1, 0, 'rest');
    const socketGeneration = renderer.context.serverGenerationAt(0);
    const retainedGeneration = renderer.context.serverGenerationAt(1);
    renderer.context.unpinAt(0);

    let deleting;
    if (scenario.startsWith('started-before')) {
      deleting = renderer.context.deleteSelectedRequest();
    }
    renderer.context.setRequests(scenario === 'started-before-removal'
      ? [{ id: 'retained', trafficLifecycleId: 'keep', protocol: 'http', pinned: true }]
      : [
          {
            id: 'socket', trafficLifecycleId: 'old', protocol: 'wss',
            marker: 'QUEUED-DUMP', trafficGeneration: socketGeneration
          },
          {
            id: 'retained', trafficLifecycleId: 'keep', protocol: 'http', pinned: true,
            trafficGeneration: retainedGeneration
          }
        ]);
    if (scenario === 'started-after') {
      renderer.context.setSelection('socket', 'old');
      deleting = renderer.context.deleteSelectedRequest();
    }

    resolveFetch(rendererResponse({
      success: true,
      requestId: 'socket',
      trafficLifecycleId: 'old',
      webSocketConnection: true,
      clearRevision: 1,
      removed: 1
    }));
    await deleting;
    assert.deepEqual(renderer.toasts, [{ message: 'Exchange deleted', type: 'success' }]);

    assert.equal(renderer.context.applyTrafficClearedMessage({
      type: 'traffic-cleared',
      clearId: 'delete-barrier',
      revision: 1,
      pinRevision: 0,
      retainedTraffic: [
        {
          id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', pinned: true,
          trafficGeneration: socketGeneration
        },
        {
          id: 'retained', trafficLifecycleId: 'keep', protocol: 'http', pinned: true,
          trafficGeneration: retainedGeneration
        }
      ]
    }), true);
    assert.deepEqual(renderer.snapshot().requests.map(request => request.id), ['retained']);
    assert.equal(renderer.context.applyTrafficDeleted('socket', 'old', true, 1), false);
  }
});

test('a reconnect dump invalidates an older Delete response and lets its queued event apply', async () => {
  let resolveFetch;
  const pendingFetch = new Promise(resolve => { resolveFetch = resolve; });
  const renderer = createRenderer(() => pendingFetch);
  renderer.context.setRequests([{
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'OLD'
  }]);
  renderer.context.setSelection('socket', 'old');
  const deleting = renderer.context.deleteSelectedRequest();

  renderer.context.beginTrafficDumpSync();
  assert.equal(renderer.context.applyTrafficDumpMessage({
    type: 'traffic-dump',
    sessionId: 'session-a',
    requests: [{
      id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'DUMP'
    }]
  }), true);
  resolveFetch(rendererResponse({
    success: true,
    requestId: 'socket',
    trafficLifecycleId: 'old',
    webSocketConnection: true,
    clearRevision: 0,
    removed: 1
  }));
  await deleting;

  assert.match(renderer.toasts.at(-1).message, /resynchronized/i);
  assert.equal(renderer.context.applyTrafficDeleted('socket', 'old', true, 0), true);
  assert.deepEqual(renderer.snapshot().requests, []);
});

test('a delete response waits for an earlier server Clear epoch and its queued event', async () => {
  let resolveFetch;
  const pendingFetch = new Promise(resolve => { resolveFetch = resolve; });
  const renderer = createRenderer(() => pendingFetch);
  renderer.context.setRequests([{
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss'
  }]);
  renderer.context.setSelection('socket', 'old');
  const deleting = renderer.context.deleteSelectedRequest();

  resolveFetch(rendererResponse({
    success: true,
    requestId: 'socket',
    trafficLifecycleId: 'old',
    webSocketConnection: true,
    clearRevision: 1,
    removed: 1
  }));
  await deleting;
  assert.equal(renderer.snapshot().requests.length, 1);

  assert.equal(renderer.context.applyTrafficClearedMessage({
    type: 'traffic-cleared',
    clearId: 'prior-clear',
    revision: 1,
    pinRevision: 0,
    retainedTraffic: [{
      id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', pinned: true
    }]
  }), true);
  assert.equal(renderer.context.applyTrafficDeleted('socket', 'old', true, 1), true);
  assert.deepEqual(renderer.snapshot().requests, []);
  assert.deepEqual(renderer.toasts, [{ message: 'Exchange deleted', type: 'success' }]);
});

test('a Clear epoch retires stale local delete state before the HTTP response', async () => {
  let resolveFetch;
  const pendingFetch = new Promise(resolve => { resolveFetch = resolve; });
  const renderer = createRenderer(() => pendingFetch);
  renderer.context.setRequests([{
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'ORIGINAL'
  }]);
  renderer.context.setSelection('socket', 'old');
  const deleting = renderer.context.deleteSelectedRequest();

  renderer.context.installClearReplacement({
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss',
    marker: 'REPLACEMENT', pinned: true
  }, 1);
  assert.equal(renderer.context.applyTrafficDeleted('socket', 'old', true, 0), false);
  assert.equal(renderer.context.applyTrafficDeleted('socket', 'old', true, 1), true);
  resolveFetch(rendererResponse({
    success: true,
    requestId: 'socket',
    trafficLifecycleId: 'old',
    webSocketConnection: true,
    clearRevision: 0,
    removed: 1
  }));
  await deleting;

  assert.deepEqual(renderer.snapshot().requests, []);
  assert.match(renderer.toasts.at(-1).message, /exchange changed/i);
});

test('a Clear epoch protects replacement rows without a local delete mutation', () => {
  const renderer = createRenderer(async () => rendererResponse({ success: true }));
  renderer.context.installClearReplacement({
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'REPLACEMENT'
  }, 2);

  assert.equal(renderer.context.applyTrafficDeleted('socket', 'old', true, 1), false);
  assert.equal(renderer.snapshot().requests.length, 1);
  assert.equal(renderer.context.applyTrafficDeleted('socket', 'old', true, 2), true);
  assert.deepEqual(renderer.snapshot().requests, []);
});

test('Clear epochs allow identity reuse before a stale delete response', async () => {
  let resolveFetch;
  const pendingFetch = new Promise(resolve => { resolveFetch = resolve; });
  const renderer = createRenderer(() => pendingFetch);
  renderer.context.setRequests([{
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'ORIGINAL'
  }]);
  renderer.context.setSelection('socket', 'old');
  const deleting = renderer.context.deleteSelectedRequest();

  assert.equal(renderer.context.applyTrafficDeleted('socket', 'old', true, 0), true);
  renderer.context.installClearReplacement({
    id: 'socket', trafficLifecycleId: 'old', protocol: 'wss', marker: 'REPLACEMENT'
  }, 1);
  assert.equal(renderer.context.applyTrafficDeleted('socket', 'old', true, 1), true);
  resolveFetch(rendererResponse({
    success: true,
    requestId: 'socket',
    trafficLifecycleId: 'old',
    webSocketConnection: true,
    clearRevision: 0,
    removed: 1
  }));
  await deleting;

  assert.deepEqual(renderer.snapshot().requests, []);
  assert.match(renderer.toasts.at(-1).message, /exchange changed/i);
});

test('renderer encodes explicit-null delete identity and leaves an in-flight replacement untouched', async () => {
  let renderer;
  renderer = createRenderer(async () => {
    renderer.context.setRequests([{
      id: 'socket', trafficLifecycleId: 'life-2', protocol: 'wss', pinned: false
    }]);
    renderer.context.setSelection('socket', 'life-2');
    return rendererResponse({ error: 'Request not found' }, { ok: false, status: 404 });
  });
  renderer.context.setRequests([{
    id: 'socket', trafficLifecycleId: null, protocol: 'wss', pinned: false
  }]);
  renderer.context.setSelection('socket', null);

  await renderer.context.deleteSelectedRequest();

  assert.equal(renderer.fetchCalls[0][0], '/api/traffic/socket?trafficLifecycleId=');
  assert.deepEqual(renderer.snapshot().requests, [{
    id: 'socket', trafficLifecycleId: 'life-2', protocol: 'wss', pinned: false
  }]);
  assert.deepEqual(renderer.toasts, [{
    message: 'Failed to delete exchange: Request not found',
    type: 'error'
  }]);
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
