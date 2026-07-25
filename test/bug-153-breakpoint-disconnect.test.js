import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

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

test('disconnecting a paused HTTP client removes its pending breakpoint', async t => {
  const proxy = new ProxyServer(null, { port: 0 });
  proxy.addBreakpoint({ matchers: [{ type: 'wildcard' }] });
  const events = [];
  proxy.onBreakpoint = event => events.push(event);
  await proxy.start();
  t.after(() => proxy.stop());

  const request = http.request({
    hostname: '127.0.0.1',
    port: proxy.server.address().port,
    path: 'http://127.0.0.1:9/paused'
  });
  request.on('error', () => {});
  request.end();

  await waitFor(() => proxy.pendingBreakpoints.size === 1);
  const requestId = proxy.getPendingBreakpoints()[0].id;
  request.destroy();
  await waitFor(() => proxy.pendingBreakpoints.size === 0);

  assert.equal(proxy.resumeBreakpoint(requestId), false);
  assert.equal(events.at(-1).type, 'breakpoint-resumed');
  assert.equal(events.at(-1).reason, 'client-disconnected');
});
