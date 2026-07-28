import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { McpServerBridge, TOOL_DEFINITIONS } from '../src/mcp/mcp-server.js';

const MAX_PAGE = 64 * 1024;

function createBridge(trafficLog) {
  return new McpServerBridge({
    apiServer: { trafficLog, _broadcast() {} },
    proxyServer: {},
    interceptorManager: {}
  });
}

function parseDetail(result) {
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}

function readAllPages(bridge, requestId, side, limit) {
  const chunks = [];
  let offset = 0;
  do {
    const detail = parseDetail(bridge._handleGetRequestDetail({
      request_id: requestId,
      body_side: side,
      body_offset: offset,
      body_limit: limit
    }));
    const page = detail.bodyPage;
    assert.equal(page.side, side);
    assert.equal(page.offset, offset);
    assert.ok(page.length <= limit);
    assert.equal(page.length, page.content.length);
    chunks.push(page.content);
    if (!page.hasMore) {
      assert.equal(page.nextOffset, null);
      break;
    }
    assert.equal(page.nextOffset, offset + page.length);
    offset = page.nextOffset;
  } while (true);
  return chunks.join('');
}

test('MCP request detail advertises bounded body paging', () => {
  const tool = TOOL_DEFINITIONS.find(definition => definition.name === 'get_request_detail');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.properties.body_side.enum, [
    'request',
    'response',
    'original_request'
  ]);
  assert.equal(tool.inputSchema.properties.body_limit.maximum, MAX_PAGE);
  assert.equal(tool.inputSchema.properties.body_offset.minimum, 0);
  assert.match(tool.description, /Repeat with body_offset/);
});

test('MCP request detail metadata stays bounded and every retained body is retrievable', () => {
  const splitSurrogate = `${'r'.repeat(MAX_PAGE - 1)}😀request-tail-token`;
  const responseBody = `data:application/octet-stream;base64,${'c3'.repeat(MAX_PAGE + 23)}`;
  const originalRequestBody = `${'original-'.repeat(20_000)}tail`;
  const trafficLog = [{
    id: 'large-request',
    method: 'POST',
    url: 'https://body.test/resource',
    requestBody: splitSurrogate,
    requestBodyEncoding: 'utf8',
    responseBody,
    responseBodyEncoding: 'base64',
    originalRequest: {
      method: 'PUT',
      url: 'https://body.test/original',
      headers: { 'content-type': 'text/plain' },
      body: originalRequestBody
    },
    timestamp: '2026-01-01T00:00:00.000Z'
  }];
  const bridge = createBridge(trafficLog);

  const metadataResult = bridge._handleGetRequestDetail({ request_id: 'large-request' });
  const detail = parseDetail(metadataResult);
  assert.ok(metadataResult.content[0].text.length < 4_096);
  assert.equal(detail.requestBody, undefined);
  assert.equal(detail.responseBody, undefined);
  assert.equal(detail.originalRequest.body, undefined);
  assert.equal(detail.bodyPage, null);
  assert.equal(detail.bodies.request.totalLength, splitSurrogate.length);
  assert.equal(detail.bodies.request.offsetUnit, 'utf16-code-unit');
  assert.equal(detail.bodies.response.totalLength, responseBody.length);
  assert.equal(detail.bodies.response.encoding, 'base64');
  assert.equal(detail.bodies.original_request.totalLength, originalRequestBody.length);

  assert.equal(readAllPages(bridge, 'large-request', 'request', MAX_PAGE), splitSurrogate);
  assert.equal(readAllPages(bridge, 'large-request', 'response', 31_337), responseBody);
  assert.equal(readAllPages(bridge, 'large-request', 'original_request', 17_003), originalRequestBody);
  assert.equal(trafficLog[0].requestBody, splitSurrogate);
  assert.equal(trafficLog[0].responseBody, responseBody);
  assert.equal(trafficLog[0].originalRequest.body, originalRequestBody);
});

test('one MCP request detail page stays bounded for a near-limit capture', () => {
  const requestBody = `${'x'.repeat(24 * 1024 * 1024)}tail-token`;
  const bridge = createBridge([{
    id: 'near-limit-request',
    method: 'POST',
    url: 'https://body.test/large',
    requestBody,
    responseBody: '',
    timestamp: 1_767_225_600_000
  }]);

  const result = bridge._handleGetRequestDetail({
    request_id: 'near-limit-request',
    body_side: 'request'
  });
  const detail = parseDetail(result);
  assert.ok(result.content[0].text.length < 80 * 1024);
  assert.equal(detail.bodyPage.length, MAX_PAGE);
  assert.equal(detail.bodyPage.totalLength, requestBody.length);
  assert.equal(detail.bodyPage.hasMore, true);
  assert.equal(detail.bodyPage.nextOffset, MAX_PAGE);
});

test('MCP transport returns paged Unicode content and rejects unsafe page arguments', async t => {
  const requestBody = `${'u'.repeat(MAX_PAGE - 1)}😀tail`;
  const bridge = createBridge([{
    id: 'transport-request',
    method: 'POST',
    url: 'https://body.test/transport',
    requestBody,
    responseBody: '',
    timestamp: 1_767_225_600_000
  }]);
  const client = new Client({ name: 'body-pagination-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await bridge.stop();
  });

  const listed = await client.listTools();
  const detailTool = listed.tools.find(tool => tool.name === 'get_request_detail');
  assert.equal(detailTool.inputSchema.properties.body_limit.maximum, MAX_PAGE);

  const first = parseDetail(await client.callTool({
    name: 'get_request_detail',
    arguments: {
      request_id: 'transport-request',
      body_side: 'request'
    }
  }));
  const second = parseDetail(await client.callTool({
    name: 'get_request_detail',
    arguments: {
      request_id: 'transport-request',
      body_side: 'request',
      body_offset: first.bodyPage.nextOffset
    }
  }));
  assert.equal(first.bodyPage.content + second.bodyPage.content, requestBody);

  const invalid = await client.callTool({
    name: 'get_request_detail',
    arguments: {
      request_id: 'transport-request',
      body_side: 'request',
      body_limit: MAX_PAGE + 1
    }
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /body_limit/);
});

test('MCP request detail requires a side for offsets and validates direct calls', () => {
  const bridge = createBridge([{
    id: 'validation-request',
    requestBody: '',
    responseBody: '',
    timestamp: 1_767_225_600_000
  }]);

  assert.throws(
    () => bridge._handleGetRequestDetail({ request_id: 'validation-request', body_offset: 1 }),
    /body_side is required/
  );
  assert.throws(
    () => bridge._handleGetRequestDetail({
      request_id: 'validation-request',
      body_side: 'response',
      body_offset: -1
    }),
    /body_offset/
  );
  assert.throws(
    () => bridge._handleGetRequestDetail({
      request_id: 'validation-request',
      body_side: 'response',
      body_limit: 1.5
    }),
    /body_limit/
  );
});
