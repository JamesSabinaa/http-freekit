import assert from 'node:assert/strict';
import test from 'node:test';

import { trafficToHar } from '../src/api/har-converter.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

function captureBodies(requestBytes, responseBytes, contentType) {
  let captured;
  const proxy = new ProxyServer(null, { onRequest: request => { captured = request; } });
  proxy._emitRequest({
    id: 'body-provenance',
    timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
    protocol: 'http',
    method: 'POST',
    url: 'http://example.test/body',
    requestHeaders: { 'content-type': contentType },
    requestBody: proxy._safeBodyString(requestBytes, undefined, contentType),
    requestBodySize: requestBytes.length,
    statusCode: 200,
    statusMessage: 'OK',
    responseHeaders: { 'content-type': contentType },
    responseBody: proxy._safeBodyString(responseBytes, undefined, contentType),
    responseBodySize: responseBytes.length,
    duration: 1,
    source: 'proxy'
  });
  return captured;
}

test('literal request and response data-URI text stays literal in HAR export', () => {
  const requestText = 'data:text/plain;base64,SGVsbG8=';
  const responseText = 'data:text/plain;base64,V29ybGQ=';
  const captured = captureBodies(
    Buffer.from(requestText, 'utf8'),
    Buffer.from(responseText, 'utf8'),
    'text/plain'
  );

  assert.equal(captured.requestBody, requestText);
  assert.equal(captured.requestBodyEncoding, 'utf8');
  assert.equal(captured.responseBody, responseText);
  assert.equal(captured.responseBodyEncoding, 'utf8');

  const exported = trafficToHar([captured], { maskSensitive: false }).log.entries[0];
  assert.equal(exported.request.postData.text, requestText);
  assert.equal(Object.hasOwn(exported.request.postData, 'encoding'), false);
  assert.equal(exported.response.content.text, responseText);
  assert.equal(Object.hasOwn(exported.response.content, 'encoding'), false);
});

test('genuine binary request and response captures retain base64 provenance in HAR export', () => {
  const requestBytes = Buffer.from([0x00, 0x01, 0x02, 0xff]);
  const responseBytes = Buffer.from([0x03, 0x04, 0x05, 0xfe]);
  const captured = captureBodies(requestBytes, responseBytes, 'application/octet-stream');

  assert.equal(captured.requestBodyEncoding, 'base64');
  assert.equal(captured.responseBodyEncoding, 'base64');

  const exported = trafficToHar([captured], { maskSensitive: false }).log.entries[0];
  assert.equal(exported.request.postData.text, requestBytes.toString('base64'));
  assert.equal(exported.request.postData.encoding, 'base64');
  assert.equal(exported.response.content.text, responseBytes.toString('base64'));
  assert.equal(exported.response.content.encoding, 'base64');
});
