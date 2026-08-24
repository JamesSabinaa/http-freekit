import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ProxyServer } from '../../src/proxy/proxy-server.js';

function legacyRule(urlPattern, id = 'legacy-regexp') {
  return {
    id,
    enabled: true,
    method: 'GET',
    urlPattern,
    response: { status: 218, body: id }
  };
}

function requestThroughProxy(proxyPort, targetUrl) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: targetUrl,
      headers: { connection: 'close' }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
  });
}

test('global and sticky legacy patterns match repeated identical calls without advancing', () => {
  const url = 'https://example.test/path';
  for (const pattern of [/example/g, /https:\/\/example\.test\/path/y]) {
    const proxy = new ProxyServer(null);
    const rule = legacyRule(pattern);
    proxy.mockRules = [rule];

    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal(proxy._canStreamWithoutRequestBuffering('GET', url, {}), false);
      assert.equal(pattern.lastIndex, 0);
      assert.equal(proxy._findMockRule('GET', url, {}, ''), rule);
      assert.equal(pattern.lastIndex, 0);
    }
  }
});

test('legacy regex matching honors and restores a caller-provided nonzero lastIndex', () => {
  const url = 'https://example.test/path';
  const cases = [
    { pattern: /example/g, lastIndex: 8, matches: true },
    { pattern: /example/y, lastIndex: 8, matches: true },
    { pattern: /example/g, lastIndex: 9, matches: false },
    { pattern: /example/y, lastIndex: 7, matches: false }
  ];

  for (const { pattern, lastIndex, matches } of cases) {
    const proxy = new ProxyServer(null);
    const rule = legacyRule(pattern);
    proxy.mockRules = [rule];
    pattern.lastIndex = lastIndex;

    assert.equal(proxy._canStreamWithoutRequestBuffering('GET', url, {}), !matches);
    assert.equal(pattern.lastIndex, lastIndex);
    assert.equal(proxy._findMockRule('GET', url, {}, ''), matches ? rule : undefined);
    assert.equal(pattern.lastIndex, lastIndex);
  }
});

test('legacy regex lastIndex is restored when a proxied test lookup throws', () => {
  const sentinel = new Error('proxied RegExp test lookup failed');
  for (const invoke of [
    proxy => proxy._canStreamWithoutRequestBuffering('GET', 'https://example.test/', {}),
    proxy => proxy._findMockRule('GET', 'https://example.test/', {}, '')
  ]) {
    const target = /example/g;
    target.lastIndex = 4;
    const pattern = new Proxy(target, {
      get(regex, property) {
        if (property === 'test') {
          regex.lastIndex = 77;
          throw sentinel;
        }
        return Reflect.get(regex, property, regex);
      },
      set(regex, property, value) {
        return Reflect.set(regex, property, value, regex);
      }
    });
    const proxy = new ProxyServer(null);
    proxy.mockRules = [legacyRule(pattern)];

    assert.throws(() => invoke(proxy), error => error === sentinel);
    assert.equal(target.lastIndex, 4);
  }
});

test('stateful legacy misses preserve rule ordering and ordinary patterns', () => {
  const statefulMiss = /never/g;
  statefulMiss.lastIndex = 3;
  const stringFallback = legacyRule('example.test', 'string-fallback');
  const proxy = new ProxyServer(null);
  proxy.mockRules = [legacyRule(statefulMiss, 'stateful-miss'), stringFallback];

  assert.equal(
    proxy._findMockRule('GET', 'https://example.test/path', {}, ''),
    stringFallback
  );
  assert.equal(statefulMiss.lastIndex, 3);

  const ordinaryPattern = /example\.test/;
  const ordinaryRule = legacyRule(ordinaryPattern, 'ordinary-regexp');
  proxy.mockRules = [ordinaryRule, stringFallback];
  assert.equal(proxy._findMockRule('GET', 'https://example.test/path', {}, ''), ordinaryRule);
  assert.equal(ordinaryPattern.lastIndex, 0);

  const untouchedPattern = /example/g;
  untouchedPattern.lastIndex = 2;
  const passthroughRule = {
    enabled: true,
    matchers: [{ type: 'wildcard' }],
    action: { type: 'passthrough' }
  };
  proxy.mockRules = [
    passthroughRule,
    legacyRule(untouchedPattern, 'after-passthrough')
  ];
  assert.equal(proxy._findMockRule('GET', 'https://example.test/path', {}, ''), passthroughRule);
  assert.equal(untouchedPattern.lastIndex, 2);
});

test('two identical HTTP requests both use one global legacy mock rule', async t => {
  const pattern = /legacy-repeat/g;
  const proxy = new ProxyServer(null, { port: 0 });
  proxy.mockRules = [legacyRule(pattern, 'legacy-repeat')];
  await proxy.start();
  t.after(() => proxy.stop());

  const targetUrl = 'http://example.test/legacy-repeat';
  const first = await requestThroughProxy(proxy.server.address().port, targetUrl);
  const second = await requestThroughProxy(proxy.server.address().port, targetUrl);

  assert.deepEqual(first, { statusCode: 218, body: 'legacy-repeat' });
  assert.deepEqual(second, first);
  assert.equal(pattern.lastIndex, 0);
});
