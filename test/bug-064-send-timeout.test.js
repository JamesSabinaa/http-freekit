import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { ApiServer } from '../src/api/api-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('Send rejects an origin that accepts the request but never responds', async (t) => {
  const origin = http.createServer(() => {});
  const port = await listen(origin);
  t.after(() => close(origin));
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null, {
    sendConnectTimeoutMs: 1000,
    sendIdleTimeoutMs: 1000,
    sendTotalTimeoutMs: 75
  });

  const startedAt = Date.now();
  await assert.rejects(
    api._sendRequest(`http://127.0.0.1:${port}/hang`, 'GET', {}, ''),
    /Send request timeout after 75ms/
  );
  assert.ok(Date.now() - startedAt < 1000);
});
