import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import zlib from 'node:zlib';

import { ProxyServer } from '../src/proxy/proxy-server.js';

function requestThroughProxy(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: `http://unreachable.invalid${path}`,
      method: 'POST',
      headers: {
        'content-length': String(body.length),
        ...headers
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function startProxy(t, rules, options = {}) {
  const captured = [];
  const proxy = new ProxyServer(null, {
    port: 0,
    onRequest: request => captured.push(request),
    ...options
  });
  rules.forEach(rule => proxy.addMockRule(rule));
  await proxy.start();
  t.after(() => proxy.stop());
  return { proxy, captured };
}

test('body matcher sees tokens beyond the bounded capture preview', async t => {
  const token = 'match-after-display-cap';
  const body = Buffer.concat([
    Buffer.alloc(512 * 1024 + 32, 0x61),
    Buffer.from(token)
  ]);
  const { proxy, captured } = await startProxy(t, [{
    matchers: [{ type: 'body-contains', value: token }],
    action: { type: 'fixed-response', status: 209, body: 'tail matched' }
  }]);

  const response = await requestThroughProxy(proxy.server.address().port, '/tail', body);

  assert.deepEqual(response, { statusCode: 209, body: 'tail matched' });
  const recorded = captured.find(request => request.statusMessage === 'Mocked');
  assert.ok(recorded);
  assert.equal(recorded.requestBodyTruncated, true);
  assert.equal(Buffer.byteLength(recorded.requestBody), 512 * 1024);
  assert.equal(recorded.requestBody.includes(token), false);
});

test('gzip request bodies are decoded for body and JSON matchers', async t => {
  const { proxy } = await startProxy(t, [{
    matchers: [
      { type: 'path', matchType: 'exact', value: '/json' },
      { type: 'json-body-includes', value: '{"match":true}' }
    ],
    action: { type: 'fixed-response', status: 210, body: 'json matched' }
  }, {
    matchers: [
      { type: 'path', matchType: 'exact', value: '/text' },
      { type: 'body-contains', value: 'compressed token' }
    ],
    action: { type: 'fixed-response', status: 211, body: 'body matched' }
  }]);

  const jsonResponse = await requestThroughProxy(
    proxy.server.address().port,
    '/json',
    zlib.gzipSync(Buffer.from('{"match":true,"other":"value"}')),
    { 'content-encoding': 'gzip', 'content-type': 'application/json' }
  );
  const bodyResponse = await requestThroughProxy(
    proxy.server.address().port,
    '/text',
    zlib.gzipSync(Buffer.from('prefix compressed token suffix')),
    { 'content-encoding': 'gzip', 'content-type': 'text/plain' }
  );

  assert.deepEqual(jsonResponse, { statusCode: 210, body: 'json matched' });
  assert.deepEqual(bodyResponse, { statusCode: 211, body: 'body matched' });
});

test('breakpoint body matchers use decoded input within existing ceilings', () => {
  const proxy = new ProxyServer(null, {
    maxBufferedBodyBytes: 2048,
    maxDecompressedBodyBytes: 1024
  });
  const rule = {
    enabled: true,
    matchers: [{ type: 'json-body-includes', value: '{"match":true}' }]
  };
  proxy.breakpointRules = [rule];
  const compressed = zlib.gzipSync(Buffer.from('{"match":true,"other":"value"}'));
  const matcherBody = proxy._requestBodyForMatching(compressed, { 'Content-Encoding': 'gzip' });

  assert.equal(proxy._checkBreakpoint('POST', 'http://example.test/', {}, matcherBody), rule);
  const overCeiling = zlib.gzipSync(Buffer.from(JSON.stringify({ match: true, padding: 'x'.repeat(4096) })));
  assert.equal(proxy._requestBodyForMatching(overCeiling, { 'content-encoding': 'gzip' }), '');
  assert.equal(proxy._checkBreakpoint('POST', 'http://example.test/', {},
    proxy._requestBodyForMatching(overCeiling, { 'content-encoding': 'gzip' })), undefined);
});

test('identity-only content-coding lists preserve matcher input case-insensitively', () => {
  const proxy = new ProxyServer(null);
  const body = Buffer.from('identity matcher token');

  for (const contentEncoding of [
    'Identity',
    'IDENTITY, identity',
    ['Identity', 'IDENTITY, identity']
  ]) {
    assert.equal(
      proxy._requestBodyForMatching(body, { 'Content-Encoding': contentEncoding }),
      'identity matcher token'
    );
  }
});

test('failed or unsupported non-identity codings never expose encoded matcher bytes', () => {
  const proxy = new ProxyServer(null);
  const body = Buffer.from('raw bytes that are not gzip');

  assert.equal(proxy._requestBodyForMatching(body, { 'content-encoding': 'GZip' }), '');
  assert.equal(proxy._requestBodyForMatching(body, { 'content-encoding': 'identity, unsupported' }), '');
  assert.equal(proxy._requestBodyForMatching(body, { 'content-encoding': ['Identity', 'BR'] }), '');
});
