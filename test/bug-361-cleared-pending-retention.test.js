import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

function createApi(options = {}) {
  return new ApiServer({ matchApiSpec: () => null }, null, null, options);
}

function pending(id) {
  return { id, method: 'GET', path: '/', host: 'pending.test', _pending: true };
}

test('clear generations suppress completions after bounded tombstone eviction', () => {
  let now = 1_000;
  const api = createApi({
    maxClearedPendingTrafficIds: 3,
    clearedPendingTrafficTtlMs: 60_000,
    clearedPendingTrafficNow: () => now
  });
  const broadcasts = [];
  const generations = new Map();
  api._broadcast = event => broadcasts.push(event);

  for (let index = 1; index <= 5; index++) {
    const event = pending(`pending-${index}`);
    api.onTrafficEvent(event);
    generations.set(event.id, event._trafficClearGeneration);
    api._clearTraffic();
    now++;
  }

  assert.deepEqual([...api._clearedPendingTrafficIds.keys()], [
    'pending-3',
    'pending-4',
    'pending-5'
  ]);
  broadcasts.length = 0;
  for (const id of ['pending-1', 'pending-5']) {
    api.onTrafficEvent({
      id,
      method: 'GET',
      path: '/',
      host: 'pending.test',
      statusCode: 200,
      _trafficClearGeneration: generations.get(id),
      _update: true
    });
  }
  assert.deepEqual(api.trafficLog, []);
  assert.deepEqual(broadcasts, []);
  assert.equal(api._clearedPendingTrafficIds.has('pending-5'), false);
});

test('abandoned cleared pending request tombstones expire', t => {
  let monotonicNow = 1_000;
  let wallNow = 5_000;
  t.mock.method(Date, 'now', () => wallNow);
  const api = createApi({
    maxClearedPendingTrafficIds: 10,
    clearedPendingTrafficTtlMs: 50,
    clearedPendingTrafficNow: () => monotonicNow
  });
  const broadcasts = [];
  api._broadcast = event => broadcasts.push(event);
  const pendingEvent = pending('abandoned');
  api.onTrafficEvent(pendingEvent);
  const generation = pendingEvent._trafficClearGeneration;
  api._clearTraffic();
  assert.equal(api._clearedPendingTrafficIds.has('abandoned'), true);

  wallNow -= 1_000;
  monotonicNow += 50;
  api._pruneClearedPendingTrafficIds();
  assert.equal(api._clearedPendingTrafficIds.has('abandoned'), false);

  broadcasts.length = 0;
  api.onTrafficEvent({
    id: 'abandoned',
    method: 'GET',
    path: '/',
    host: 'pending.test',
    statusCode: 200,
    _trafficClearGeneration: generation,
    _update: true
  });
  assert.deepEqual(api.trafficLog, []);
  assert.deepEqual(broadcasts, []);
});

test('proxy carries clear generations while current evicted requests still complete', () => {
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null, {
    maxClearedPendingTrafficIds: 1,
    clearedPendingTrafficTtlMs: 60_000
  });
  api.maxTrafficLog = 1;
  const broadcasts = [];
  api._broadcast = event => broadcasts.push(structuredClone(event));
  proxy.onRequest = event => api.onTrafficEvent(event);
  const baseEvent = id => ({
    id,
    protocol: 'https',
    method: 'GET',
    url: `https://pending.test/${id}`,
    host: 'pending.test',
    path: `/${id}`,
    requestHeaders: {},
    requestBody: '',
    requestBodySize: 0,
    timestamp: Date.now(),
    source: 'proxy'
  });

  proxy._emitPendingRequest(baseEvent('cleared'));
  assert.equal(typeof proxy._pendingTrafficLogDecisions.get('cleared').trafficClearGeneration,
    'symbol');
  api._clearTraffic();
  api._clearedPendingTrafficIds.clear();
  broadcasts.length = 0;
  proxy._emitRequestUpdate({
    ...baseEvent('cleared'),
    statusCode: 200,
    responseHeaders: {},
    responseBody: '',
    responseBodySize: 0,
    duration: 10
  });
  assert.deepEqual(api.trafficLog, []);
  assert.deepEqual(broadcasts, []);
  assert.equal(proxy._pendingTrafficLogDecisions.size, 0);

  proxy._emitPendingRequest(baseEvent('current'));
  api.onTrafficEvent({ id: 'newer', method: 'GET', timestamp: Date.now() });
  assert.deepEqual(api.trafficLog.map(request => request.id), ['newer']);
  broadcasts.length = 0;
  proxy._emitRequestUpdate({
    ...baseEvent('current'),
    statusCode: 201,
    responseHeaders: {},
    responseBody: '',
    responseBodySize: 0,
    duration: 10
  });

  assert.deepEqual(api.trafficLog.map(request => request.id), ['current']);
  assert.deepEqual(broadcasts.map(event => event.type), ['request']);
  assert.equal(broadcasts[0].data.statusCode, 201);
  assert.equal(JSON.stringify(broadcasts).includes('_trafficClearGeneration'), false);
});

test('overlapping reused IDs keep lifecycle generations and cleanup independent', () => {
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  const broadcasts = [];
  api._broadcast = event => broadcasts.push(structuredClone(event));
  proxy.onRequest = event => api.onTrafficEvent(event);
  const event = (path, timestamp) => ({
    id: 'reused',
    protocol: 'https',
    method: 'GET',
    url: `https://pending.test${path}`,
    host: 'pending.test',
    path,
    requestHeaders: {},
    requestBody: '',
    requestBodySize: 0,
    timestamp,
    source: 'proxy'
  });

  proxy._emitPendingRequest(event('/old', 1_000));
  api._clearTraffic();
  proxy._emitPendingRequest(event('/new', 2_000));
  assert.equal(Array.isArray(proxy._pendingTrafficLogDecisions.get('reused')), true);
  assert.equal(api._pendingTrafficLifecycles.get('reused').size, 1);
  broadcasts.length = 0;

  proxy._emitRequestUpdate({
    ...event('/old', 1_000),
    statusCode: 200,
    responseHeaders: {},
    responseBody: 'old',
    responseBodySize: 3,
    duration: 20
  });

  assert.deepEqual(api.trafficLog.map(record => [record.path, record.statusCode]), [
    ['/new', null]
  ]);
  assert.deepEqual(broadcasts, []);
  assert.equal(api._pendingTrafficIds.has('reused'), true);
  assert.equal(api._pendingTrafficLifecycles.get('reused').size, 1);
  assert.equal(Array.isArray(proxy._pendingTrafficLogDecisions.get('reused')), false);
  assert.equal(proxy._pendingTrafficLogDecisions.get('reused').record.path, '/new');

  proxy._emitRequestUpdate({
    ...event('/new', 2_000),
    statusCode: 201,
    responseHeaders: {},
    responseBody: 'new',
    responseBodySize: 3,
    duration: 10
  });

  assert.deepEqual(api.trafficLog.map(record => [record.path, record.statusCode]), [
    ['/new', 201]
  ]);
  assert.deepEqual(broadcasts.map(event => event.type), ['request-update']);
  assert.equal(api._pendingTrafficIds.size, 0);
  assert.equal(api._pendingTrafficLifecycles.size, 0);
  assert.equal(proxy._pendingTrafficLogDecisions.size, 0);
  assert.equal(JSON.stringify(broadcasts).includes('_trafficLifecycleToken'), false);
});

test('API updates only the matching lifecycle when pending request IDs overlap', () => {
  const api = createApi();
  api._broadcast = () => {};
  const oldToken = Symbol('old');
  const currentToken = Symbol('current');
  api.onTrafficEvent({
    ...pending('reused'), path: '/old', trafficLifecycleId: 'old-lifecycle',
    _trafficLifecycleToken: oldToken
  });
  api.onTrafficEvent({
    ...pending('reused'), path: '/current', trafficLifecycleId: 'current-lifecycle',
    _trafficLifecycleToken: currentToken
  });

  api.onTrafficEvent({
    id: 'reused', path: '/current', statusCode: 201,
    trafficLifecycleId: 'current-lifecycle', _trafficLifecycleToken: currentToken,
    _update: true
  });

  assert.deepEqual(api.trafficLog.map(record => [
    record.trafficLifecycleId, record.path, record.statusCode
  ]), [
    ['old-lifecycle', '/old', undefined],
    ['current-lifecycle', '/current', 201]
  ]);
  assert.equal(api._pendingTrafficIds.has('reused'), true);
  assert.deepEqual([...api._pendingTrafficLifecycles.get('reused')], [oldToken]);
});

test('exact lifecycle IDs bind transformed completions and same-time WebSocket frames', async () => {
  const proxy = new ProxyServer(null);
  const events = [];
  proxy.onRequest = event => events.push(structuredClone(event));
  proxy._shouldSuppressTrafficLog = data => data._pending === true && data.path === '/hidden';
  const startedAt = 1_000;
  const hidden = {
    id: 'reused-socket', protocol: 'ws', method: 'WS',
    url: 'ws://socket.test/hidden', host: 'socket.test', path: '/hidden',
    requestHeaders: {}, requestBody: '', requestBodySize: 0,
    timestamp: startedAt, source: 'proxy'
  };
  const visible = { ...hidden, url: 'ws://socket.test/visible', path: '/visible' };

  assert.equal(proxy._emitPendingRequest(hidden), false);
  assert.equal(proxy._emitPendingRequest(visible), true);
  assert.notEqual(hidden.trafficLifecycleId, visible.trafficLifecycleId);

  const frame = {
    fin: true, rsv1: false, rsv2: false, rsv3: false,
    compressed: false, opcode: 1, masked: false,
    payload: Buffer.from('hello'), timestamp: startedAt + 1
  };
  assert.equal(await proxy._emitWsFrame(
    frame, 'server', hidden.id, 1, null, startedAt, hidden.trafficLifecycleId
  ), false);
  assert.equal(await proxy._emitWsFrame(
    frame, 'server', visible.id, 1, null, startedAt, visible.trafficLifecycleId
  ), true);

  proxy._emitRequestUpdate({
    ...visible,
    method: 'POST', url: 'ws://rewritten.test/result', host: 'rewritten.test', path: '/result',
    originalRequest: { method: 'WS', url: 'ws://socket.test/visible' },
    statusCode: 101, responseHeaders: {}, responseBody: '', responseBodySize: 0,
    duration: 5
  });

  assert.equal(events.length, 3);
  assert.equal(events[1].parentTrafficLifecycleId, visible.trafficLifecycleId);
  assert.equal(events[2].trafficLifecycleId, visible.trafficLifecycleId);
  assert.equal(proxy._pendingTrafficLogDecisions.get(hidden.id).trafficLifecycleId,
    hidden.trafficLifecycleId);

  proxy._emitRequestUpdate({
    ...visible, statusCode: 101, responseHeaders: {}, responseBody: '',
    responseBodySize: 0, duration: 6
  });
  assert.equal(events.length, 3);
  assert.equal(proxy._pendingTrafficLogDecisions.get(hidden.id).trafficLifecycleId,
    hidden.trafficLifecycleId);
});

test('legacy boolean decisions retain FIFO order beside correlated lifecycles', () => {
  for (const legacyDecision of [false, true]) {
    const proxy = new ProxyServer(null);
    const events = [];
    proxy.onRequest = event => events.push(event);
    const correlatedDecision = {
      emitted: true,
      trafficLifecycleId: 'current-lifecycle',
      lifecycleToken: Symbol('current'),
      record: { id: 'mixed', path: '/current', timestamp: 2 }
    };
    proxy._pendingTrafficLogDecisions.set('mixed', [legacyDecision, correlatedDecision]);

    proxy._emitRequestUpdate({
      id: 'mixed', path: '/current', timestamp: 2, statusCode: 500
    });

    assert.equal(events.length, legacyDecision ? 1 : 0);
    assert.equal(proxy._pendingTrafficLogDecisions.get('mixed'), correlatedDecision);
  }
});
