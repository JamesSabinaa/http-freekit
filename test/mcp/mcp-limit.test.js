import assert from 'node:assert/strict';
import test from 'node:test';
import { McpServerBridge } from '../../src/mcp/mcp-server.js';

function createBridge(trafficLog) {
  return new McpServerBridge({
    apiServer: { trafficLog, _broadcast() {} },
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] }
  });
}

test('search traffic clamps negative result limits to one result', () => {
  const trafficLog = Array.from({ length: 6 }, (_, index) => ({
    id: `request-${index}`,
    timestamp: '2026-01-01T00:00:00.000Z'
  }));
  const bridge = createBridge(trafficLog);

  const result = bridge._handleSearchTraffic({ limit: -1 });

  assert.match(result.content[0].text, /showing 1/);
  assert.match(result.content[0].text, /request-5/);
  assert.doesNotMatch(result.content[0].text, /request-4/);
});
