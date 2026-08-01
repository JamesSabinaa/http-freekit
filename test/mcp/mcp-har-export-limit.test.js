import assert from 'node:assert/strict';
import test from 'node:test';

import { McpServerBridge } from '../../src/mcp/mcp-server.js';

const MAX_EXPORT_BYTES = 200 * 1024;

function request(id, overrides = {}) {
  return {
    id,
    timestamp: '2026-01-01T00:00:00.000Z',
    protocol: 'https',
    method: 'GET',
    host: `${id}.example`,
    url: `https://${id}.example/path`,
    statusCode: 200,
    ...overrides
  };
}

function createBridge(requests) {
  return new McpServerBridge({
    apiServer: { _getHarExportTraffic: () => requests },
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] }
  });
}

test('MCP HAR export remains complete JSON below the cap and preserves every filter', () => {
  const matching = request('matching', {
    method: 'POST',
    host: 'api.example',
    url: 'https://api.example/matching',
    statusCode: 201,
    responseBody: '{"ok":true}'
  });
  const bridge = createBridge([
    matching,
    request('wrong-method', { method: 'GET', host: 'api.example', statusCode: 201 }),
    request('wrong-host', { method: 'POST', host: 'other.example', statusCode: 201 }),
    request('wrong-status', { method: 'POST', host: 'api.example', statusCode: 404 })
  ]);

  const result = bridge._handleExportTraffic({ method: 'post', host: 'API.', status: '2xx' });

  assert.notEqual(result.isError, true);
  assert.ok(Buffer.byteLength(result.content[0].text) <= MAX_EXPORT_BYTES);
  const har = JSON.parse(result.content[0].text);
  assert.equal(har.log.version, '1.2');
  assert.deepEqual(har.log.entries.map(entry => entry.request.url), [matching.url]);
  assert.equal(har.log.entries[0].response.content.text, matching.responseBody);
});

test('MCP HAR export rejects one huge body before converting or serializing its entry', () => {
  const huge = request('huge', { responseBody: 'x'.repeat(MAX_EXPORT_BYTES * 3) });
  Object.defineProperty(huge, 'requestHeaders', {
    get() {
      throw new Error('huge entry should not be converted');
    }
  });

  const result = createBridge([huge])._handleExportTraffic({});

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /exceeds the 200 KB MCP response limit/i);
  assert.match(result.content[0].text, /method, host, or status filters/i);
  assert.ok(Buffer.byteLength(result.content[0].text) < 1024);
});

test('MCP HAR export stops incrementally when many small entries cross the cap', () => {
  const requests = Array.from({ length: 1500 }, (_, index) => request(`small-${index}`, {
    responseBody: `payload-${index}-${'x'.repeat(64)}`
  }));
  const unvisited = request('must-not-be-visited');
  Object.defineProperty(unvisited, 'requestHeaders', {
    get() {
      throw new Error('entries after the size limit must not be converted');
    }
  });
  requests.push(unvisited);

  const result = createBridge(requests)._handleExportTraffic({});

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /1501 matching requests/);
  assert.match(result.content[0].text, /narrow the export/i);
  assert.ok(Buffer.byteLength(result.content[0].text) < 1024);
});
