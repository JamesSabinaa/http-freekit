import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: pathname }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    }).once('error', reject);
  });
}

test('traffic pagination rejects negative offsets and limits', async t => {
  const proxy = { port: 8080, mockRules: [], matchApiSpec: () => null };
  const api = new ApiServer(proxy, null, null);
  api.trafficLog = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const negativeOffset = await getJson(port, '/api/traffic?offset=-1');
  const negativeLimit = await getJson(port, '/api/traffic?limit=-1');
  assert.equal(negativeOffset.statusCode, 400);
  assert.equal(negativeLimit.statusCode, 400);
});

test('traffic pagination preserves an explicit zero limit', async t => {
  const proxy = { port: 8080, mockRules: [], matchApiSpec: () => null };
  const api = new ApiServer(proxy, null, null);
  api.trafficLog = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const result = await getJson(server.address().port, '/api/traffic?offset=1&limit=0');
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.total, 3);
  assert.deepEqual(result.body.requests, []);
});
