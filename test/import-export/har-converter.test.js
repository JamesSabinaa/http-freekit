import assert from 'node:assert/strict';
import test from 'node:test';
import { trafficToHar } from '../../src/api/har-converter.js';

test('HAR export identifies HTTP/2 requests and responses', () => {
  const har = trafficToHar([{
    id: 'h2-request',
    timestamp: '2026-01-01T00:00:00.000Z',
    protocol: 'h2',
    method: 'GET',
    url: 'https://example.test/'
  }]);

  assert.equal(har.log.entries[0].request.httpVersion, 'HTTP/2');
  assert.equal(har.log.entries[0].response.httpVersion, 'HTTP/2');
});

test('HAR export keeps HTTP/1.1 for non-H2 traffic', () => {
  const har = trafficToHar([{
    id: 'http-request',
    timestamp: '2026-01-01T00:00:00.000Z',
    protocol: 'https',
    method: 'GET',
    url: 'https://example.test/'
  }]);

  assert.equal(har.log.entries[0].request.httpVersion, 'HTTP/1.1');
  assert.equal(har.log.entries[0].response.httpVersion, 'HTTP/1.1');
});
