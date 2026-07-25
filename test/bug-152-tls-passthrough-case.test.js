import assert from 'node:assert/strict';
import test from 'node:test';

import { ProxyServer } from '../src/proxy/proxy-server.js';

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
