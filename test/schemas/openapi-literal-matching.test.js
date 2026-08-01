import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileOpenApiPathPattern,
  getApiSpecBaseHost,
  normalizeApiSpecMatchHost,
  validateOpenApiSubmission
} from '../../src/api/openapi-validation.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

function createProxy() {
  const proxy = new ProxyServer(null);
  proxy.addApiSpec({
    title: 'Literal API',
    baseUrl: 'https://Api.Example.COM.:8443/v1',
    spec: {
      paths: {
        '/v1/a.b': { get: { operationId: 'dot' } },
        '/v1/a+b': { get: { operationId: 'plus' } },
        '/v1/groups/(active)': { get: { operationId: 'parentheses' } },
        '/v1/items/[latest]': { get: { operationId: 'brackets' } },
        '/v1/files/{name}.json': { get: { operationId: 'parameterWithSuffix' } },
        '/v1/literal/{broken': { get: { operationId: 'unmatchedBrace' } }
      }
    }
  });
  return proxy;
}

test('configured and observed API hosts require canonical exact equality', () => {
  const proxy = createProxy();

  assert.equal(getApiSpecBaseHost('https://Api.Example.COM.:8443/v1'), 'api.example.com');
  assert.equal(normalizeApiSpecMatchHost('API.EXAMPLE.COM.:443'), 'api.example.com');
  assert.equal(proxy.matchApiSpec('GET', '/v1/a.b', 'API.EXAMPLE.COM').operationId, 'dot');

  for (const lookalike of [
    'api.example.com.evil',
    'notapi.example.com',
    'api.example.co',
    'evil-api.example.com'
  ]) {
    assert.equal(proxy.matchApiSpec('GET', '/v1/a.b', lookalike), null, lookalike);
  }
  for (const malformed of ['api.example.com/path', 'api.example.com?x=1', 'user@api.example.com']) {
    assert.equal(normalizeApiSpecMatchHost(malformed), null, malformed);
    assert.equal(proxy.matchApiSpec('GET', '/v1/a.b', malformed), null, malformed);
  }
});

test('bare captured IPv6 hostnames match bracketed OpenAPI server URLs', () => {
  const proxy = new ProxyServer(null);
  proxy.addApiSpec({
    title: 'IPv6 API',
    baseUrl: 'https://[2001:db8::1]:8443',
    spec: { paths: { '/health': { get: { operationId: 'health' } } } }
  });

  assert.equal(getApiSpecBaseHost('https://[2001:db8::1]:8443'), '2001:db8::1');
  assert.equal(normalizeApiSpecMatchHost('2001:db8::1'), '2001:db8::1');
  assert.equal(normalizeApiSpecMatchHost('[2001:db8::1]:443'), '2001:db8::1');
  assert.equal(proxy.matchApiSpec('GET', '/health', '2001:db8::1').operationId, 'health');
  assert.equal(proxy.matchApiSpec('GET', '/health', '[2001:db8::1]:443').operationId, 'health');
  assert.equal(proxy.matchApiSpec('GET', '/health', '2001:db8::2'), null);
});

test('regex punctuation in OpenAPI path literals matches only itself', () => {
  const proxy = createProxy();
  const exactCases = [
    ['/v1/a.b', 'dot'],
    ['/v1/a+b', 'plus'],
    ['/v1/groups/(active)', 'parentheses'],
    ['/v1/items/[latest]', 'brackets'],
    ['/v1/literal/{broken', 'unmatchedBrace']
  ];
  for (const [pathname, operationId] of exactCases) {
    assert.equal(proxy.matchApiSpec('GET', pathname, 'api.example.com').operationId, operationId);
  }

  for (const lookalike of [
    '/v1/aXb',
    '/v1/ab',
    '/v1/groups/active',
    '/v1/items/l',
    '/v1/literal/Xbroken'
  ]) {
    assert.equal(proxy.matchApiSpec('GET', lookalike, 'api.example.com'), null, lookalike);
  }
});

test('well-formed path parameters still match exactly one non-empty segment', () => {
  const proxy = createProxy();

  assert.equal(
    proxy.matchApiSpec('GET', '/v1/files/readme.json?download=true', 'api.example.com').operationId,
    'parameterWithSuffix'
  );
  assert.equal(proxy.matchApiSpec('GET', '/v1/files/.json', 'api.example.com'), null);
  assert.equal(proxy.matchApiSpec('GET', '/v1/files/aXjson', 'api.example.com'), null);
  assert.equal(proxy.matchApiSpec('GET', '/v1/files/a/b.json', 'api.example.com'), null);
});

test('compiled patterns escape all literal segments around parameters', () => {
  const pattern = compileOpenApiPathPattern('/v1/{id}/price.$+({currency})');
  assert.ok(pattern);
  assert.equal(pattern.test('/v1/42/price.$+(USD)'), true);
  assert.equal(pattern.test('/v1/42/priceX$+(USD)'), false);
  assert.equal(pattern.test('/v1/42/price.$+USD'), false);
});

test('multiple placeholders use deterministic matching without rejecting valid templates', () => {
  const ambiguousPath = '/v1/{a}{b}{c}{d}{e}{f}{g}{h}/suffix';
  const adjacentMatcher = compileOpenApiPathPattern(ambiguousPath);
  assert.ok(adjacentMatcher);
  const started = performance.now();
  assert.equal(adjacentMatcher.test('/v1/xxxxxxxxxxxxxxxxxxxxxxxx/suffiy'), false);
  assert.ok(performance.now() - started < 250, 'nonmatching adjacent parameters must remain bounded');

  const validation = validateOpenApiSubmission({
    title: 'Multiple parameters',
    baseUrl: 'api.example.com',
    spec: {
      paths: {
        '/files/{name}.{ext}': { get: { operationId: 'fileByExtension' } },
        [ambiguousPath]: { get: { operationId: 'adjacent' } }
      }
    }
  });
  assert.equal(validation.error, undefined);

  const proxy = new ProxyServer(null);
  const restored = proxy.loadApiSpecs([{
    id: 'multi-parameter',
    title: 'Stored multiple parameters',
    baseUrl: 'api.example.com',
    spec: validation.value.spec
  }]);
  assert.equal(restored.discarded, 0);
  assert.equal(proxy.matchApiSpec('GET', '/files/report.pdf', 'api.example.com').operationId, 'fileByExtension');
  assert.equal(proxy.matchApiSpec('GET', '/files/.pdf', 'api.example.com'), null);
  assert.equal(proxy.matchApiSpec('GET', '/files/report.', 'api.example.com'), null);
  assert.equal(
    proxy.matchApiSpec('GET', '/v1/abcdefgh/suffix', 'api.example.com').operationId,
    'adjacent'
  );
});
