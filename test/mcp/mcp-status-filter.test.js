import assert from 'node:assert/strict';
import test from 'node:test';

import { McpServerBridge, TOOL_DEFINITIONS } from '../../src/mcp/mcp-server.js';

function createBridge({ broadcast = () => {} } = {}) {
  const trafficLog = [
    {
      id: 'ok',
      timestamp: 1,
      method: 'GET',
      statusCode: 200,
      url: 'https://example.test/ok'
    },
    {
      id: 'missing',
      timestamp: 2,
      method: 'GET',
      statusCode: 404,
      url: 'https://example.test/missing'
    },
    {
      id: 'extension',
      timestamp: 3,
      method: 'gEt',
      statusCode: 200,
      url: 'https://example.test/extension'
    }
  ];
  return new McpServerBridge({
    apiServer: {
      trafficLog,
      _broadcast: broadcast,
      _getHarExportTraffic: () => trafficLog
    },
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] }
  });
}

test('MCP search and export reject malformed status filters', () => {
  const bridge = createBridge();

  for (const status of ['', '200junk', '0xC8', '2x', '6xx', '20', '200.0']) {
    assert.throws(() => bridge._handleSearchTraffic({ status }), /exact three-digit code/);
    assert.throws(() => bridge._handleExportTraffic({ status }), /exact three-digit code/);
  }
});

test('MCP search accepts exact and status-range filters', () => {
  const bridge = createBridge();
  const parseRequests = result => JSON.parse(result.content[0].text.split('\n\n')[1]);
  const exact = parseRequests(bridge._handleSearchTraffic({ status: '404' }));
  const range = parseRequests(bridge._handleSearchTraffic({ status: '2XX' }));

  assert.deepEqual(exact.map(request => request.id), ['missing']);
  assert.deepEqual(range.map(request => request.id), ['ok', 'extension']);
});

test('MCP search broadcasts lossless structured filters for renderer parity', () => {
  const broadcasts = [];
  const bridge = createBridge({ broadcast: message => broadcasts.push(message) });

  bridge._handleSearchTraffic({
    method: 'GET',
    status: '2xx',
    host: 'example.test',
    query: 'host:other.test hello world'
  });

  assert.deepEqual(broadcasts, [{
    type: 'mcp-filter',
    filter: 'method:GET status:2xx host:example.test host:other.test hello world',
    filters: {
      method: 'GET',
      status: '2xx',
      host: 'example.test',
      query: 'host:other.test hello world'
    }
  }]);
});

test('MCP search and HAR export preserve extension-method token case', () => {
  const bridge = createBridge();
  const parseRequests = result => JSON.parse(result.content[0].text.split('\n\n')[1]);

  assert.deepEqual(
    parseRequests(bridge._handleSearchTraffic({ method: 'gEt' })).map(request => request.id),
    ['extension']
  );
  assert.deepEqual(parseRequests(bridge._handleSearchTraffic({ method: 'GET' }))
    .map(request => request.id), ['ok', 'missing']);
  assert.deepEqual(parseRequests(bridge._handleSearchTraffic({ method: 'get' })), []);

  const exported = JSON.parse(bridge._handleExportTraffic({ method: 'gEt' }).content[0].text);
  assert.deepEqual(exported.log.entries.map(entry => entry.request.url), [
    'https://example.test/extension'
  ]);
});

test('MCP traffic tools advertise the same strict status grammar they enforce', () => {
  for (const toolName of ['search_traffic', 'export_traffic']) {
    const tool = TOOL_DEFINITIONS.find(definition => definition.name === toolName);
    assert.ok(tool, `${toolName} definition`);
    const pattern = tool.inputSchema.properties.status.pattern;
    const statusPattern = new RegExp(pattern);

    for (const valid of ['200', '404', '1xx', '5XX']) {
      assert.equal(statusPattern.test(valid), true, `${toolName}: ${valid}`);
    }
    for (const invalid of ['200junk', '0xC8', '2x', '6xx', '20', '200.0']) {
      assert.equal(statusPattern.test(invalid), false, `${toolName}: ${invalid}`);
    }
  }
});
