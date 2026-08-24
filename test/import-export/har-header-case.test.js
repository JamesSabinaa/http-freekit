import assert from 'node:assert/strict';
import test from 'node:test';
import { trafficToHar } from '../../src/api/har-converter.js';

test('HAR metadata header lookup is case-insensitive', () => {
  const har = trafficToHar([{
    timestamp: '2026-01-01T00:00:00.000Z',
    method: 'POST',
    url: 'https://example.test/start',
    requestHeaders: { 'Content-Type': 'application/request+json' },
    requestBody: '{}',
    responseHeaders: {
      'CONTENT-TYPE': ['application/response+json'],
      Location: ['/next']
    },
    responseBody: '{}',
    statusCode: 302
  }], { maskSensitive: false });

  const entry = har.log.entries[0];
  assert.equal(entry.request.postData.mimeType, 'application/request+json');
  assert.equal(entry.response.content.mimeType, 'application/response+json');
  assert.equal(entry.response.redirectURL, '/next');
});

test('HAR redirect metadata preserves a valid numeric-zero header value', () => {
  const har = trafficToHar([{
    timestamp: '2026-01-01T00:00:00.000Z',
    method: 'GET',
    url: 'https://example.test/start',
    requestHeaders: {},
    responseHeaders: { Location: [0] },
    statusCode: 302
  }], { maskSensitive: false });

  const response = har.log.entries[0].response;
  assert.deepEqual(response.headers, [{ name: 'Location', value: '0' }]);
  assert.equal(response.redirectURL, '0');
});
