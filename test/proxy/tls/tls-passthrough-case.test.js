import assert from 'node:assert/strict';
import test from 'node:test';

import { ProxyServer } from '../../../src/proxy/proxy-server.js';

test('TLS passthrough hostnames and wildcards are case-insensitive', () => {
  const proxy = new ProxyServer(null);
  proxy.setTlsPassthrough([
    'PINNED.Example.COM',
    '*.API.Example.COM',
    'pinned.example.com'
  ]);

  assert.deepEqual(proxy.tlsPassthrough, ['pinned.example.com', '*.api.example.com']);
  assert.equal(proxy._isTlsPassthrough('pinned.example.com'), true);
  assert.equal(proxy._isTlsPassthrough('PINNED.EXAMPLE.COM'), true);
  assert.equal(proxy._isTlsPassthrough('Service.Api.Example.Com'), true);
  assert.equal(proxy._isTlsPassthrough('api.example.com'), false);
  assert.equal(proxy._isTlsPassthrough('other.example.com'), false);
});

test('TLS passthrough rejects patterns that cannot match parsed CONNECT hostnames', () => {
  const proxy = new ProxyServer(null);
  proxy.setTlsPassthrough(['before.test']);
  const previous = proxy.tlsPassthrough;

  for (const host of [
    'https://example.test',
    'example.test:443',
    'user@example.test',
    '*example.test',
    'api.*.example.test',
    '*'
  ]) {
    assert.throws(() => proxy.setTlsPassthrough([host]), /hostname, IP address/);
    assert.equal(proxy.tlsPassthrough, previous);
  }

  proxy.setTlsPassthrough(['[::1]', '*.Example.Test.']);
  assert.deepEqual(proxy.tlsPassthrough, ['::1', '*.example.test']);
});
