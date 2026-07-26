import assert from 'node:assert/strict';
import test from 'node:test';

import { McpServerBridge } from '../src/mcp/mcp-server.js';

function request(id, overrides = {}) {
  return {
    id,
    protocol: 'ws',
    method: 'GET',
    statusCode: 101,
    host: 'socket.example',
    url: 'wss://socket.example/chat',
    path: '/chat',
    requestBody: '',
    responseBody: '',
    requestBodySize: 100,
    responseBodySize: 300,
    duration: 50,
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'proxy',
    ...overrides
  };
}

function frame(id, sequence, sizes) {
  return request(id, {
    protocol: 'ws-frame',
    method: 'WS',
    statusCode: 0,
    host: '',
    url: '',
    path: '',
    requestBody: `frame payload ${sequence}`,
    requestBodySize: sizes[0],
    responseBodySize: sizes[1],
    duration: 0,
    source: 'websocket',
    parentId: 'handshake',
    sequence
  });
}

function parseToolJson(result) {
  return JSON.parse(result.content[0].text);
}

function parseSearchRows(result) {
  return JSON.parse(result.content[0].text.split('\n\n')[1]);
}

test('MCP request tools exclude WebSocket frames without removing their details', async () => {
  const trafficLog = [
    request('handshake'),
    frame('frame-1', 1, [11, 13]),
    frame('frame-2', 2, [17, 19])
  ];
  const originalSnapshot = structuredClone(trafficLog);
  const broadcasts = [];
  const bridge = new McpServerBridge({
    apiServer: {
      trafficLog,
      _broadcast(message) { broadcasts.push(message); }
    },
    proxyServer: {
      port: 8080,
      getStats: () => ({
        activeConnections: 3,
        mockRules: 2,
        breakpointRules: 1,
        pendingBreakpoints: 0,
        upstreamProxy: null,
        http2Enabled: 'all',
        tlsPassthrough: []
      })
    },
    interceptorManager: { getAll: async () => [] }
  });

  const allSearch = bridge._handleSearchTraffic({ limit: 50 });
  assert.match(allSearch.content[0].text, /^Found 1 matching requests \(showing 1\)/);
  assert.deepEqual(parseSearchRows(allSearch).map(row => row.id), ['handshake']);

  const frameSearch = bridge._handleSearchTraffic({ query: 'frame payload', limit: 50 });
  assert.match(frameSearch.content[0].text, /^Found 0 matching requests \(showing 0\)/);
  assert.deepEqual(parseSearchRows(frameSearch), []);
  assert.equal(broadcasts.length, 2);

  const stats = parseToolJson(bridge._handleGetTrafficStats());
  assert.equal(stats.totalRequests, 1);
  assert.deepEqual(stats.byMethod, { GET: 1 });
  assert.deepEqual(stats.byStatusRange, {
    '1xx': 1,
    '2xx': 0,
    '3xx': 0,
    '4xx': 0,
    '5xx': 0,
    other: 0
  });
  assert.deepEqual(stats.topHosts, [{ host: 'socket.example', count: 1 }]);
  assert.equal(stats.averageResponseTime, '50ms');
  assert.equal(stats.totalBandwidth, '400 B');
  assert.deepEqual(stats.topSlowEndpoints, [{
    method: 'GET',
    url: 'wss://socket.example/chat',
    duration: '50ms'
  }]);

  const live = parseToolJson(await bridge._handleGetLiveSummary());
  assert.equal(live.totalCapturedRequests, 1);
  assert.equal(live.activeConnections, 3);

  const frameDetail = parseToolJson(bridge._handleGetRequestDetail({ request_id: 'frame-1' }));
  assert.equal(frameDetail.protocol, 'ws-frame');
  assert.equal(frameDetail.parentId, 'handshake');
  assert.strictEqual(bridge.apiServer.trafficLog, trafficLog);
  assert.deepEqual(trafficLog, originalSnapshot);
});
