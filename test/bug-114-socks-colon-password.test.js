import assert from 'node:assert/strict';
import test from 'node:test';
import { SocksClient } from 'socks';

import { ProxyServer } from '../src/proxy/proxy-server.js';

test('plain HTTP SOCKS authentication preserves all password colons', async () => {
  const originalCreateConnection = SocksClient.createConnection;
  const received = [];
  SocksClient.createConnection = async options => {
    received.push(options.proxy);
    return { socket: {} };
  };

  try {
    const cases = [
      { auth: 'user:pa:ss:word', userId: 'user', password: 'pa:ss:word' },
      { auth: 'username', userId: 'username', password: '' },
      { auth: ':secret', userId: '', password: 'secret' },
      { auth: 'user:', userId: 'user', password: '' }
    ];
    for (const credentials of cases) {
      const proxy = new ProxyServer(null);
      proxy.setUpstreamProxy({
        host: '127.0.0.1',
        port: 1080,
        type: 'socks5h',
        auth: credentials.auth
      });
      await proxy._connectViaSocks('origin.example', 80);
      assert.equal(received.at(-1).userId, credentials.userId, credentials.auth);
      assert.equal(received.at(-1).password, credentials.password, credentials.auth);
      const proxyUrl = new URL(proxy._getUpstreamProxyUrl());
      assert.equal(decodeURIComponent(proxyUrl.username), credentials.userId, credentials.auth);
      assert.equal(decodeURIComponent(proxyUrl.password), credentials.password, credentials.auth);
    }
  } finally {
    SocksClient.createConnection = originalCreateConnection;
  }
});
