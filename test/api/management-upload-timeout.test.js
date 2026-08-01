import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import {
  ApiServer,
  DEFAULT_MANAGEMENT_REQUEST_TIMEOUT_MS
} from '../../src/api/api-server.js';

function createProxy() {
  return {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
}

function request(port, {
  body,
  token,
  origin,
  contentLength = Buffer.byteLength(body)
}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'content-type': 'application/json',
      'content-length': String(contentLength)
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (origin) headers.origin = origin;
    const client = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/timeout-probe',
      method: 'POST',
      headers
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    client.once('error', reject);
    client.end(body);
  });
}

function sendPartialAuthenticatedJson(port, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    let startedAt;
    const guard = setTimeout(() => {
      socket.destroy();
      reject(new Error('Management connection outlived its configured upload timeout'));
    }, timeoutMs);
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', () => {});
    socket.once('connect', () => {
      startedAt = Date.now();
      socket.write(
        'POST /api/timeout-probe HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${port}\r\n` +
        'Authorization: Bearer session-secret\r\n' +
        'Content-Type: application/json\r\n' +
        'Content-Length: 64\r\n' +
        'Connection: keep-alive\r\n' +
        '\r\n' +
        '{"message":"partial'
      );
    });
    socket.once('close', () => {
      clearTimeout(guard);
      resolve({
        elapsedMs: Date.now() - startedAt,
        response: Buffer.concat(chunks).toString('utf8')
      });
    });
  });
}

test('management request timeout uses a validated configurable duration', () => {
  const configured = new ApiServer(createProxy(), null, null, {
    managementRequestTimeoutMs: 75
  });
  assert.equal(configured.managementRequestTimeoutMs, 75);

  for (const invalid of [0, -1, 1.5, '75', Infinity, 0x80000000]) {
    const api = new ApiServer(createProxy(), null, null, {
      managementRequestTimeoutMs: invalid
    });
    assert.equal(api.managementRequestTimeoutMs, DEFAULT_MANAGEMENT_REQUEST_TIMEOUT_MS);
  }
  const defaulted = new ApiServer(createProxy(), null, null);
  assert.equal(defaulted.managementRequestTimeoutMs, DEFAULT_MANAGEMENT_REQUEST_TIMEOUT_MS);
});

test('authenticated incomplete JSON uploads time out before routing', async t => {
  let routeRuns = 0;
  const api = new ApiServer(createProxy(), null, null, {
    authToken: 'session-secret',
    managementRequestTimeoutMs: 75
  });
  api.app.post('/api/timeout-probe', (req, res) => {
    routeRuns++;
    res.json({ received: req.body });
  });
  api.port = 0;
  await api.start();
  t.after(() => api.stop());
  const port = api.httpServer.address().port;

  const timedOut = await sendPartialAuthenticatedJson(port);
  assert.ok(timedOut.elapsedMs < 750, `connection stayed open for ${timedOut.elapsedMs}ms`);
  assert.equal(timedOut.response, '');
  assert.equal(routeRuns, 0);

  const complete = await request(port, {
    token: 'session-secret',
    body: JSON.stringify({ message: 'complete' })
  });
  assert.equal(complete.statusCode, 200);
  assert.deepEqual(JSON.parse(complete.body), { received: { message: 'complete' } });
  assert.equal(routeRuns, 1);

  const unauthorizedMalformed = await request(port, {
    body: '{not-json}'
  });
  assert.equal(unauthorizedMalformed.statusCode, 401);
  assert.equal(routeRuns, 1);

  const forbiddenMalformed = await request(port, {
    token: 'session-secret',
    origin: 'https://attacker.example',
    body: '{not-json}'
  });
  assert.equal(forbiddenMalformed.statusCode, 403);
  assert.equal(forbiddenMalformed.headers['access-control-allow-origin'], undefined);
  assert.equal(routeRuns, 1);

  const oversized = await request(port, {
    token: 'session-secret',
    body: Buffer.alloc(50 * 1024 * 1024 + 1, 0x20)
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(routeRuns, 1);
});
