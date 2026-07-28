import assert from 'node:assert/strict';
import test from 'node:test';

import { McpServerBridge } from '../src/mcp/mcp-server.js';

test('MCP request detail returns complete captured request and response bodies', () => {
  const requestBody = `${'r'.repeat(50 * 1024)}request-tail-token`;
  const responseBody = `${'s'.repeat(50 * 1024)}response-tail-token`;
  const trafficLog = [{
    id: 'large-request',
    method: 'POST',
    url: 'https://body.test/resource',
    requestBody,
    responseBody,
    timestamp: '2026-01-01T00:00:00.000Z'
  }];
  const bridge = new McpServerBridge({
    apiServer: { trafficLog, _broadcast() {} },
    proxyServer: {},
    interceptorManager: {}
  });

  const result = bridge._handleGetRequestDetail({ request_id: 'large-request' });
  const detail = JSON.parse(result.content[0].text);

  assert.equal(detail.requestBody, requestBody);
  assert.equal(detail.responseBody, responseBody);
  assert.match(detail.requestBody, /request-tail-token$/);
  assert.match(detail.responseBody, /response-tail-token$/);
  assert.equal(trafficLog[0].requestBody, requestBody);
  assert.equal(trafficLog[0].responseBody, responseBody);
});
