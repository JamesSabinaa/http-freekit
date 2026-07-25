import assert from 'node:assert/strict';
import test from 'node:test';
import { McpServerBridge } from '../src/mcp/mcp-server.js';

function createBridge(trafficLog) {
  return new McpServerBridge({
    apiServer: { trafficLog, _broadcast() {} },
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] }
  });
}

test('security scan does not treat lookalike domains as localhost', () => {
  const makeRequest = (id, host) => ({
    id,
    host,
    protocol: 'http',
    statusCode: 200,
    url: `http://${host}/`,
    responseHeaders: {}
  });
  const bridge = createBridge([
    makeRequest('local', 'localhost'),
    makeRequest('local-with-port', '127.0.0.1:8080'),
    makeRequest('lookalike-name', 'localhost.example'),
    makeRequest('lookalike-address', '127.0.0.1.example')
  ]);

  const result = bridge._handleSecurityScan();
  const report = JSON.parse(result.content[0].text);
  const missingHttpsIds = report.issues
    .filter(issue => issue.category === 'Missing HTTPS')
    .map(issue => issue.requestId);

  assert.deepEqual(missingHttpsIds, ['lookalike-name', 'lookalike-address']);
});
