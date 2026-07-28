import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for condition'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

test('disconnecting paused HTTP clients removes their breakpoint and traffic lifecycle state', async t => {
  const proxy = new ProxyServer(null, { port: 0 });
  proxy.addBreakpoint({ matchers: [{ type: 'wildcard' }] });
  const events = [];
  const trafficBroadcasts = [];
  const api = new ApiServer(proxy, null, null);
  api._broadcast = event => trafficBroadcasts.push(structuredClone(event));
  proxy.onBreakpoint = event => events.push(event);
  proxy.onRequest = event => api.onTrafficEvent(event);
  await proxy.start();
  t.after(() => proxy.stop());

  for (let index = 0; index < 3; index++) {
    const request = http.request({
      hostname: '127.0.0.1',
      port: proxy.server.address().port,
      path: `http://127.0.0.1:9/paused-${index}`
    });
    request.on('error', () => {});
    request.end();

    await waitFor(() => proxy.pendingBreakpoints.size === 1);
    const requestId = proxy.getPendingBreakpoints()[0].id;
    assert.equal(proxy._pendingTrafficLogDecisions.size, 1);
    request.destroy();
    await waitFor(() => proxy.pendingBreakpoints.size === 0 &&
      proxy._pendingTrafficLogDecisions.size === 0);

    assert.equal(proxy.resumeBreakpoint(requestId), false);
    assert.equal(events.at(-1).type, 'breakpoint-resumed');
    assert.equal(events.at(-1).reason, 'client-disconnected');
    assert.equal(api._pendingTrafficIds.size, 0);
    const terminal = api.trafficLog.find(request => request.id === requestId);
    assert.equal(terminal?.statusCode, 0);
    assert.equal(terminal?.statusMessage, 'Client Disconnected');
    assert.equal(terminal?.method, 'GET');
    assert.equal(terminal?._mergeUpdate, undefined);
  }

  assert.equal(api.trafficLog.length, 3);
  assert.equal(trafficBroadcasts.filter(event => event.type === 'request-update'
    && event.data.statusMessage === 'Client Disconnected').length, 3);
});

test('proxy shutdown clears any remaining traffic lifecycle decisions', async () => {
  const proxy = new ProxyServer(null);
  proxy._pendingTrafficLogDecisions.set('abandoned-request', true);

  await proxy.stop();

  assert.equal(proxy._pendingTrafficLogDecisions.size, 0);
});
