import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';

function createApi() {
  return new ApiServer({
    on() {},
    getStats() { return {}; },
    getBreakpoints() { return []; },
    getPendingBreakpoints() { return []; }
  }, null, null);
}

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
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString())
      }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

test('large valid JSON imports avoid argument limits and keep the newest records', async t => {
  const api = createApi();
  api.port = 0;
  await api.start();
  t.after(() => api.stop());

  const requests = Array.from({ length: 130_000 }, (_, index) => ({
    id: `request-${index}`,
    timestamp: 0
  }));
  const result = await postJson(api.httpServer.address().port, '/api/traffic/import', { requests });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.imported, requests.length);
  assert.equal(api.trafficLog.length, api.maxTrafficLog);
  assert.equal(api.trafficLog[0].id, 'request-120000');
  assert.equal(api.trafficLog.at(-1).id, 'request-129999');
});

test('import trimming uses one bounded pass and preserves the traffic array', () => {
  const api = createApi();
  api.maxTrafficLog = 3;
  api.trafficLog.push({ id: 'oldest' }, { id: 'newer' });
  const originalLog = api.trafficLog;

  api._appendImportedTraffic([{ id: 'one' }, { id: 'two' }]);

  assert.strictEqual(api.trafficLog, originalLog);
  assert.deepEqual(api.trafficLog.map(request => request.id), ['newer', 'one', 'two']);
});

test('import trimming removes WebSocket frames before connection parents', () => {
  const api = createApi();
  api.maxTrafficLog = 3;
  const originalLog = api.trafficLog;
  api.trafficLog.push(
    { id: 'socket', protocol: 'ws' },
    { id: 'old-frame', protocol: 'ws-frame', parentId: 'socket' }
  );

  api._appendImportedTraffic([{ id: 'one' }, { id: 'two' }]);

  assert.equal(api.trafficLog, originalLog);
  assert.deepEqual(api.trafficLog.map(request => request.id), ['socket', 'one', 'two']);

  api.trafficLog.length = 0;
  api._appendImportedTraffic([
    { id: 'imported-socket', protocol: 'ws' },
    { id: 'frame-1', protocol: 'ws-frame', parentId: 'imported-socket' },
    { id: 'frame-2', protocol: 'ws-frame', parentId: 'imported-socket' },
    { id: 'frame-3', protocol: 'ws-frame', parentId: 'imported-socket' }
  ]);
  assert.deepEqual(api.trafficLog.map(request => request.id), [
    'imported-socket', 'frame-2', 'frame-3'
  ]);
});
