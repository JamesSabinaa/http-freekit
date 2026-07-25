import assert from 'node:assert/strict';
import test from 'node:test';

import { trafficToHar } from '../src/api/har-converter.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

test('large text captures retain bounded previews and export explicit HAR truncation metadata', () => {
  let captured;
  const proxy = new ProxyServer(null, { onRequest: request => { captured = request; } });
  const body = Buffer.alloc(1024 * 1024, 0x61);

  proxy._emitRequest({
    id: 'large-text',
    timestamp: 0,
    method: 'GET',
    url: 'http://example.test/',
    responseHeaders: { 'content-type': 'text/plain' },
    responseBody: proxy._safeBodyString(body, undefined, 'text/plain'),
    responseBodySize: body.length
  });

  assert.equal(Buffer.byteLength(captured.responseBody), 512 * 1024);
  assert.equal(captured.responseBodyTruncated, true);
  assert.equal(captured.responseBodyCapturedSize, 512 * 1024);
  assert.equal(captured.responseBodyDecodedSize, body.length);

  const response = trafficToHar([captured], { maskSensitive: false }).log.entries[0].response;
  assert.equal(Buffer.byteLength(response.content.text), 512 * 1024);
  assert.equal(response.content.size, 512 * 1024);
  assert.equal(response.bodySize, body.length);
  assert.equal(response.content._truncated, true);
  assert.equal(response.content._capturedSize, 512 * 1024);
  assert.equal(response.content._originalSize, body.length);
  assert.match(response.content.comment, /524288 of 1048576 bytes retained/);
});

test('omitted large binary captures are not exported as fake HAR body text', () => {
  let captured;
  const proxy = new ProxyServer(null, { onRequest: request => { captured = request; } });
  const body = Buffer.alloc(2 * 1024 * 1024, 0);

  proxy._emitRequest({
    id: 'large-binary',
    timestamp: 0,
    method: 'GET',
    url: 'http://example.test/',
    responseHeaders: { 'content-type': 'application/octet-stream' },
    responseBody: proxy._safeBodyString(body, undefined, 'application/octet-stream'),
    responseBodySize: body.length
  });

  assert.equal(captured.responseBody, `[Binary data: ${body.length} bytes]`);
  assert.equal(captured.responseBodyTruncated, true);
  assert.equal(captured.responseBodyCapturedSize, 0);

  const response = trafficToHar([captured], { maskSensitive: false }).log.entries[0].response;
  assert.equal(response.content.text, '');
  assert.equal(response.content.size, 0);
  assert.equal(response.bodySize, body.length);
  assert.equal(response.content._truncated, true);
  assert.equal(response.content._capturedSize, 0);
  assert.equal(response.content._originalSize, body.length);
});
