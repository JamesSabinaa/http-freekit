import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';

function postActivation(port, interceptorId) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: `/api/interceptors/${interceptorId}/activate`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': 2
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end('{}');
  });
}

async function startApi(t, activate) {
  const proxy = { port: 8080, mockRules: [] };
  const interceptors = { onStatusChange: null, activate };
  const api = new ApiServer(proxy, null, interceptors);
  const server = http.createServer(api.app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

test('failed interceptor activation returns a non-success HTTP status', async t => {
  const result = { success: false, error: 'Device missing-device not found' };
  const port = await startApi(t, async () => result);

  const response = await postActivation(port, 'android-adb');

  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.body, result);
});

test('metadata-only activation remains an HTTP success', async t => {
  const result = {
    success: true,
    metadata: { requiresDeviceSelection: true, devices: [] }
  };
  const port = await startApi(t, async () => result);

  const response = await postActivation(port, 'android-adb');

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, result);
});
