import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

function requestJson(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      } : undefined
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end(payload || undefined);
  });
}

function pending(trafficLifecycleId, resolved) {
  return {
    method: 'GET',
    url: `https://${trafficLifecycleId}.test/`,
    host: `${trafficLifecycleId}.test`,
    path: '/',
    trafficLifecycleId,
    timestamp: Date.now(),
    resolve: value => resolved.push({ trafficLifecycleId, value })
  };
}

test('duplicate request IDs retain and resume each breakpoint lifecycle independently', async t => {
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const resolved = [];
  proxy._storePendingBreakpoint('duplicate', pending('life-1', resolved));
  proxy._storePendingBreakpoint('duplicate', pending('life-2', resolved));

  assert.equal(proxy.pendingBreakpoints.size, 1, 'storage remains grouped by request ID');
  assert.equal(proxy.getStats().pendingBreakpoints, 2, 'stats count every paused lifecycle');
  assert.deepEqual(
    proxy.getPendingBreakpoints().map(bp => [bp.id, bp.trafficLifecycleId]),
    [['duplicate', 'life-1'], ['duplicate', 'life-2']]
  );

  const port = server.address().port;
  const listed = await requestJson(port, 'GET', '/api/breakpoints/pending');
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(
    listed.body.pending.map(bp => [bp.id, bp.trafficLifecycleId]),
    [['duplicate', 'life-1'], ['duplicate', 'life-2']]
  );

  const exact = await requestJson(
    port,
    'POST',
    '/api/breakpoints/pending/duplicate/resume?trafficLifecycleId=life-2',
    { method: 'POST' }
  );
  assert.equal(exact.statusCode, 200);
  assert.deepEqual(resolved, [{ trafficLifecycleId: 'life-2', value: { method: 'POST' } }]);
  assert.deepEqual(proxy.getPendingBreakpoints().map(bp => bp.trafficLifecycleId), ['life-1']);

  const legacy = await requestJson(
    port,
    'POST',
    '/api/breakpoints/pending/duplicate/resume',
    {}
  );
  assert.equal(legacy.statusCode, 200);
  assert.deepEqual(resolved, [
    { trafficLifecycleId: 'life-2', value: { method: 'POST' } },
    { trafficLifecycleId: 'life-1', value: {} }
  ]);
  assert.equal(proxy.getStats().pendingBreakpoints, 0);
});

test('a lifecycle timeout leaves a duplicate-ID sibling paused', t => {
  let timeoutCallback;
  t.mock.method(globalThis, 'setTimeout', callback => {
    timeoutCallback = callback;
    return { callback };
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});

  const proxy = new ProxyServer(null);
  const resolved = [];
  proxy._storePendingBreakpoint('duplicate', pending('life-1', resolved));
  proxy._storePendingBreakpoint('duplicate', pending('life-2', resolved));
  proxy._setBreakpointTimeout('duplicate', null, 'life-2');

  timeoutCallback();
  assert.deepEqual(resolved, [{ trafficLifecycleId: 'life-2', value: {} }]);
  assert.deepEqual(proxy.getPendingBreakpoints().map(bp => bp.trafficLifecycleId), ['life-1']);
  assert.equal(proxy.resumeBreakpoint('duplicate', {}, 'life-2'), false);
  assert.equal(proxy.resumeBreakpoint('duplicate', {}, 'life-1'), true);
});

test('pending breakpoint listing preserves global arrival order across duplicate IDs', () => {
  const proxy = new ProxyServer(null);
  const resolved = [];

  proxy._storePendingBreakpoint('duplicate', pending('life-a1', resolved));
  proxy._storePendingBreakpoint('other', pending('life-b1', resolved));
  proxy._storePendingBreakpoint('duplicate', pending('life-a2', resolved));

  assert.deepEqual(
    proxy.getPendingBreakpoints().map(bp => [bp.id, bp.trafficLifecycleId]),
    [
      ['duplicate', 'life-a1'],
      ['other', 'life-b1'],
      ['duplicate', 'life-a2']
    ]
  );

  assert.equal(proxy.resumeBreakpoint('duplicate', {}, 'life-a1'), true);
  assert.deepEqual(
    proxy.getPendingBreakpoints().map(bp => [bp.id, bp.trafficLifecycleId]),
    [
      ['other', 'life-b1'],
      ['duplicate', 'life-a2']
    ]
  );
});

test('helper-stored breakpoints do not overtake directly seeded pending entries', () => {
  const proxy = new ProxyServer(null);
  const resolved = [];

  proxy.pendingBreakpoints.set('legacy', pending('legacy-life', resolved));
  proxy._storePendingBreakpoint('new', pending('new-life', resolved));

  assert.deepEqual(
    proxy.getPendingBreakpoints().map(bp => [bp.id, bp.trafficLifecycleId]),
    [
      ['legacy', 'legacy-life'],
      ['new', 'new-life']
    ]
  );
});

test('normal pending breakpoint insertion does not rescan prior entries', () => {
  const proxy = new ProxyServer(null);
  const resolved = [];
  let indexingCalls = 0;
  const indexPending = proxy._indexPendingBreakpointOrder.bind(proxy);
  proxy._indexPendingBreakpointOrder = () => {
    indexingCalls++;
    return indexPending();
  };

  for (let index = 0; index < 1_000; index++) {
    proxy._storePendingBreakpoint(`request-${index}`, pending(`life-${index}`, resolved));
  }

  assert.equal(indexingCalls, 0);
  assert.equal(proxy.getStats().pendingBreakpoints, 1_000);
});

test('alternating direct and helper insertion remains ordered without rescans', () => {
  const proxy = new ProxyServer(null);
  const resolved = [];
  let indexingCalls = 0;
  const indexPending = proxy._indexPendingBreakpointOrder.bind(proxy);
  proxy._indexPendingBreakpointOrder = () => {
    indexingCalls++;
    return indexPending();
  };

  for (let index = 0; index < 1_000; index++) {
    proxy.pendingBreakpoints.set(`direct-${index}`, pending(`direct-life-${index}`, resolved));
    proxy._storePendingBreakpoint(`helper-${index}`, pending(`helper-life-${index}`, resolved));
  }

  const listed = proxy.getPendingBreakpoints();
  assert.equal(indexingCalls, 1, 'only listing scans the final collection');
  assert.deepEqual(listed.slice(0, 4).map(bp => bp.id), [
    'direct-0', 'helper-0', 'direct-1', 'helper-1'
  ]);
  assert.equal(listed.length, 2_000);
});

test('direct deletion and reinsertion assigns a fresh arrival order', () => {
  for (const remove of ['delete', 'clear']) {
    const proxy = new ProxyServer(null);
    const resolved = [];
    const reused = pending('reused-life', resolved);
    proxy.pendingBreakpoints.set('reused', reused);
    proxy._storePendingBreakpoint('middle', pending('middle-life', resolved));
    if (remove === 'delete') proxy.pendingBreakpoints.delete('reused');
    else proxy.pendingBreakpoints.clear();
    proxy._storePendingBreakpoint('last', pending('last-life', resolved));
    proxy.pendingBreakpoints.set('reused', reused);

    const expected = remove === 'delete'
      ? ['middle', 'last', 'reused']
      : ['last', 'reused'];
    assert.deepEqual(proxy.getPendingBreakpoints().map(bp => bp.id), expected);
  }
});

test('direct replacement preserves the order of retained breakpoint objects', () => {
  const proxy = new ProxyServer(null);
  const resolved = [];
  const first = pending('first-life', resolved);
  const added = pending('added-life', resolved);

  proxy.pendingBreakpoints.set('first', first);
  proxy.pendingBreakpoints.set('middle', pending('middle-life', resolved));
  proxy.pendingBreakpoints.set('first', first);

  assert.deepEqual(proxy.getPendingBreakpoints().map(bp => bp.trafficLifecycleId), [
    'first-life', 'middle-life'
  ]);

  proxy.pendingBreakpoints.set('first', [first, added]);

  assert.deepEqual(proxy.getPendingBreakpoints().map(bp => bp.trafficLifecycleId), [
    'first-life', 'middle-life', 'added-life'
  ]);
});

test('pending breakpoint storage remains constructor-compatible with Map', () => {
  const proxy = new ProxyServer(null);
  const resolved = [];
  proxy.pendingBreakpoints.set('first', pending('first-life', resolved));

  const copy = new proxy.pendingBreakpoints.constructor(proxy.pendingBreakpoints);
  copy.set('second', pending('second-life', resolved));

  assert.equal(copy instanceof Map, true);
  assert.deepEqual([...copy.keys()], ['first', 'second']);
});
