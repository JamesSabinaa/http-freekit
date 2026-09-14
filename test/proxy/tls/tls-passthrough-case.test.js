import assert from 'node:assert/strict';
import test from 'node:test';

import { ProxyServer } from '../../../src/proxy/proxy-server.js';

test('TLS passthrough and verification exceptions match equivalent IPv6 addresses', () => {
  const proxy = new ProxyServer(null);
  for (const [expanded, compact] of [
    ['0:0:0:0:0:0:0:1', '::1'],
    ['2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['::ffff:192.0.2.1', '::ffff:c000:201'],
    ['fe80:0:0:0:0:0:0:1%eth0', 'fe80::1%eth0']
  ]) {
    for (const [configured, target] of [[expanded, compact], [compact, expanded]]) {
      proxy.setTlsPassthrough([`[${configured}]`]);
      proxy.setHttpsWhitelist([configured]);
      assert.equal(proxy._isTlsPassthrough(target), true);
      assert.equal(proxy._isHttpsWhitelisted(`[${target}]`), true);
      assert.equal(proxy._isTlsPassthrough('2001:db8::2'), false);
      assert.equal(proxy._isHttpsWhitelisted('2001:db8::2'), false);
      assert.equal(proxy._isHttpsWhitelisted('fe80::1%eth1'), false);
    }
  }
});

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
