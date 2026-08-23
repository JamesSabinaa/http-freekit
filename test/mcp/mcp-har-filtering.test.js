import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiServer } from '../../src/api/api-server.js';
import { McpServerBridge } from '../../src/mcp/mcp-server.js';

function request(id, overrides = {}) {
  return {
    id,
    timestamp: '2026-01-01T00:00:00.000Z',
    protocol: 'http',
    method: 'GET',
    host: `${id}.example`,
    url: `http://${id}.example/`,
    statusCode: 200,
    ...overrides
  };
}

function createBridge(settingsValues = {}) {
  const apiServer = Object.create(ApiServer.prototype);
  apiServer.trafficLog = [
    request('ordinary'),
    request('font', { host: 'fonts.gstatic.com', url: 'https://fonts.gstatic.com/font.woff2' }),
    request('tunnel', { protocol: 'tunnel', method: 'CONNECT', url: 'https://tunnel.example/' }),
    request('frame', { protocol: 'ws-frame', method: 'WS', url: '' })
  ];
  apiServer.settings = {
    get(name, fallback) {
      return Object.hasOwn(settingsValues, name) ? settingsValues[name] : fallback;
    }
  };

  return new McpServerBridge({
    apiServer,
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] }
  });
}

function exportedUrls(bridge) {
  const result = bridge._handleExportTraffic({});
  return JSON.parse(result.content[0].text).log.entries.map(entry => entry.request.url);
}

test('MCP HAR export applies the REST traffic filters', () => {
  const bridge = createBridge({ filterSafeFonts: true });

  assert.deepEqual(exportedUrls(bridge), ['http://ordinary.example/']);
});

test('MCP HAR export includes CONNECT tunnels only when REST exports do', () => {
  const bridge = createBridge({ hideTunnelRequests: false });

  assert.deepEqual(exportedUrls(bridge), [
    'http://ordinary.example/',
    'https://fonts.gstatic.com/font.woff2',
    'https://tunnel.example/'
  ]);
});

test('MCP detail and selection cannot bypass active Traffic Lists', () => {
  const bridge = createBridge({
    trafficLists: [
      { id: 'default-exclusions', name: 'Default Exclusions', enabled: false, mode: 'blacklist', patterns: [] },
      { id: 'private', name: 'Private traffic', enabled: true, mode: 'blacklist', patterns: ['hidden.example'] }
    ]
  });
  bridge.apiServer.trafficLog.push(request('hidden', {
    host: 'hidden.example',
    url: 'https://hidden.example/private',
    requestBody: 'secret'
  }));
  const broadcasts = [];
  bridge.apiServer._broadcast = message => broadcasts.push(message);

  const detail = bridge._handleGetRequestDetail({ request_id: 'hidden' });
  const selection = bridge._handleSelectRequest({ request_id: 'hidden' });
  assert.equal(detail.isError, true);
  assert.match(detail.content[0].text, /not found/);
  assert.equal(selection.isError, true);
  assert.match(selection.content[0].text, /not found/);
  assert.deepEqual(broadcasts, []);

  assert.equal(bridge._handleGetRequestDetail({ request_id: 'ordinary' }).isError, undefined);
  assert.equal(bridge._handleSelectRequest({ request_id: 'ordinary' }).isError, undefined);
  assert.equal(broadcasts.length, 1);
});
