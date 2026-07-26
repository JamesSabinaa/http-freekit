import assert from 'node:assert/strict';
import test from 'node:test';

import { trafficToHar } from '../src/api/har-converter.js';
import { McpServerBridge } from '../src/mcp/mcp-server.js';

const REDACTED = '[REDACTED]';

function capturedTraffic() {
  return {
    id: 'cookie-secrets',
    timestamp: '2026-01-01T00:00:00.000Z',
    protocol: 'https',
    method: 'GET',
    host: 'example.test',
    url: 'https://example.test/private',
    statusCode: 200,
    requestHeaders: {
      Cookie: ['session=request-secret', 'theme=dark'],
      Accept: 'application/json'
    },
    responseHeaders: {
      'Set-Cookie': ['refresh=response-secret; HttpOnly', 'theme=light'],
      'Content-Type': 'application/json'
    },
    requestCookies: [{
      name: 'session',
      value: 'request-secret',
      path: '/private',
      domain: 'example.test',
      secure: true,
      sameSite: 'Strict'
    }],
    responseCookies: [{
      name: 'refresh',
      value: 'response-secret',
      path: '/',
      expires: '2027-01-01T00:00:00.000Z',
      httpOnly: true
    }]
  };
}

function assertMaskedEntry(entry, captured) {
  assert.deepEqual(entry.request.cookies, [
    { ...captured.requestCookies[0], value: REDACTED }
  ]);
  assert.deepEqual(entry.response.cookies, [
    { ...captured.responseCookies[0], value: REDACTED }
  ]);
  assert.notStrictEqual(entry.request.cookies, captured.requestCookies);
  assert.notStrictEqual(entry.request.cookies[0], captured.requestCookies[0]);
  assert.notStrictEqual(entry.response.cookies, captured.responseCookies);
  assert.notStrictEqual(entry.response.cookies[0], captured.responseCookies[0]);
  assert.deepEqual(entry.request.headers.filter(header => header.name === 'Cookie'), [
    { name: 'Cookie', value: REDACTED },
    { name: 'Cookie', value: REDACTED }
  ]);
  assert.deepEqual(entry.response.headers.filter(header => header.name === 'Set-Cookie'), [
    { name: 'Set-Cookie', value: REDACTED },
    { name: 'Set-Cookie', value: REDACTED }
  ]);
}

test('default and explicit sensitive HAR masking redact structured cookie values', () => {
  for (const options of [undefined, { maskSensitive: true }]) {
    const captured = capturedTraffic();
    const original = structuredClone(captured);
    const har = options === undefined
      ? trafficToHar([captured])
      : trafficToHar([captured], options);

    assertMaskedEntry(har.log.entries[0], captured);
    assert.deepEqual(captured, original);
  }
});

test('disabled sensitive masking preserves structured cookies byte-for-byte', () => {
  const captured = capturedTraffic();
  const original = structuredClone(captured);

  const entry = trafficToHar([captured], { maskSensitive: false }).log.entries[0];

  assert.equal(JSON.stringify(entry.request.cookies), JSON.stringify(original.requestCookies));
  assert.equal(JSON.stringify(entry.response.cookies), JSON.stringify(original.responseCookies));
  assert.equal(entry.request.headers.find(header => header.name === 'Cookie').value, 'session=request-secret');
  assert.equal(entry.response.headers.find(header => header.name === 'Set-Cookie').value,
    'refresh=response-secret; HttpOnly');
  assert.deepEqual(captured, original);
});

test('cookie conversion tolerates empty and malformed cookie fields', () => {
  const malformedEntries = [
    null,
    'raw-cookie',
    42,
    ['nested-cookie'],
    { value: 'orphaned-secret', path: '/' }
  ];
  const captured = {
    timestamp: '2026-01-01T00:00:00.000Z',
    requestCookies: malformedEntries,
    responseCookies: { name: 'not-an-array', value: 'secret' }
  };
  const original = structuredClone(captured);

  const entry = trafficToHar([captured]).log.entries[0];

  assert.deepEqual(entry.request.cookies, [
    null,
    'raw-cookie',
    42,
    ['nested-cookie'],
    { value: REDACTED, path: '/' }
  ]);
  assert.deepEqual(entry.response.cookies, []);
  assert.deepEqual(captured, original);

  const empty = trafficToHar([{
    timestamp: '2026-01-01T00:00:00.000Z',
    requestCookies: [],
    responseCookies: []
  }]).log.entries[0];
  assert.deepEqual(empty.request.cookies, []);
  assert.deepEqual(empty.response.cookies, []);
});

test('MCP HAR export masks structured cookies without mutating captured traffic', () => {
  const captured = capturedTraffic();
  const original = structuredClone(captured);
  const bridge = new McpServerBridge({
    apiServer: { _getHarExportTraffic: () => [captured] },
    proxyServer: { getStats: () => ({}), mockRules: [], breakpointRules: [] },
    interceptorManager: { getAll: async () => [] }
  });

  const result = bridge._handleExportTraffic({});

  assert.notEqual(result.isError, true);
  const entry = JSON.parse(result.content[0].text).log.entries[0];
  assertMaskedEntry(entry, captured);
  assert.deepEqual(captured, original);
});
