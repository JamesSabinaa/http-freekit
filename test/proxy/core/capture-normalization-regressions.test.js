import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';

import { ProxyServer } from '../../../src/proxy/proxy-server.js';

test('source detection normalizes repeated and non-string User-Agent values', () => {
  const proxy = new ProxyServer(null);

  assert.equal(proxy._detectSource({ 'User-Agent': 42 }), 'Other');
  assert.equal(proxy._detectSource({ 'USER-AGENT': ['prefix', 'curl/8.0'] }), 'cURL');
});

test('response capture resolves mixed-case encoding and content-type headers', () => {
  const proxy = new ProxyServer(null);
  const compressed = zlib.gzipSync(Buffer.from('decoded response'));

  assert.equal(String(proxy._safeResponseBodyString(compressed, {
    'Content-Encoding': 'gzip',
    'Content-Type': 'text/plain'
  })), 'decoded response');

  const binary = proxy._safeResponseBodyString(Buffer.from([0, 1, 2]), {
    'CONTENT-TYPE': 'image/png'
  });
  assert.match(String(binary), /^data:image\/png;base64,/);
  assert.equal(binary.encoding, 'base64');
});

test('response status edits replace stale upstream reason phrases', async () => {
  const proxy = new ProxyServer(null);
  const transformed = proxy._applyMockResponseTransform({
    type: 'transform-response',
    statusOverride: 201
  }, {
    statusCode: 404,
    statusMessage: 'Not Found',
    headers: {},
    body: Buffer.alloc(0),
    trailers: {}
  });
  assert.equal(transformed.statusCode, 201);
  assert.equal(transformed.statusMessage, 'Created');

  proxy.onBreakpoint = event => {
    if (event.type === 'breakpoint-hit') {
      setImmediate(() => proxy.resumeBreakpoint(event.requestId, { status: 202 }));
    }
  };
  const resumed = await proxy._pauseResponseBreakpoint({
    requestId: 'status-edit',
    protocol: 'http',
    method: 'GET',
    url: 'http://example.test/',
    host: 'example.test',
    path: '/',
    requestHeaders: {},
    requestBody: Buffer.alloc(0),
    statusCode: 404,
    statusMessage: 'Not Found',
    responseHeaders: {},
    responseBody: Buffer.alloc(0),
    trailers: {},
    startTime: Date.now(),
    tlsDetails: null,
    remote: null,
    abortTarget: null,
    trafficLifecycleId: 'status-edit-life'
  });
  assert.equal(resumed.statusCode, 202);
  assert.equal(resumed.statusMessage, 'Accepted');
});
