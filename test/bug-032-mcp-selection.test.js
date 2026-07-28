import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { McpServerBridge, TOOL_DEFINITIONS } from '../src/mcp/mcp-server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

  assert.equal(selectTool.inputSchema.properties.traffic_lifecycle_id.minLength, 1);
  const searchResult = bridge._handleSearchTraffic({ limit: 10 });
  assert.match(searchResult.content[0].text, /"trafficLifecycleId": "life-2"/);

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
