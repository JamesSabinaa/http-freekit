import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import express from 'express';

import { ApiServer } from '../../src/api/api-server.js';
import { registerTrafficRoutes } from '../../src/api/routes/traffic-routes.js';

const SCALAR_QUERY_PARAMETERS = [
  { route: '/api/traffic', name: 'limit' },
  { route: '/api/traffic', name: 'offset' },
  { route: '/api/traffic', name: 'filter' },
  { route: '/api/traffic/search', name: 'method' },
  { route: '/api/traffic/search', name: 'status' },
  { route: '/api/traffic/search', name: 'host' },
  { route: '/api/traffic/search', name: 'path' },
  { route: '/api/traffic/search', name: 'source' }
];

function requestJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: requestPath }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    }).once('error', reject);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function trafficFixtures() {
  return [
    {
      id: 'alpha-get',
      method: 'GET',
      statusCode: 200,
      url: 'https://alpha.test/items/1',
      host: 'alpha.test',
      path: '/items/1',
      source: 'proxy'
    },
    {
      id: 'alpha-post',
      method: 'POST',
      statusCode: 404,
      url: 'https://alpha.test/items/2',
      host: 'alpha.test',
      path: '/items/2',
      source: 'import'
    },
    {
      id: 'beta-get',
      method: 'GET',
      statusCode: 204,
      url: 'https://beta.test/health',
      host: 'beta.test',
      path: '/health',
      source: 'proxy'
    }
  ];
}

test('traffic routes reject duplicate and nested forms for every scalar query parameter', async t => {
  const api = new ApiServer({ matchApiSpec: () => null }, null, null);
  api.trafficLog = trafficFixtures();
  const originalTraffic = structuredClone(api.trafficLog);
  let trafficReads = 0;
  api._getTrafficWithoutDefaultExclusions = () => {
    trafficReads++;
    return api.trafficLog;
  };
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  for (const { route, name } of SCALAR_QUERY_PARAMETERS) {
    const expected = { error: `${name} must be a single string query value` };
    const duplicate = await requestJson(port, `${route}?${name}=one&${name}=two`);
    assert.equal(duplicate.statusCode, 400, `${name} duplicate status`);
    assert.deepEqual(duplicate.body, expected, `${name} duplicate response`);

    const nestedName = encodeURIComponent(`${name}[nested]`);
    const nested = await requestJson(port, `${route}?${nestedName}=value`);
    assert.equal(nested.statusCode, 400, `${name} nested status`);
    assert.deepEqual(nested.body, expected, `${name} nested response`);
  }

  assert.equal(trafficReads, 0, 'invalid queries must be rejected before reading traffic');
  assert.deepEqual(api.trafficLog, originalTraffic);
});

test('traffic query validation rejects object values from an extended query parser', async t => {
  const trafficLog = trafficFixtures();
  let trafficReads = 0;
  const api = {
    trafficLog,
    _getTrafficWithoutDefaultExclusions() {
      trafficReads++;
      return trafficLog;
    }
  };
  const app = express();
  app.set('query parser', 'extended');
  const router = express.Router();
  registerTrafficRoutes(router, api);
  app.use(router);
  const server = http.createServer(app);
  const port = await listen(server);
  t.after(() => close(server));

  for (const { route, name } of SCALAR_QUERY_PARAMETERS) {
    const response = await requestJson(port, `${route}?${name}[nested]=value`);
    assert.equal(response.statusCode, 400, `${name} object status`);
    assert.deepEqual(response.body, {
      error: `${name} must be a single string query value`
    }, `${name} object response`);
  }
  assert.equal(trafficReads, 0);
  assert.deepEqual(api.trafficLog, trafficFixtures());
});

test('traffic routes preserve valid filtering, pagination, and search behavior', async t => {
  const api = new ApiServer({ matchApiSpec: () => null }, null, null);
  api.trafficLog = trafficFixtures();
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => close(server));

  const listResponse = await requestJson(
    port,
    '/api/traffic?filter=alpha&offset=1&limit=1'
  );
  assert.equal(listResponse.statusCode, 200);
  assert.equal(listResponse.body.total, 2);
  assert.deepEqual(listResponse.body.requests.map(request => request.id), ['alpha-post']);

  const searchResponse = await requestJson(
    port,
    '/api/traffic/search?method=get&status=2xx&host=alpha&path=%2Fitems&source=proxy'
  );
  assert.equal(searchResponse.statusCode, 200);
  assert.equal(searchResponse.body.total, 1);
  assert.deepEqual(searchResponse.body.requests.map(request => request.id), ['alpha-get']);
});
