import assert from 'node:assert/strict';
import test from 'node:test';

import { McpServerBridge, TOOL_DEFINITIONS } from '../../src/mcp/mcp-server.js';

function createBridge() {
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
    }
  ];
  return new McpServerBridge({
    apiServer: {
      trafficLog,
      _broadcast() {},
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
  assert.deepEqual(range.map(request => request.id), ['ok']);
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
