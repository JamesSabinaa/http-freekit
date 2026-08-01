import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';

function traffic(id, path) {
  return {
    id,
    timestamp: '2026-07-26T12:00:00.000Z',
    protocol: 'https',
    method: 'GET',
    url: `https://example.test${path}`,
    host: 'example.test',
    path,
    requestHeaders: {},
    responseHeaders: {},
    statusCode: 200
  };
}

function requestJson(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: payload === null ? {} : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: response.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    request.once('error', reject);
    request.end(payload);
  });
}

async function createApi(t, maxTrafficLog = 10_000) {
  const proxy = {
    port: 8080,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null);
  api.maxTrafficLog = maxTrafficLog;
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { api, port: server.address().port };
}

async function importTraffic(port, requests) {
  return requestJson(port, 'POST', '/api/traffic/import', { requests });
}

async function getTraffic(port, id) {
  return requestJson(port, 'GET', `/api/traffic/${encodeURIComponent(id)}`);
}

test('JSON import remaps intra-batch duplicates while preserving stable IDs and input', async t => {
  const { api, port } = await createApi(t);
  const submitted = [
    traffic('duplicate', '/first'),
    traffic('stable', '/stable'),
    traffic('duplicate', '/second')
  ];
  let parsedRequestBody;
  const appendImportedTraffic = api._appendImportedTraffic.bind(api);
  api._appendImportedTraffic = requests => {
    parsedRequestBody = requests;
    return appendImportedTraffic(requests);
  };

  const response = await importTraffic(port, submitted);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(parsedRequestBody.map(request => request.id), ['duplicate', 'stable', 'duplicate']);
  assert.deepEqual(submitted.map(request => request.id), ['duplicate', 'stable', 'duplicate']);
  assert.equal(api.trafficLog[0].id, 'duplicate');
  assert.equal(api.trafficLog[1].id, 'stable');
  assert.notEqual(api.trafficLog[2].id, 'duplicate');
  assert.match(api.trafficLog[2].id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
  assert.equal(new Set(api.trafficLog.map(request => request.id)).size, 3);

  for (const request of api.trafficLog) {
    const detail = await getTraffic(port, request.id);
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.body.path, request.path);
  }
});

test('existing collisions remap without consuming a later stable batch ID', async t => {
  const { api, port } = await createApi(t);
  const existingId = '00000000-0000-4000-8000-000000000001';
  const stableId = '00000000-0000-4000-8000-000000000002';
  const generatedId = '00000000-0000-4000-8000-000000000003';
  const generatedCandidates = [stableId, existingId, generatedId];
  t.mock.method(crypto, 'randomUUID', () => generatedCandidates.shift());
  api.trafficLog.push(traffic(existingId, '/existing'));

  const response = await importTraffic(port, [
    traffic(existingId, '/imported-collision'),
    traffic(stableId, '/stable')
  ]);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(api.trafficLog.map(request => request.id), [existingId, generatedId, stableId]);
  assert.equal((await getTraffic(port, existingId)).body.path, '/existing');
  assert.equal((await getTraffic(port, generatedId)).body.path, '/imported-collision');
  assert.equal((await getTraffic(port, stableId)).body.path, '/stable');
  assert.deepEqual(generatedCandidates, []);
});

test('capped imports keep every retained record independently addressable', async t => {
  const { api, port } = await createApi(t, 3);
  api.trafficLog.push(
    traffic('evicted-current', '/evicted-current'),
    traffic('retained-current', '/retained-current')
  );
  const submitted = [
    traffic('evicted-current', '/imported-collision'),
    traffic('stable-tail', '/stable-tail')
  ];

  const response = await importTraffic(port, submitted);

  assert.equal(response.statusCode, 200);
  assert.equal(api.trafficLog.length, 3);
  assert.equal(api.trafficLog[0].id, 'retained-current');
  assert.notEqual(api.trafficLog[1].id, 'evicted-current');
  assert.equal(api.trafficLog[2].id, 'stable-tail');
  assert.equal(new Set(api.trafficLog.map(request => request.id)).size, 3);
  assert.deepEqual(submitted.map(request => request.id), ['evicted-current', 'stable-tail']);
  assert.equal((await getTraffic(port, 'evicted-current')).statusCode, 404);
  assert.equal((await getTraffic(port, api.trafficLog[1].id)).body.path, '/imported-collision');
  assert.equal((await getTraffic(port, 'stable-tail')).body.path, '/stable-tail');
});
