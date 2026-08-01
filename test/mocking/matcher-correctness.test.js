import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ProxyServer } from '../../src/proxy/proxy-server.js';

function matches(matcher, { url = 'https://example.test/', headers = {}, body = '' } = {}) {
  return new ProxyServer(null)._evaluateMatcher(matcher, 'POST', url, headers, body);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.once('error', reject);
  });
}

function request(port, target, headers) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: '127.0.0.1',
      port,
      path: target,
      headers
    }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

test('host and hostname matchers compare DNS names case-insensitively', () => {
  assert.equal(matches(
    { type: 'host', value: 'EXAMPLE.TEST:8443' },
    { url: 'https://example.test:8443/path' }
  ), true);
  assert.equal(matches(
    { type: 'hostname', value: '*.EXAMPLE.TEST' },
    { url: 'https://api.example.test/path' }
  ), true);
  assert.equal(matches(
    { type: 'hostname', value: '*.EXAMPLE.TEST' },
    { url: 'https://notexample.test/path' }
  ), false);
});

test('header wildcard matchers escape punctuation and support repeated mixed-case headers', () => {
  const matcher = { type: 'header', name: 'X-Release', value: 'release.1+*?' };

  assert.equal(matches(matcher, {
    headers: { 'X-RELEASE': ['old', 'release.1+stable?'] }
  }), true);
  assert.equal(matches(matcher, {
    headers: { 'x-release': 'releaseX1stable' }
  }), false);
  assert.equal(matches(
    { type: 'header', name: 'X-Mode', value: '' },
    { headers: { 'x-mode': 'present' } }
  ), true);

  const proxy = new ProxyServer(null);
  const prototypeNamedHeaders = proxy._rawHeadersToObject([
    'constructor', 'first',
    'constructor', 'second',
    '__proto__', 'retained'
  ], { stripUpstreamHeaders: false });
  assert.equal(proxy._evaluateMatcher(
    { type: 'header', name: 'constructor', value: 'second' },
    'GET', 'https://example.test/', prototypeNamedHeaders, ''
  ), true);
  assert.equal(proxy._evaluateMatcher(
    { type: 'header', name: '__proto__', value: 'retained' },
    'GET', 'https://example.test/', prototypeNamedHeaders, ''
  ), true);
});

test('live HTTP/1 matching preserves separate repeated header field values', async t => {
  let originHits = 0;
  const origin = http.createServer((incoming, response) => {
    originHits++;
    incoming.resume();
    response.end('origin');
  });
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  proxy.addMockRule({
    matchers: [{ type: 'header', name: 'X-Release', value: 'release.1+*?' }],
    action: { type: 'fixed-response', status: 219 }
  });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await new Promise(resolve => origin.close(resolve));
  });

  const statusCode = await request(
    proxy.server.address().port,
    `http://127.0.0.1:${originPort}/repeated`,
    { 'X-Release': ['old', 'release.1+stable?'] }
  );
  assert.equal(statusCode, 219);
  assert.equal(originHits, 0);
});

test('JSON matchers ignore object property order but retain array order', () => {
  assert.equal(matches(
    { type: 'json-body-exact', value: '{"nested":{"first":1,"second":2},"enabled":true}' },
    { body: '{"enabled":true,"nested":{"second":2,"first":1}}' }
  ), true);
  assert.equal(matches(
    { type: 'json-body-exact', value: '{"items":[1,2]}' },
    { body: '{"items":[2,1]}' }
  ), false);
  assert.equal(matches(
    { type: 'json-body-includes', value: '{"nested":{"first":1,"second":2}}' },
    { body: '{"extra":true,"nested":{"second":2,"first":1}}' }
  ), true);
  assert.equal(matches(
    { type: 'json-body-includes', value: '{"0":"zero"}' },
    { body: '["zero"]' }
  ), false);
  assert.equal(matches(
    { type: 'json-body-includes', value: '["zero"]' },
    { body: '{"0":"zero"}' }
  ), false);
});

test('multipart matcher accepts quoted boundaries and reordered disposition parameters', () => {
  const boundary = 'AaB03x';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; filename="ignored.txt"; name="upload"',
    'Content-Type: text/plain',
    '',
    'matched value',
    `--${boundary}--`,
    ''
  ].join('\r\n');
  const request = {
    headers: { 'Content-Type': `multipart/form-data; charset=utf-8; boundary="${boundary}"` },
    body
  };

  assert.equal(matches(
    { type: 'multipart-form-data', name: 'upload', value: 'matched value' },
    request
  ), true);
  assert.equal(matches(
    { type: 'multipart-form-data', name: 'upload' },
    request
  ), true);
  assert.equal(matches(
    { type: 'multipart-form-data', name: 'upload', value: 'different' },
    request
  ), false);

  const embeddedBoundaryRequest = {
    headers: request.headers,
    body: body.replace('matched value', `prefix--${boundary}suffix`)
  };
  assert.equal(matches(
    { type: 'multipart-form-data', name: 'upload', value: `prefix--${boundary}suffix` },
    embeddedBoundaryRequest
  ), true);
  assert.equal(matches(
    { type: 'multipart-form-data', name: 'upload', value: 'prefix' },
    embeddedBoundaryRequest
  ), false);
});
