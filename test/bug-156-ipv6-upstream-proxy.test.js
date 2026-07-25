import assert from 'node:assert/strict';
import test from 'node:test';
import { ProxyServer } from '../src/proxy/proxy-server.js';

test('IPv6 upstream proxy hosts are bracketed in proxy URLs', () => {
  const proxy = new ProxyServer(null);

  proxy.setUpstreamProxy({ host: '::1', port: 8080, type: 'http' });
  assert.equal(proxy._getUpstreamProxyUrl(), 'http://[::1]:8080');
  assert.doesNotThrow(() => proxy._getUpstreamAgent());
  proxy._destroyUpstreamAgent();

  proxy.setUpstreamProxy({ host: '2001:db8::1', port: 1080, type: 'socks5' });
  assert.equal(proxy._getUpstreamProxyUrl(), 'socks5://[2001:db8::1]:1080');
  assert.doesNotThrow(() => proxy._getUpstreamAgent());
  proxy._destroyUpstreamAgent();
});

test('already-bracketed IPv6 and DNS upstream hosts retain valid URL authorities', () => {
  const proxy = new ProxyServer(null);

  proxy.setUpstreamProxy({ host: '[::1]', port: 443, type: 'https', auth: 'user:p@ss' });
  assert.equal(proxy._getUpstreamProxyUrl(), 'https://user:p%40ss@[::1]:443');

  proxy.setUpstreamProxy({ host: 'proxy.example', port: 8080, type: 'http' });
  assert.equal(proxy._getUpstreamProxyUrl(), 'http://proxy.example:8080');
});
