import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { McpServerBridge, TOOL_DEFINITIONS } from '../src/mcp/mcp-server.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

const MAX_PAGE = 32 * 1024;
const PREVIEW = 8 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;

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
  assert.equal(tool.inputSchema.properties.body_offset.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(tool.inputSchema.properties.request_id.minLength, 1);
  assert.deepEqual(tool.inputSchema.allOf[0].then.required, ['body_side']);
  assert.match(tool.description, /repeat with body_offset/i);
  assert.match(tool.inputSchema.properties.body_side.description, /complete legacy bodies/);
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
  assert.ok(Buffer.byteLength(metadataResult.content[0].text) < MAX_RESPONSE_BYTES);
  assert.equal(detail.requestBody, splitSurrogate);
  assert.equal(detail.responseBody, responseBody);
  assert.equal(detail.originalRequest.body, originalRequestBody);
  assert.equal(detail.requestBodyPreview, undefined);
  assert.equal(detail.legacyBodiesOmitted, undefined);
  assert.equal(detail.bodyPage, null);
  assert.equal(detail.bodies.request.totalLength, splitSurrogate.length);
  assert.equal(detail.bodies.request.previewLength, splitSurrogate.length);
  assert.equal(detail.bodies.request.hasMore, false);
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

test('legacy request detail fields remain complete whenever the bounded response fits', () => {
  const requestBody = 'r'.repeat(9_000);
  const responseBody = 's'.repeat(9_000);
  const originalBody = 'o'.repeat(9_000);
  const bridge = createBridge([{
    id: 'legacy-small',
    method: 'POST',
    requestBody,
    responseBody,
    originalRequest: { method: 'PUT', body: originalBody },
    timestamp: 1_767_225_600_000
  }]);

  const detail = parseDetail(bridge._handleGetRequestDetail({ request_id: 'legacy-small' }));
  assert.equal(detail.requestBody, requestBody);
  assert.equal(detail.responseBody, responseBody);
  assert.equal(detail.originalRequest.body, originalBody);
  assert.equal(detail.requestBodyPreview, undefined);
  assert.equal(detail.bodies.request.previewLength, requestBody.length);
  assert.equal(detail.bodies.request.hasMore, false);
  assert.equal(detail.bodies.response.hasMore, false);
});

test('production boxed original bodies retain content and provenance across pages', () => {
  const proxy = new ProxyServer(null);
  const encodedBody = proxy._safeBodyString(
    Buffer.from([0x00, 0xff, 0x10, 0x80]),
    '',
    'image/png'
  );
  const truncatedBody = proxy._safeBodyString(
    Buffer.alloc(512 * 1024 + 17, 0x61),
    '',
    'text/plain'
  );
  const bridge = createBridge([
    {
      id: 'boxed-encoded',
      requestBody: '',
      responseBody: '',
      originalRequest: { body: encodedBody },
      timestamp: 1_767_225_600_000
    },
    {
      id: 'boxed-truncated',
      requestBody: '',
      responseBody: '',
      originalRequest: { body: truncatedBody },
      timestamp: 1_767_225_600_000
    }
  ]);

  const encodedDetail = parseDetail(bridge._handleGetRequestDetail({
    request_id: 'boxed-encoded'
  }));
  assert.equal(encodedDetail.bodies.original_request.encoding, 'base64');
  assert.equal(encodedDetail.bodies.original_request.totalLength, String(encodedBody).length);
  assert.equal(readAllPages(bridge, 'boxed-encoded', 'original_request', 7), String(encodedBody));

  const truncatedDetail = parseDetail(bridge._handleGetRequestDetail({
    request_id: 'boxed-truncated'
  }));
  assert.equal(truncatedDetail.bodies.original_request.truncated, true);
  assert.equal(truncatedDetail.bodies.original_request.capturedSize, 512 * 1024);
  assert.equal(truncatedDetail.bodies.original_request.decodedSize, 512 * 1024 + 17);
  assert.equal(
    readAllPages(bridge, 'boxed-truncated', 'original_request', MAX_PAGE),
    String(truncatedBody)
  );
});

test('large imported metadata is recursively bounded without mutating traffic', () => {
  const huge = `${'metadata-'.repeat(256 * 1024)}tail`;
  const record = {
    id: 'huge-metadata',
    method: 'GET',
    requestHeaders: { 'x-huge': huge },
    responseHeaders: { 'x-nested': ['small', huge] },
    requestBody: 'paged body',
    responseBody: '',
    originalRequest: [huge],
    extension: { nested: { body: huge } },
    timestamp: 1_767_225_600_000
  };
  const bridge = createBridge([record]);

  for (const args of [
    { request_id: 'huge-metadata' },
    { request_id: 'huge-metadata', body_side: 'request' }
  ]) {
    const result = bridge._handleGetRequestDetail(args);
    assert.ok(Buffer.byteLength(result.content[0].text) <= MAX_RESPONSE_BYTES);
    const detail = parseDetail(result);
    assert.match(detail.requestHeaders['x-huge'], /truncated|string omitted/);
  }
  assert.equal(record.requestHeaders['x-huge'], huge);
  assert.equal(record.originalRequest[0], huge);
  assert.equal(record.extension.nested.body, huge);
});

test('metadata traversal omits accessors and stops at a bounded number of entries', () => {
  let accessorReads = 0;
  const manyHeaders = {};
  for (let index = 0; index < 10_000; index++) manyHeaders[`x-${index}`] = '';
  const originalRequest = { method: 'POST' };
  Object.defineProperty(originalRequest, 'body', {
    enumerable: true,
    get() {
      accessorReads++;
      throw new Error('original body getter must not run');
    }
  });
  const record = {
    id: 'accessor-metadata',
    method: 'GET',
    requestHeaders: manyHeaders,
    requestBody: 'stable',
    responseBody: '',
    originalRequest,
    timestamp: 1_767_225_600_000
  };
  Object.defineProperty(record, 'danger', {
    enumerable: true,
    get() {
      accessorReads++;
      record.requestBody = 'MUTATED';
      return 'unsafe';
    }
  });
  const bridge = createBridge([record]);

  const detail = parseDetail(bridge._handleGetRequestDetail({ request_id: 'accessor-metadata' }));
  assert.equal(accessorReads, 0);
  assert.equal(record.requestBody, 'stable');
  assert.equal(detail.requestBody, 'stable');
  assert.equal(detail.originalRequest.body, '');
  assert.equal(detail.requestHeaders._mcpAdditionalEntriesOmitted, true);
  assert.ok(Object.keys(detail.requestHeaders).length <= 129);
});

test('metadata traversal ignores inherited keys and proxy value traps', () => {
  let inheritedAccessorReads = 0;
  let proxyValueReads = 0;
  const prototype = {};
  for (let index = 0; index < 300; index++) {
    prototype[`inherited-${index}`] = 'untrusted';
  }
  Object.defineProperty(prototype, 'inherited-accessor', {
    enumerable: true,
    get() {
      inheritedAccessorReads++;
      return 'unsafe';
    }
  });
  const inheritedMetadata = Object.create(prototype);
  const proxyMetadata = new Proxy({ safe: 'retained' }, {
    get(target, property, receiver) {
      proxyValueReads++;
      return Reflect.get(target, property, receiver);
    }
  });
  const bridge = createBridge([{
    id: 'own-metadata-only',
    inheritedMetadata,
    proxyMetadata,
    method: 'GET',
    requestBody: '',
    responseBody: '',
    timestamp: 1_767_225_600_000
  }]);

  const detail = parseDetail(bridge._handleGetRequestDetail({
    request_id: 'own-metadata-only'
  }));

  assert.deepEqual(detail.inheritedMetadata, { _mcpAdditionalEntriesOmitted: true });
  assert.deepEqual(detail.proxyMetadata, { safe: 'retained' });
  assert.equal(inheritedAccessorReads, 0);
  assert.equal(proxyValueReads, 0);
});

test('metadata traversal bounds proxy descriptor traps before full enumeration', () => {
  let descriptorReads = 0;
  const target = {};
  for (let index = 0; index < 10_000; index++) target[`key-${index}`] = index;
  const expensiveMetadata = new Proxy(target, {
    getOwnPropertyDescriptor(object, property) {
      descriptorReads++;
      return Reflect.getOwnPropertyDescriptor(object, property);
    }
  });
  const bridge = createBridge([{
    id: 'bounded-proxy-enumeration',
    expensiveMetadata,
    method: 'GET',
    requestBody: '',
    responseBody: '',
    timestamp: 1_767_225_600_000
  }]);

  const detail = parseDetail(bridge._handleGetRequestDetail({
    request_id: 'bounded-proxy-enumeration'
  }));

  assert.equal(detail.expensiveMetadata._mcpAdditionalEntriesOmitted, true);
  assert.ok(descriptorReads <= 400, `read ${descriptorReads} proxy descriptors`);
});

test('metadata traversal marks a disappearing proxy descriptor as omitted', () => {
  const descriptorReads = new Map();
  const unstableMetadata = new Proxy({ first: 1, second: 2, third: 3 }, {
    getOwnPropertyDescriptor(target, property) {
      const reads = (descriptorReads.get(property) || 0) + 1;
      descriptorReads.set(property, reads);
      if (property === 'first' && reads === 2) return undefined;
      return Reflect.getOwnPropertyDescriptor(target, property);
    }
  });
  const bridge = createBridge([{
    id: 'unstable-proxy-descriptor',
    unstableMetadata,
    requestBody: '',
    responseBody: '',
    timestamp: 1_767_225_600_000
  }]);

  const detail = parseDetail(bridge._handleGetRequestDetail({
    request_id: 'unstable-proxy-descriptor'
  }));

  assert.deepEqual(detail.unstableMetadata, { _mcpAdditionalEntriesOmitted: true });
  assert.equal(descriptorReads.get('first'), 2);
  assert.equal(descriptorReads.has('second'), false);
  assert.equal(descriptorReads.has('third'), false);
});

test('opaque proxy metadata is omitted without aborting request detail', () => {
  const requestHeaders = Proxy.revocable({ safe: 'unreachable' }, {});
  const originalRequest = Proxy.revocable({ body: 'unreachable' }, {});
  requestHeaders.revoke();
  originalRequest.revoke();
  const bridge = createBridge([{
    id: 'opaque-metadata',
    method: 'GET',
    requestHeaders: requestHeaders.proxy,
    requestBody: 'stable',
    responseBody: '',
    originalRequest: originalRequest.proxy,
    timestamp: 1_767_225_600_000
  }]);

  const detail = parseDetail(bridge._handleGetRequestDetail({
    request_id: 'opaque-metadata'
  }));

  assert.equal(detail.requestBody, 'stable');
  assert.equal(detail.requestHeaders._mcpAdditionalEntriesOmitted, true);
  assert.equal(detail.originalRequest._mcpAdditionalEntriesOmitted, true);
  assert.equal(detail.originalRequest.body, '');
  assert.equal(detail.bodies.original_request.totalLength, 0);
});

test('MCP request detail does not execute body, metadata, size, or timestamp coercion hooks', () => {
  let coercionReads = 0;
  let byteLengthReads = 0;
  const boxedBody = new String('intrinsic body');
  const boxedMetadata = new String('intrinsic metadata');
  for (const value of [boxedBody, boxedMetadata]) {
    value[Symbol.toPrimitive] = () => {
      coercionReads++;
      return 'substituted';
    };
    value.toString = () => {
      coercionReads++;
      return 'substituted';
    };
  }
  const binaryMetadata = Buffer.from([0x01, 0x02]);
  Object.defineProperty(binaryMetadata, 'byteLength', {
    get() {
      byteLengthReads++;
      return 999;
    }
  });
  const timestamp = {
    [Symbol.toPrimitive]() {
      coercionReads++;
      return 1_767_225_600_000;
    }
  };
  const bridge = createBridge([{
    id: 'intrinsic-metadata-values',
    requestBody: boxedBody,
    responseBody: '',
    boxedMetadata,
    binaryMetadata,
    timestamp
  }]);

  const detail = parseDetail(bridge._handleGetRequestDetail({
    request_id: 'intrinsic-metadata-values'
  }));

  assert.equal(detail.requestBody, 'intrinsic body');
  assert.equal(detail.boxedMetadata, 'intrinsic metadata');
  assert.equal(detail.binaryMetadata, '[Binary metadata: 2 bytes]');
  assert.equal(detail.timestamp, null);
  assert.equal(coercionReads, 0);
  assert.equal(byteLengthReads, 0);
});

test('MCP request detail marks detached binary metadata as omitted', () => {
  const buffer = new ArrayBuffer(8);
  const detachedMetadata = new DataView(buffer);
  structuredClone(buffer, { transfer: [buffer] });
  const bridge = createBridge([{
    id: 'detached-binary-metadata',
    requestBody: '',
    responseBody: '',
    detachedMetadata,
    timestamp: 1_767_225_600_000
  }]);

  const detail = parseDetail(bridge._handleGetRequestDetail({
    request_id: 'detached-binary-metadata'
  }));

  assert.equal(detail.detachedMetadata, '[binary metadata omitted]');
});

test('one MCP request detail page stays bounded for a near-limit capture', () => {
  const requestBody = `${'x'.repeat(24 * 1024 * 1024)}tail-token`;
  const bridge = createBridge([{
    id: 'near-limit-request',
    method: 'POST',
    url: 'https://body.test/large',
    requestBody,
    responseBody: '',
    requestHeaders: { 'x-large': 'h'.repeat(2 * 1024 * 1024) },
    timestamp: 1_767_225_600_000
  }]);

  const result = bridge._handleGetRequestDetail({
    request_id: 'near-limit-request',
    body_side: 'request'
  });
  const detail = parseDetail(result);
  assert.ok(Buffer.byteLength(result.content[0].text) < MAX_RESPONSE_BYTES);
  assert.equal(detail.bodyPage.length, MAX_PAGE);
  assert.equal(detail.bodyPage.totalLength, requestBody.length);
  assert.equal(detail.bodyPage.hasMore, true);
  assert.equal(detail.bodyPage.nextOffset, MAX_PAGE);

  const defaultDetail = parseDetail(bridge._handleGetRequestDetail({
    request_id: 'near-limit-request'
  }));
  assert.equal(defaultDetail.requestBody, undefined);
  assert.equal(defaultDetail.legacyBodiesOmitted, true);
  assert.equal(defaultDetail.requestBodyPreview, requestBody.slice(0, PREVIEW));
});

test('MCP request detail uses the measured wire budget without a fixed reserve', () => {
  const requestBody = 'x'.repeat(504 * 1024);
  const bridge = createBridge([{
    id: 'reserve-boundary',
    method: 'POST',
    requestBody,
    responseBody: '',
    timestamp: 1_767_225_600_000
  }]);

  const result = bridge._handleGetRequestDetail({ request_id: 'reserve-boundary' }, 1);
  const detail = parseDetail(result);
  const wireBytes = Buffer.byteLength(JSON.stringify({
    jsonrpc: '2.0', id: 1, result
  }));

  assert.equal(detail.requestBody, requestBody);
  assert.ok(wireBytes > MAX_RESPONSE_BYTES - 8 * 1024);
  assert.ok(wireBytes <= MAX_RESPONSE_BYTES);
});

test('MCP transport returns paged Unicode content and rejects unsafe page arguments', async t => {
  const requestBody = `${'u'.repeat(MAX_PAGE - 1)}😀tail`;
  const wireMetadata = {};
  for (let index = 0; index < 128; index++) {
    wireMetadata[`x-${String(index).padStart(3, '0')}-${'k'.repeat(118)}`] =
      '\ud800'.repeat(128);
  }
  const bridge = createBridge([
    {
      id: 'transport-request',
      method: 'POST',
      url: 'https://body.test/transport',
      requestBody,
      responseBody: '',
      timestamp: 1_767_225_600_000
    },
    {
      id: 'wire-heavy-request',
      method: 'POST',
      url: 'https://body.test/wire-heavy',
      requestBody: '\\'.repeat(200 * 1024),
      responseBody: '',
      timestamp: 1_767_225_600_000
    },
    {
      id: 'wire-page-request',
      method: 'POST',
      url: 'https://body.test/wire-page',
      requestHeaders: wireMetadata,
      requestBody: '\ud800'.repeat(MAX_PAGE),
      responseBody: '',
      timestamp: 1_767_225_600_000
    }
  ]);
  const client = new Client({ name: 'body-pagination-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const wireResponseBytes = [];
  const sendServerMessage = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    if (message?.result?.content) {
      wireResponseBytes.push(Buffer.byteLength(JSON.stringify(message)));
    }
    return sendServerMessage(message, options);
  };
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
  assert.ok(wireResponseBytes.at(-1) <= MAX_RESPONSE_BYTES);
  const second = parseDetail(await client.callTool({
    name: 'get_request_detail',
    arguments: {
      request_id: 'transport-request',
      body_side: 'request',
      body_offset: first.bodyPage.nextOffset
    }
  }));
  assert.equal(first.bodyPage.content + second.bodyPage.content, requestBody);
  assert.ok(wireResponseBytes.at(-1) <= MAX_RESPONSE_BYTES);

  const wireHeavy = parseDetail(await client.callTool({
    name: 'get_request_detail',
    arguments: { request_id: 'wire-heavy-request' }
  }));
  assert.equal(wireHeavy.requestBody, undefined);
  assert.equal(wireHeavy.legacyBodiesOmitted, true);
  assert.equal(wireHeavy.requestBodyPreview, '\\'.repeat(PREVIEW));
  assert.ok(wireResponseBytes.at(-1) <= MAX_RESPONSE_BYTES);

  const wirePage = parseDetail(await client.callTool({
    name: 'get_request_detail',
    arguments: {
      request_id: 'wire-page-request',
      body_side: 'request'
    }
  }));
  assert.equal(wirePage.bodyPage.content, '\ud800'.repeat(MAX_PAGE));
  assert.ok(wireResponseBytes.at(-1) <= MAX_RESPONSE_BYTES);

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

  const missingSide = await client.callTool({
    name: 'get_request_detail',
    arguments: {
      request_id: 'transport-request',
      body_offset: 1
    }
  });
  assert.equal(missingSide.isError, true);
  assert.match(missingSide.content[0].text, /body_side/);

  const unsafeOffset = await client.callTool({
    name: 'get_request_detail',
    arguments: {
      request_id: 'transport-request',
      body_side: 'request',
      body_offset: Number.MAX_SAFE_INTEGER + 1
    }
  });
  assert.equal(unsafeOffset.isError, true);
  assert.match(unsafeOffset.content[0].text, /body_offset/);
});

test('MCP request detail budget includes the actual JSON-RPC request ID', async t => {
  const bridge = createBridge([{
    id: 'large-id-request',
    method: 'POST',
    requestBody: 'x'.repeat(200 * 1024),
    responseBody: '',
    timestamp: 1_767_225_600_000
  }]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pendingResponses = new Map();
  clientTransport.onmessage = message => pendingResponses.get(message.id)?.(message);
  await bridge.server.connect(serverTransport);
  await clientTransport.start();
  t.after(async () => {
    await clientTransport.close();
    await bridge.stop();
  });

  const request = message => new Promise((resolve, reject) => {
    pendingResponses.set(message.id, response => {
      pendingResponses.delete(message.id);
      resolve(response);
    });
    clientTransport.send(message).catch(reject);
  });
  await request({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'large-id-test', version: '1.0.0' }
    }
  });
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const requestId = 'i'.repeat(400 * 1024);
  const response = await request({
    jsonrpc: '2.0',
    id: requestId,
    method: 'tools/call',
    params: {
      name: 'get_request_detail',
      arguments: { request_id: 'large-id-request' }
    }
  });

  assert.equal(response.id, requestId);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) <= MAX_RESPONSE_BYTES);
  const detail = JSON.parse(response.result.content[0].text);
  assert.equal(detail.requestBody, undefined);
  assert.equal(detail.legacyBodiesOmitted, true);
});

test('MCP replaces an over-cap boundary response with a bounded JSON-RPC error', async t => {
  const bridge = createBridge([]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pendingResponses = new Map();
  clientTransport.onmessage = message => pendingResponses.get(message.id)?.(message);
  await bridge.server.connect(serverTransport);
  await clientTransport.start();
  t.after(async () => {
    await clientTransport.close();
    await bridge.stop();
  });

  const request = message => new Promise((resolve, reject) => {
    pendingResponses.set(message.id, response => {
      pendingResponses.delete(message.id);
      resolve(response);
    });
    clientTransport.send(message).catch(reject);
  });
  await request({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'boundary-id-test', version: '1.0.0' }
    }
  });
  await clientTransport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const requestId = 'i'.repeat(MAX_RESPONSE_BYTES - 110);
  const response = await request({
    jsonrpc: '2.0',
    id: requestId,
    method: 'tools/call',
    params: {
      name: 'get_request_detail',
      arguments: { request_id: 'missing' }
    }
  });

  assert.equal(response.id, requestId);
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /response exceeds/i);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) <= MAX_RESPONSE_BYTES);
  assert.deepEqual(await request({ jsonrpc: '2.0', id: 2, method: 'ping' }), {
    jsonrpc: '2.0', id: 2, result: {}
  });
});

test('MCP closes a transport when its request ID cannot fit in any capped response', async t => {
  const bridge = createBridge([]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const messages = [];
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  clientTransport.onmessage = message => messages.push(message);
  clientTransport.onclose = resolveClosed;
  await bridge.server.connect(serverTransport);
  await clientTransport.start();
  t.after(async () => { await bridge.stop(); });

  await clientTransport.send({
    jsonrpc: '2.0',
    id: 'i'.repeat(520 * 1024),
    method: 'tools/call',
    params: {
      name: 'get_request_detail',
      arguments: { request_id: 'missing' }
    }
  });
  await closed;

  assert.deepEqual(messages, []);
  await assert.rejects(
    clientTransport.send({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    /Not connected/
  );
});

test('direct MCP stdio terminates after an unanswerable request ID', async t => {
  const bridge = createBridge([]);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const output = [];
  stdout.on('data', chunk => output.push(Buffer.from(chunk)));
  let resolveFatal;
  const fatal = new Promise(resolve => { resolveFatal = resolve; });
  const finished = once(stdout, 'finish');
  await bridge.startStdio({
    stdin,
    stdout,
    onFatalError: async error => {
      await bridge.stop();
      resolveFatal(error);
    }
  });
  let closeCalls = 0;
  const transport = bridge.stdioTransport;
  const originalClose = transport.close.bind(transport);
  transport.close = (...args) => {
    closeCalls++;
    return originalClose(...args);
  };
  t.after(async () => {
    stdin.destroy();
    stdout.destroy();
    await bridge.stop();
  });

  stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 'i'.repeat(520 * 1024),
    method: 'tools/call',
    params: {
      name: 'get_request_detail',
      arguments: { request_id: 'missing' }
    }
  })}\n`);

  const [error] = await Promise.all([fatal, finished]);
  assert.match(error.message, /cannot fit/i);
  assert.equal(Buffer.concat(output).length, 0);
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdout.writableEnded, true);
  assert.equal(bridge.getStatus().stdioActive, false);
  assert.equal(closeCalls, 1);
});

test('MCP stdio rejects a duplicate start without losing the active transport', async t => {
  const bridge = createBridge([]);
  const activeInput = new PassThrough();
  const activeOutput = new PassThrough();
  const duplicateInput = new PassThrough();
  const duplicateOutput = new PassThrough();
  const onFatalError = () => {};
  await bridge.startStdio({
    stdin: activeInput,
    stdout: activeOutput,
    onFatalError
  });
  t.after(async () => {
    activeInput.destroy();
    activeOutput.destroy();
    duplicateInput.destroy();
    duplicateOutput.destroy();
    await bridge.stop();
  });
  const activeTransport = bridge.stdioTransport;

  await assert.rejects(
    bridge.startStdio({ stdin: duplicateInput, stdout: duplicateOutput }),
    /already active/
  );

  assert.equal(bridge.stdioTransport, activeTransport);
  assert.equal(bridge.stdioOutput, activeOutput);
  assert.equal(bridge.onStdioFatalError, onFatalError);
  assert.equal(activeInput.listenerCount('data'), 1);
  assert.equal(duplicateInput.listenerCount('data'), 0);
  assert.equal(bridge.getStatus().stdioActive, true);
});

test('MCP stdio cleans a partially started transport and permits retry', async t => {
  const bridge = createBridge([]);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const streamOn = stdin.on;
  let rejectErrorListener = true;
  stdin.on = function (event, listener) {
    if (event === 'error' && rejectErrorListener) {
      rejectErrorListener = false;
      throw new Error('simulated stdio startup failure');
    }
    return streamOn.call(this, event, listener);
  };
  t.after(async () => {
    stdin.destroy();
    stdout.destroy();
    await bridge.stop();
  });

  await assert.rejects(
    bridge.startStdio({ stdin, stdout }),
    /simulated stdio startup failure/
  );
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdin.listenerCount('error'), 0);
  assert.equal(bridge.getStatus().stdioActive, false);
  assert.equal(bridge.server.transport, undefined);

  await bridge.startStdio({ stdin, stdout });
  assert.equal(stdin.listenerCount('data'), 1);
  assert.equal(stdin.listenerCount('error'), 1);
  assert.equal(bridge.getStatus().stdioActive, true);
});

test('MCP stdio detaches a failed start when transport close also throws', async t => {
  const bridge = createBridge([]);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const streamOn = stdin.on;
  const streamOff = stdin.off;
  let rejectErrorListener = true;
  stdin.on = function (event, listener) {
    if (event === 'error' && rejectErrorListener) {
      rejectErrorListener = false;
      throw new Error('primary stdio startup failure');
    }
    return streamOn.call(this, event, listener);
  };
  stdin.off = function (event, listener) {
    if (event === 'data') throw new Error('secondary stdio cleanup failure');
    return streamOff.call(this, event, listener);
  };
  t.after(async () => {
    stdin.off = streamOff;
    stdin.destroy();
    stdout.destroy();
    await bridge.stop();
  });

  await assert.rejects(
    bridge.startStdio({ stdin, stdout }),
    /primary stdio startup failure/
  );
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdin.listenerCount('error'), 0);
  assert.equal(bridge.server.transport, undefined);
  assert.equal(bridge.getStatus().stdioActive, false);

  stdin.off = streamOff;
  await bridge.startStdio({ stdin, stdout });
  assert.equal(stdin.listenerCount('data'), 1);
  assert.equal(stdin.listenerCount('error'), 1);
  assert.equal(bridge.getStatus().stdioActive, true);
});

test('MCP stdio cannot start a transport during shutdown', async t => {
  const bridge = createBridge([]);
  const activeInput = new PassThrough();
  const activeOutput = new PassThrough();
  const racingInput = new PassThrough();
  const racingOutput = new PassThrough();
  await bridge.startStdio({ stdin: activeInput, stdout: activeOutput });
  t.after(async () => {
    activeInput.destroy();
    activeOutput.destroy();
    racingInput.destroy();
    racingOutput.destroy();
    racingInput.removeAllListeners();
    await bridge.stop();
  });

  const activeTransport = bridge.stdioTransport;
  const originalClose = activeTransport.close.bind(activeTransport);
  let racingStart;
  activeTransport.close = async (...args) => {
    await originalClose(...args);
    racingStart = bridge.startStdio({ stdin: racingInput, stdout: racingOutput });
    await racingStart.catch(() => {});
  };

  await bridge.stop();
  await assert.rejects(racingStart, /stopping/);
  assert.equal(racingInput.listenerCount('data'), 0);
  assert.equal(racingInput.listenerCount('error'), 0);
  assert.equal(bridge.server, null);
  assert.equal(bridge.getStatus().stdioActive, false);
});

test('MCP stdio startup rejects when shutdown wins the connect race', async t => {
  const bridge = createBridge([]);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  t.after(() => {
    stdin.destroy();
    stdout.destroy();
  });

  const start = bridge.startStdio({ stdin, stdout });
  const stop = bridge.stop();

  await assert.rejects(start, /interrupted by shutdown/);
  await stop;
  assert.equal(stdin.listenerCount('data'), 0);
  assert.equal(stdin.listenerCount('error'), 0);
  assert.equal(bridge.server, null);
  assert.equal(bridge.getStatus().stdioActive, false);
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
  assert.throws(
    () => bridge._handleGetRequestDetail({ request_id: '' }),
    /request_id/
  );
  assert.throws(
    () => bridge._handleGetRequestDetail({
      request_id: 'validation-request',
      body_side: 'request',
      body_offset: Number.MAX_SAFE_INTEGER + 1
    }),
    /body_offset/
  );
  assert.throws(
    () => bridge._handleGetRequestDetail({
      request_id: 'validation-request',
      body_side: 'request',
      body_offset: null
    }),
    /body_offset/
  );
  assert.throws(
    () => bridge._handleGetRequestDetail({
      request_id: 'validation-request',
      body_side: 'request',
      body_limit: null
    }),
    /body_limit/
  );
});
