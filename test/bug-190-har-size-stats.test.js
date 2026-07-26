import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../src/api/api-server.js';
import { McpServerBridge } from '../src/mcp/mcp-server.js';

function postHar(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/traffic/import-har',
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
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

function harEntry(requestBodySize, responseBodySize) {
  return {
    startedDateTime: '2026-01-01T00:00:00.000Z',
    time: 1,
    request: {
      method: 'GET',
      url: 'https://example.test/',
      headers: [],
      bodySize: requestBodySize
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: [],
      content: { size: responseBodySize }
    }
  };
}

test('API HAR import normalizes unknown and malformed body sizes', async t => {
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

  const response = await postHar(server.address().port, {
    log: {
      entries: [
        harEntry(-1, -1),
        harEntry(0, 1024),
        harEntry('Infinity', null)
      ]
    }
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(api.trafficLog.map(record => [record.requestBodySize, record.responseBodySize]), [
    [0, 0],
    [0, 1024],
    [0, 0]
  ]);
});

test('renderer HAR mapping applies the same body-size normalization', () => {
  const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const functionStart = rendererSource.indexOf('function normalizeHarBodySize(');
  const functionEnd = rendererSource.indexOf('function importHar(', functionStart);
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);

  const context = {};
  vm.createContext(context);
  vm.runInContext(`
    ${rendererSource.slice(functionStart, functionEnd)}
    results = [
      normalizeHarBodySize(-1),
      normalizeHarBodySize(NaN),
      normalizeHarBodySize(Infinity),
      normalizeHarBodySize('1024'),
      normalizeHarBodySize(0),
      normalizeHarBodySize(1024)
    ];
  `, context);

  assert.deepEqual(Array.from(context.results), [0, 0, 0, 0, 0, 1024]);
});

test('MCP bandwidth stats ignore invalid legacy sizes without undercounting valid bytes', () => {
  const apiServer = Object.create(ApiServer.prototype);
  apiServer.trafficLog = [
    harEntryForStats(-1, 1024),
    harEntryForStats(512, 0),
    harEntryForStats(Number.NaN, Number.POSITIVE_INFINITY),
    harEntryForStats('2048', Number.NEGATIVE_INFINITY)
  ];

  const bridge = new McpServerBridge({
    apiServer,
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] }
  });
  const stats = JSON.parse(bridge._handleGetTrafficStats().content[0].text);

  assert.equal(stats.totalBandwidth, '1.5 KB');

  apiServer.trafficLog = [harEntryForStats(-1, Number.NaN)];
  const invalidOnlyStats = JSON.parse(bridge._handleGetTrafficStats().content[0].text);
  assert.equal(invalidOnlyStats.totalBandwidth, '0 B');
});

function harEntryForStats(requestBodySize, responseBodySize) {
  return {
    method: 'GET',
    statusCode: 200,
    host: 'example.test',
    url: 'https://example.test/',
    duration: 1,
    requestBodySize,
    responseBodySize
  };
}
