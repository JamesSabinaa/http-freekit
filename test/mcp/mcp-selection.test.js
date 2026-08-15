import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { McpServerBridge, TOOL_DEFINITIONS } from '../../src/mcp/mcp-server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');

test('MCP selection opens an already-selected request instead of toggling it closed', () => {
  assert.match(app, /function selectRequest\(id, toggle = true, trafficLifecycleId\)/);
  assert.match(app, /if \(isSelectedTrafficRequest\(req\) && toggle\)/);
  assert.match(app, /selectRequest\([\s\S]*?msg\.requestId,[\s\S]*?false,[\s\S]*?msg\.trafficLifecycleId/);
});

function createBridge(trafficLog, broadcasts) {
  return new McpServerBridge({
    apiServer: {
      trafficLog,
      _broadcast: message => broadcasts.push(message)
    },
    proxyServer: {},
    interceptorManager: {},
    options: { enabled: false }
  });
}

function parseSearchRows(result) {
  return JSON.parse(result.content[0].text.split('\n\n')[1]);
}

test('MCP search exposes lifecycle IDs and select_request accepts one', () => {
  const broadcasts = [];
  const trafficLog = [
    {
      id: 'duplicate', trafficLifecycleId: 'life-1', method: 'GET',
      url: 'https://one.test/', host: 'one.test', path: '/', timestamp: 1
    },
    {
      id: 'duplicate', trafficLifecycleId: 'life-2', method: 'POST',
      url: 'https://two.test/', host: 'two.test', path: '/', timestamp: 2
    }
  ];
  const bridge = createBridge(trafficLog, broadcasts);
  const selectTool = TOOL_DEFINITIONS.find(tool => tool.name === 'select_request');
  const detailTool = TOOL_DEFINITIONS.find(tool => tool.name === 'get_request_detail');

  assert.deepEqual(selectTool.inputSchema.properties.traffic_lifecycle_id.anyOf, [
    { type: 'string', minLength: 1 },
    { type: 'null' }
  ]);
  assert.deepEqual(detailTool.inputSchema.properties.traffic_lifecycle_id.anyOf, [
    { type: 'string', minLength: 1 },
    { type: 'null' }
  ]);
  assert.match(detailTool.description, /traffic_lifecycle_id from search_traffic/);
  const searchResult = bridge._handleSearchTraffic({ limit: 10 });
  const searchRows = parseSearchRows(searchResult);
  assert.equal(searchRows[1].traffic_lifecycle_id, 'life-2');
  assert.equal(searchRows[1].trafficLifecycleId, 'life-2');

  const result = bridge._handleSelectRequest({
    request_id: 'duplicate',
    traffic_lifecycle_id: 'life-2'
  });

  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /POST https:\/\/two\.test\//);
  assert.deepEqual(broadcasts.at(-1), {
    type: 'mcp-select',
    requestId: 'duplicate',
    trafficLifecycleId: 'life-2'
  });
});

test('MCP request detail targets an exact reused lifecycle, including body pages', () => {
  const bridge = createBridge([
    {
      id: 'duplicate', trafficLifecycleId: 'life-1', method: 'POST',
      url: 'https://one.test/', requestBody: 'old-body', responseBody: 'old-response',
      timestamp: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'duplicate', trafficLifecycleId: 'life-2', method: 'PUT',
      url: 'https://two.test/', requestBody: 'new-body', responseBody: 'new-response',
      timestamp: '2026-01-02T00:00:00.000Z'
    }
  ], []);

  const detailResult = bridge._handleGetRequestDetail({
    request_id: 'duplicate',
    traffic_lifecycle_id: 'life-2'
  });
  assert.equal(detailResult.isError, undefined);
  const detail = JSON.parse(detailResult.content[0].text);
  assert.equal(detail.method, 'PUT');
  assert.equal(detail.requestBody, 'new-body');
  assert.equal(detail.responseBody, 'new-response');
  assert.equal(detail.traffic_lifecycle_id, 'life-2');

  const pageResult = bridge._handleGetRequestDetail({
    request_id: 'duplicate',
    traffic_lifecycle_id: 'life-1',
    body_side: 'response',
    body_offset: 4,
    body_limit: 4
  });
  assert.equal(pageResult.isError, undefined);
  const pageDetail = JSON.parse(pageResult.content[0].text);
  assert.equal(pageDetail.traffic_lifecycle_id, 'life-1');
  assert.equal(pageDetail.bodyPage.content, 'resp');
});

test('MCP request detail rejects an ambiguous reused ID instead of returning the oldest body', () => {
  const bridge = createBridge([
    {
      id: 'duplicate', trafficLifecycleId: 'life-1', method: 'POST',
      requestBody: 'old-secret', timestamp: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'duplicate', trafficLifecycleId: 'life-2', method: 'POST',
      requestBody: 'new-secret', timestamp: '2026-01-02T00:00:00.000Z'
    }
  ], []);

  const result = bridge._handleGetRequestDetail({ request_id: 'duplicate' });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Multiple request lifecycles/);
  assert.match(result.content[0].text, /provide traffic_lifecycle_id from search_traffic/);
  assert.doesNotMatch(result.content[0].text, /old-secret|new-secret/);
});

test('MCP request detail rejects missing and duplicate exact identities without falling back', () => {
  const bridge = createBridge([
    {
      id: 'duplicate', trafficLifecycleId: 'life-1', requestBody: 'first',
      timestamp: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'duplicate', trafficLifecycleId: 'life-1', requestBody: 'second',
      timestamp: '2026-01-02T00:00:00.000Z'
    }
  ], []);

  const missing = bridge._handleGetRequestDetail({
    request_id: 'duplicate',
    traffic_lifecycle_id: 'life-2'
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /duplicate \(lifecycle life-2\) not found/);

  const duplicate = bridge._handleGetRequestDetail({
    request_id: 'duplicate',
    traffic_lifecycle_id: 'life-1'
  });
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.content[0].text, /Multiple requests have traffic identity/);
  assert.doesNotMatch(duplicate.content[0].text, /first|second/);
});

test('MCP request detail preserves unambiguous ID lookup and explicit legacy selection', () => {
  const bridge = createBridge([
    {
      id: 'unique', trafficLifecycleId: 'life-unique', method: 'GET',
      requestBody: 'unique-body', timestamp: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'duplicate', trafficLifecycleId: 'life-current', method: 'GET',
      requestBody: 'current-body', timestamp: '2026-01-02T00:00:00.000Z'
    },
    {
      id: 'duplicate', method: 'GET', requestBody: 'legacy-body',
      timestamp: '2026-01-03T00:00:00.000Z'
    }
  ], []);

  const unique = bridge._handleGetRequestDetail({ request_id: 'unique' });
  assert.equal(unique.isError, undefined);
  assert.equal(JSON.parse(unique.content[0].text).requestBody, 'unique-body');

  const legacy = bridge._handleGetRequestDetail({
    request_id: 'duplicate',
    traffic_lifecycle_id: null
  });
  assert.equal(legacy.isError, undefined);
  const legacyDetail = JSON.parse(legacy.content[0].text);
  assert.equal(legacyDetail.requestBody, 'legacy-body');
  assert.equal(legacyDetail.traffic_lifecycle_id, null);
});

test('MCP request detail validates lifecycle selectors in direct handler calls', () => {
  const bridge = createBridge([], []);

  for (const traffic_lifecycle_id of ['', 12, false, {}]) {
    assert.throws(
      () => bridge._handleGetRequestDetail({ request_id: 'request', traffic_lifecycle_id }),
      /traffic_lifecycle_id must be a non-empty string or null/
    );
  }
});

test('MCP select_request rejects an unknown lifecycle without selecting a sibling', () => {
  const broadcasts = [];
  const bridge = createBridge([
    { id: 'duplicate', trafficLifecycleId: 'life-1', method: 'GET', url: 'https://one.test/' }
  ], broadcasts);

  const result = bridge._handleSelectRequest({
    request_id: 'duplicate',
    traffic_lifecycle_id: 'missing-life'
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /duplicate \(lifecycle missing-life\) not found/);
  assert.deepEqual(broadcasts, []);
});

test('MCP explicitly selects and serializes a duplicate legacy lifecycle as null', () => {
  const broadcasts = [];
  const bridge = createBridge([
    {
      id: 'duplicate', trafficLifecycleId: 'life-1', method: 'GET',
      url: 'https://current.test/', host: 'current.test', path: '/', timestamp: 1
    },
    {
      id: 'duplicate', method: 'DELETE', url: 'https://legacy.test/',
      host: 'legacy.test', path: '/', timestamp: 2
    }
  ], broadcasts);

  const searchResult = bridge._handleSearchTraffic({ limit: 10 });
  assert.match(searchResult.content[0].text, /"trafficLifecycleId": null/);
  const result = bridge._handleSelectRequest({
    request_id: 'duplicate',
    traffic_lifecycle_id: null
  });

  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /DELETE https:\/\/legacy\.test\//);
  const serializedBroadcast = JSON.parse(JSON.stringify(broadcasts.at(-1)));
  assert.deepEqual(serializedBroadcast, {
    type: 'mcp-select',
    requestId: 'duplicate',
    trafficLifecycleId: null
  });
});
