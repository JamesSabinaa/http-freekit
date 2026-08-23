import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path }, res => {
      res.resume();
      res.once('end', () => resolve(res));
    });
    req.once('error', reject);
  });
}

test('management documents deny framing', async t => {
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy);
  api.port = 0;
  api.app.get('/index.html', (_req, res) => res.type('html').send('<!doctype html>'));
  await api.start();
  t.after(() => api.stop());

  const response = await request(api.httpServer.address().port, '/index.html');

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-security-policy'], "frame-ancestors 'none'");
  assert.equal(response.headers['x-frame-options'], 'DENY');
});
