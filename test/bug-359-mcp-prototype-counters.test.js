import assert from 'node:assert/strict';
import test from 'node:test';

import { McpServerBridge } from '../src/mcp/mcp-server.js';

function request(method, host, statusCode, protocol = 'http') {
  return {
    protocol,
    method,
    host,
    statusCode,
    url: `http://${host}/`,
    requestBodySize: 1,
    responseBodySize: 1
  };
}

function parseStats(trafficLog) {
  const bridge = new McpServerBridge({
    apiServer: { trafficLog, _broadcast() {} },
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] }
  });
  return JSON.parse(bridge._handleGetTrafficStats().content[0].text);
}

test('MCP traffic counters treat prototype-named methods and hosts as ordinary keys', () => {
  const stats = parseStats([
    request('constructor', 'toString', 101),
    request('constructor', 'toString', 200),
    request('toString', '__proto__', 302),
    request('__proto__', '__proto__', 404),
    request('__proto__', 'constructor', 503),
    request('GET', 'normal.example', 0),
    request('constructor', 'toString', 200, 'ws-frame')
  ]);

  assert.equal(Object.getPrototypeOf(stats.byMethod), Object.prototype);
  assert.deepEqual(stats.byMethod, Object.fromEntries([
    ['constructor', 2],
    ['toString', 1],
    ['__proto__', 2],
    ['GET', 1]
  ]));
  for (const method of ['constructor', 'toString', '__proto__', 'GET']) {
    assert.equal(Object.hasOwn(stats.byMethod, method), true);
    assert.equal(typeof stats.byMethod[method], 'number');
  }

  const hostCounts = Object.fromEntries(stats.topHosts.map(({ host, count }) => [host, count]));
  assert.deepEqual(hostCounts, Object.fromEntries([
    ['toString', 2],
    ['__proto__', 2],
    ['constructor', 1],
    ['normal.example', 1]
  ]));
  for (const count of Object.values(hostCounts)) assert.equal(typeof count, 'number');

  assert.equal(stats.totalRequests, 6);
  assert.deepEqual(stats.byStatusRange, {
    '1xx': 1,
    '2xx': 1,
    '3xx': 1,
    '4xx': 1,
    '5xx': 1,
    other: 1
  });
  assert.equal(stats.totalBandwidth, '12 B');
});
