import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { ApiServer } from '../src/api/api-server.js';
import { InterceptorManager } from '../src/interceptors/interceptor-manager.js';

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

test('interceptor manager forwards targeted deactivation options', async () => {
  const manager = Object.create(InterceptorManager.prototype);
  let receivedOptions;
  manager.interceptors = new Map([['android-adb', {
    deactivate: async options => { receivedOptions = options; }
  }]]);

  await manager.deactivate('android-adb', { deviceId: 'device-A' });
  assert.deepEqual(receivedOptions, { deviceId: 'device-A' });
});

test('deactivation API forwards its request body to the manager', async (t) => {
  const calls = [];
  const proxy = { port: 8080, mockRules: [] };
  const interceptors = {
    onStatusChange: null,
    deactivate: async (...args) => calls.push(args)
  };
  const api = new ApiServer(proxy, null, interceptors);
  const server = http.createServer(api.app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const statusCode = await postJson(
    server.address().port,
    '/api/interceptors/jvm/deactivate',
    { pid: '1234' }
  );

  assert.equal(statusCode, 200);
  assert.deepEqual(calls, [['jvm', { pid: '1234' }]]);
});
