import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../../src/api/api-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function postClear(port, token) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/traffic/clear',
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : undefined
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

test('authenticated clear API returns the same ID that it broadcasts', async t => {
  const proxy = {
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null, { authToken: 'clear-secret' });
  api.trafficLog = [{ id: 'captured' }];
  api._pendingTrafficIds.add('pending');
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  const unauthorized = await postClear(port);
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(api.trafficLog, [{ id: 'captured' }]);
  assert.deepEqual(broadcasts, []);

  const response = await postClear(port, 'clear-secret');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.match(response.body.clearId, /^[0-9a-f-]{36}$/i);
  assert.equal(response.body.revision, 1);
  assert.equal(response.body.pinRevision, 0);
  assert.deepEqual(response.body.retainedTraffic, []);
  assert.deepEqual(api.trafficLog, []);
  assert.equal(api._pendingTrafficIds.size, 0);
  assert.equal(api._clearedPendingTrafficIds.has('pending'), true);
  assert.deepEqual(broadcasts, [{
    type: 'traffic-cleared',
    clearId: response.body.clearId,
    revision: 1,
    pinRevision: 0,
    retainedTraffic: []
  }]);
});

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const stateStart = rendererSource.indexOf('const appliedTrafficClearIds = new Set();');
const stateEnd = rendererSource.indexOf('function connectWebSocket()', stateStart);
const mergeStart = rendererSource.indexOf('function mergeServerTrafficRequest(');
const mergeEnd = rendererSource.indexOf('function mergeTrafficDumpPins(', mergeStart);
const actionStart = rendererSource.indexOf('let trafficClearInFlight = false;');
const actionEnd = rendererSource.indexOf('async function exportTraffic', actionStart);
const messageStart = rendererSource.indexOf('function handleWsMessage(msg)');
const messageEnd = rendererSource.indexOf('// ============ TRAFFIC ============', messageStart);
assert.notEqual(stateStart, -1);
assert.notEqual(stateEnd, -1);
assert.notEqual(mergeStart, -1);
assert.notEqual(mergeEnd, -1);
assert.notEqual(actionStart, -1);
assert.notEqual(actionEnd, -1);
assert.notEqual(messageStart, -1);
assert.notEqual(messageEnd, -1);
assert.match(
  rendererSource.slice(messageStart, messageEnd),
  /case 'traffic-cleared':\s*applyTrafficClearedMessage\(msg\)/
);

function rendererResponse(body, { ok = true, status = ok ? 200 : 500 } = {}) {
  return { ok, status, json: async () => body };
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createRenderer(fetch) {
  const toasts = [];
  const context = {
    API_BASE: '',
    fetch,
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(`
    let requests = [
      { id: 'remove-me', pinned: false },
      { id: 'keep-me', pinned: true }
    ];
    let filteredRequests = [...requests];
    let selectedRequestId = 'remove-me';
    let selectedRequestLifecycleId = null;
    let requestCounter = requests.length;
    let vsRenderStart = 4;
    let vsRenderEnd = 8;
    let wsFramesByParent = { parent: [{ id: 'frame' }] };
    let filterCalls = 0;
    let closeCalls = 0;
    function applyFilter() {
      wsFramesByParent = {};
      filteredRequests = [...requests];
      filterCalls++;
    }
    function closeDetail() {
      selectedRequestId = null;
      selectedRequestLifecycleId = null;
      closeCalls++;
    }
    function getSelectedTrafficRequest(collection = requests) {
      if (selectedRequestId === null) return null;
      return collection.find(request =>
        request.id === selectedRequestId &&
        (request.trafficLifecycleId || null) === selectedRequestLifecycleId
      ) || null;
    }
    function trafficRequestIdentityKey(request) {
      return JSON.stringify([
        String(request?.id || ''),
        request?.trafficLifecycleId || null
      ]);
    }
    function showDetail() {}
    function hydrateDeferredTrafficRequest() {}
    ${rendererSource.slice(mergeStart, mergeEnd)}
    ${rendererSource.slice(stateStart, stateEnd)}
    ${rendererSource.slice(actionStart, actionEnd)}
  `, context);
  return {
    context,
    toasts,
    snapshot() {
      return JSON.parse(JSON.stringify(vm.runInContext(`({
        requests,
        filteredRequests,
        selectedRequestId,
        requestCounter,
        vsRenderStart,
        vsRenderEnd,
        wsFramesByParent,
        filterCalls,
        closeCalls,
        trafficClearInFlight
      })`, context)));
    }
  };
}

test('disconnected renderer clears through REST and reports confirmed success', async () => {
  const calls = [];
  const renderer = createRenderer(async (url, options) => {
    calls.push({ url, options });
    return rendererResponse({
      success: true,
      clearId: 'disconnected-clear',
      retainedTraffic: [{ id: 'keep-me', trafficLifecycleId: null }]
    });
  });

  await renderer.context.clearTraffic();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/traffic/clear');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(renderer.snapshot(), {
    requests: [{ id: 'keep-me', pinned: true }],
    filteredRequests: [{ id: 'keep-me', pinned: true }],
    selectedRequestId: null,
    requestCounter: 1,
    vsRenderStart: -1,
    vsRenderEnd: -1,
    wsFramesByParent: {},
    filterCalls: 1,
    closeCalls: 1,
    trafficClearInFlight: false
  });
  assert.deepEqual(renderer.toasts, [{ message: 'Traffic cleared', type: 'success' }]);
});

test('renderer clear failure preserves traffic and reports only the error', async () => {
  const renderer = createRenderer(async () =>
    rendererResponse({ error: 'clear unavailable' }, { ok: false, status: 503 }));

  await renderer.context.clearTraffic();

  const state = renderer.snapshot();
  assert.equal(state.requests.length, 2);
  assert.equal(state.selectedRequestId, 'remove-me');
  assert.equal(state.filterCalls, 0);
  assert.equal(state.closeCalls, 0);
  assert.equal(state.trafficClearInFlight, false);
  assert.deepEqual(renderer.toasts, [{
    message: 'Failed to clear traffic: clear unavailable',
    type: 'error'
  }]);
});

test('connected renderer applies a REST clear and its broadcast exactly once in either order', async () => {
  for (const first of ['broadcast', 'response']) {
    const pendingResponse = deferred();
    const renderer = createRenderer(() => pendingResponse.promise);
    const clearing = renderer.context.clearTraffic();

    if (first === 'broadcast') {
      renderer.context.applyTrafficCleared('connected-clear', [
        { id: 'keep-me', trafficLifecycleId: null }
      ]);
      pendingResponse.resolve(rendererResponse({
        success: true,
        clearId: 'connected-clear',
        retainedTraffic: [{ id: 'keep-me', trafficLifecycleId: null }]
      }));
      await clearing;
    } else {
      pendingResponse.resolve(rendererResponse({
        success: true,
        clearId: 'connected-clear',
        retainedTraffic: [{ id: 'keep-me', trafficLifecycleId: null }]
      }));
      await clearing;
      renderer.context.applyTrafficCleared('connected-clear', [
        { id: 'keep-me', trafficLifecycleId: null }
      ]);
    }

    const state = renderer.snapshot();
    assert.equal(state.filterCalls, 1, first);
    assert.equal(state.closeCalls, 1, first);
    assert.deepEqual(state.requests, [{ id: 'keep-me', pinned: true }], first);
    assert.deepEqual(renderer.toasts, [{ message: 'Traffic cleared', type: 'success' }], first);
  }
});
