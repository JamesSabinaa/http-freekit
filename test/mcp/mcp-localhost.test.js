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
    makeRequest('local-trailing-dot', 'localhost.'),
    makeRequest('local-subdomain', 'api.localhost'),
    makeRequest('local-subdomain-trailing-dot', 'api.localhost.'),
    makeRequest('local-with-port', '127.0.0.1:8080'),
    makeRequest('local-loopback-range', '127.0.0.2'),
    makeRequest('local-loopback-range-with-port', '127.255.255.254:8080'),
    makeRequest('local-ipv6-expanded', '[0:0:0:0:0:0:0:1]:8080'),
    makeRequest('local-ipv4-mapped-ipv6', '[::ffff:127.0.0.1]:8080'),
    makeRequest('local-ipv4-mapped-ipv6-expanded', '[0:0:0:0:0:ffff:7f00:1]'),
    makeRequest('lookalike-name', 'localhost.example'),
    makeRequest('lookalike-address', '127.0.0.1.example'),
    makeRequest('path-syntax', 'localhost/path'),
    makeRequest('credential-syntax', 'user@localhost'),
    makeRequest('query-syntax', 'localhost?query'),
    makeRequest('fragment-syntax', 'localhost#fragment'),
    makeRequest('public-address', '128.0.0.1')
  ]);

  const result = bridge._handleSecurityScan();
  const report = JSON.parse(result.content[0].text);
  const missingHttpsIds = report.issues
    .filter(issue => issue.category === 'Missing HTTPS')
    .map(issue => issue.requestId);

  assert.deepEqual(missingHttpsIds, [
    'lookalike-name',
    'lookalike-address',
    'path-syntax',
    'credential-syntax',
    'query-syntax',
    'fragment-syntax',
    'public-address'
  ]);
});
