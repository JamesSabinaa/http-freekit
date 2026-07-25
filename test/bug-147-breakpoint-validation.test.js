import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

function requestJson(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

async function createServer(t) {
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { proxy, port: server.address().port };
}

test('breakpoint API rejects non-array matcher state', async t => {
  const { proxy, port } = await createServer(t);
  const result = await requestJson(port, 'POST', '/api/breakpoints', { matchers: {} });

  assert.equal(result.statusCode, 400);
  assert.deepEqual(proxy.breakpointRules, []);
});

test('persisted malformed breakpoint state is ignored at runtime', () => {
  const proxy = new ProxyServer(null);
  proxy.breakpointRules = [
    { enabled: true, matchers: {} },
    { enabled: true, matchers: [null] }
  ];

  assert.doesNotThrow(() => proxy._checkBreakpoint('GET', 'https://example.test', {}));
  assert.equal(proxy._checkBreakpoint('GET', 'https://example.test', {}), undefined);
});

test('invalid resume methods and headers are rejected without releasing the breakpoint', async t => {
  const { proxy, port } = await createServer(t);
  let resolved = false;
  proxy.pendingBreakpoints.set('pending', { resolve: () => { resolved = true; } });

  const method = await requestJson(port, 'POST', '/api/breakpoints/pending/pending/resume', {
    method: 'GET\r\nInjected: yes'
  });
  const header = await requestJson(port, 'POST', '/api/breakpoints/pending/pending/resume', {
    headers: { 'X-Test': 'safe\r\nInjected: yes' }
  });

  assert.equal(method.statusCode, 400);
  assert.equal(header.statusCode, 400);
  assert.equal(resolved, false);
  assert.equal(proxy.pendingBreakpoints.has('pending'), true);
});
