import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { ApiServer } from '../src/api/api-server.js';
import { trafficToHar } from '../src/api/har-converter.js';

function postJson(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/traffic/import',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    req.once('error', reject);
    req.end(payload);
  });
}

test('traffic import rejects records that would break HAR and MCP consumers', async (t) => {
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const missingTimestamp = await postJson(port, { requests: [{ id: 'x' }] });
  assert.equal(missingTimestamp.statusCode, 400);
  assert.match(missingTimestamp.body.error, /timestamp/);

  const invalidBody = await postJson(port, {
    requests: [{ id: 'x', timestamp: Date.now(), requestBody: { nested: true } }]
  });
  assert.equal(invalidBody.statusCode, 400);
  assert.match(invalidBody.body.error, /requestBody/);
  assert.deepEqual(api.trafficLog, []);

  const valid = await postJson(port, {
    requests: [{ id: 'valid', timestamp: Date.now(), requestBody: 'text' }]
  });
  assert.equal(valid.statusCode, 200);
  assert.equal(api.trafficLog.length, 1);
  assert.doesNotThrow(() => trafficToHar(api.trafficLog));
});
