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
