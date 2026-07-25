import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import WebSocket from 'ws';
import { ApiServer } from '../src/api/api-server.js';

function request(port, path, { token, origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (origin) headers.Origin = origin;
    const req = http.get({ hostname: '127.0.0.1', port, path, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.once('error', reject);
  });
}

function expectWebSocketRejection(url, options, expectedStatus) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.once('unexpected-response', (_request, response) => {
      try {
        assert.equal(response.statusCode, expectedStatus);
        response.resume();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    ws.once('open', () => reject(new Error('WebSocket unexpectedly connected')));
    ws.once('error', () => {});
  });
}

test('management API and WebSocket require the Electron session token', async (t) => {
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null, { authToken: 'session-secret' });
  api.port = 0;
  api.trafficLog = [{ id: 'private-record' }];
  await api.start();
  t.after(() => api.stop());
  const port = api.httpServer.address().port;

  const unauthorized = await request(port, '/api/traffic');
  assert.equal(unauthorized.statusCode, 401);

  const foreignOrigin = await request(port, '/api/traffic', {
    token: 'session-secret',
    origin: 'https://attacker.example'
  });
  assert.equal(foreignOrigin.statusCode, 403);
  assert.equal(foreignOrigin.headers['access-control-allow-origin'], undefined);

  const authorized = await request(port, '/api/traffic', { token: 'session-secret' });
  assert.equal(authorized.statusCode, 200);
  assert.match(authorized.body, /private-record/);

  await expectWebSocketRejection(`ws://127.0.0.1:${port}/ws`, {}, 401);
  await expectWebSocketRejection(
    `ws://127.0.0.1:${port}/ws?authToken=session-secret`,
    { origin: 'https://attacker.example' },
    403
  );

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?authToken=session-secret`);
  t.after(() => ws.close());
  const firstMessage = await new Promise((resolve, reject) => {
    ws.once('message', data => resolve(JSON.parse(data.toString())));
    ws.once('error', reject);
  });
  assert.equal(firstMessage.type, 'init');
});
