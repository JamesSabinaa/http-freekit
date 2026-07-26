import assert from 'node:assert/strict';
import test from 'node:test';

import { McpServerBridge } from '../src/mcp/mcp-server.js';

function createBridge(proxyStats) {
  return new McpServerBridge({
    apiServer: { trafficLog: [], _broadcast() {} },
    proxyServer: {
      port: 8080,
      getStats: () => proxyStats
    },
    interceptorManager: { getAll: async () => [] }
  });
}

test('MCP live summary exposes only non-secret upstream proxy metadata', async () => {
  const proxyStats = {
    activeConnections: 2,
    mockRules: 1,
    breakpointRules: 0,
    pendingBreakpoints: 0,
    upstreamProxy: {
      type: 'https',
      host: 'proxy.example',
      port: 8443,
      auth: 'user:secret',
      username: 'another-user',
      password: 'another-secret',
      noProxy: ['internal.example']
    },
    http2Enabled: 'all',
    tlsPassthrough: []
  };
  const originalStats = structuredClone(proxyStats);
  const originalUpstreamProxy = proxyStats.upstreamProxy;
  const bridge = createBridge(proxyStats);

  const result = await bridge._handleGetLiveSummary();
  const serialized = result.content[0].text;
  const summary = JSON.parse(serialized);

  assert.deepEqual(summary.upstreamProxy, {
    type: 'https',
    host: 'proxy.example',
    port: 8443
  });
  assert.doesNotMatch(serialized, /user:secret|another-user|another-secret|internal\.example/);
  assert.strictEqual(proxyStats.upstreamProxy, originalUpstreamProxy);
  assert.deepEqual(proxyStats, originalStats);
});

test('MCP live summary retains a null upstream proxy', async () => {
  const proxyStats = {
    activeConnections: 0,
    mockRules: 0,
    upstreamProxy: null,
    http2Enabled: false,
    tlsPassthrough: []
  };
  const bridge = createBridge(proxyStats);

  const result = await bridge._handleGetLiveSummary();

  assert.equal(JSON.parse(result.content[0].text).upstreamProxy, null);
});
