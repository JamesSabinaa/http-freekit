import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import { SocksClient } from 'socks';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
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
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
  });
}

function configureSocks(proxy, type) {
  proxy.setUpstreamProxy({
    host: '[2001:db8::1]',
    port: 1080,
    type,
    auth: 'user:pass'
  });
}

test('plain SOCKS variants apply their configured local or remote DNS semantics', async () => {
  const originalCreateConnection = SocksClient.createConnection;
  const connectionOptions = [];
  SocksClient.createConnection = async options => {
    connectionOptions.push(options);
    return { socket: { connection: connectionOptions.length } };
  };

  try {
    const cases = [
      { type: 'socks4', resolved: '192.0.2.44', expectedHost: '192.0.2.44', family: 4, socksType: 4 },
      { type: 'socks4a', expectedHost: 'origin.example', socksType: 4 },
      { type: 'socks5', resolved: '2001:db8::55', expectedHost: '2001:db8::55', family: undefined, socksType: 5 },
      { type: 'socks5h', expectedHost: 'origin.example', socksType: 5 }
    ];

    for (const scenario of cases) {
      const lookups = [];
      const proxy = new ProxyServer(null, {
        upstreamConnectTimeoutMs: 4321,
        dnsLookup: async (hostname, options) => {
          lookups.push({ hostname, options });
          return { address: scenario.resolved, family: net.isIP(scenario.resolved) };
        }
      });
      configureSocks(proxy, scenario.type);
      const socket = await proxy._connectViaSocks('origin.example', 8080);
      const options = connectionOptions.at(-1);

      assert.deepEqual(socket, { connection: connectionOptions.length }, scenario.type);
      assert.equal(options.proxy.host, '2001:db8::1', scenario.type);
      assert.equal(options.proxy.type, scenario.socksType, scenario.type);
      assert.equal(options.proxy.userId, 'user', scenario.type);
      assert.equal(options.proxy.password, 'pass', scenario.type);
      assert.equal(options.destination.host, scenario.expectedHost, scenario.type);
      assert.equal(options.destination.port, 8080, scenario.type);
      assert.equal(options.timeout, 4321, scenario.type);
      if (scenario.resolved) {
        assert.deepEqual(lookups, [{
          hostname: 'origin.example',
          options: scenario.family === 4 ? { family: 4 } : {}
        }], scenario.type);
      } else {
        assert.deepEqual(lookups, [], scenario.type);
      }
    }
  } finally {
    SocksClient.createConnection = originalCreateConnection;
  }
});

test('literal destinations bypass DNS and SOCKS4 variants reject IPv6 explicitly', async () => {
  const originalCreateConnection = SocksClient.createConnection;
  const destinations = [];
  SocksClient.createConnection = async options => {
    destinations.push(options.destination.host);
    return { socket: {} };
  };

  try {
    const dnsLookup = async () => assert.fail('literal destinations must not use DNS');
    for (const type of ['socks4', 'socks4a', 'socks5', 'socks5h']) {
      const proxy = new ProxyServer(null, { dnsLookup });
      configureSocks(proxy, type);
      await proxy._connectViaSocks('192.0.2.80', 80);
      assert.equal(destinations.at(-1), '192.0.2.80', type);
    }
    for (const type of ['socks5', 'socks5h']) {
      const proxy = new ProxyServer(null, { dnsLookup });
      configureSocks(proxy, type);
      await proxy._connectViaSocks('[2001:db8::80]', 80);
      assert.equal(destinations.at(-1), '2001:db8::80', type);
    }

    const successfulConnections = destinations.length;
    for (const type of ['socks4', 'socks4a']) {
      const proxy = new ProxyServer(null, { dnsLookup });
      configureSocks(proxy, type);
      await assert.rejects(
        proxy._connectViaSocks('2001:db8::80', 80),
        error => error?.code === 'EAFNOSUPPORT' && /does not support IPv6 destinations/.test(error.message),
        type
      );
    }
    assert.equal(destinations.length, successfulConnections);
  } finally {
    SocksClient.createConnection = originalCreateConnection;
  }
});

test('local DNS failures stop before SOCKS connection and invalid SOCKS4 results are explicit', async () => {
  const originalCreateConnection = SocksClient.createConnection;
  let socksConnections = 0;
  SocksClient.createConnection = async () => {
    socksConnections++;
    return { socket: {} };
  };

  try {
    for (const type of ['socks4', 'socks5']) {
      const dnsError = Object.assign(new Error(`cannot resolve for ${type}`), {
        code: 'ENOTFOUND',
        hostname: 'missing.example'
      });
      const proxy = new ProxyServer(null, { dnsLookup: async () => { throw dnsError; } });
      configureSocks(proxy, type);
      await assert.rejects(proxy._connectViaSocks('missing.example', 80), error => error === dnsError);
    }
    assert.equal(socksConnections, 0);

    const proxy = new ProxyServer(null, {
      dnsLookup: async () => ({ address: '2001:db8::90', family: 6 })
    });
    configureSocks(proxy, 'socks4');
    await assert.rejects(
      proxy._connectViaSocks('ipv6-only.example', 80),
      error => error?.code === 'EAFNOSUPPORT' && /requires an IPv4 destination/.test(error.message)
    );
    assert.equal(socksConnections, 0);
  } finally {
    SocksClient.createConnection = originalCreateConnection;
  }
});

test('plain HTTP selects the SOCKS connector while noProxy destinations bypass it', async t => {
  const originRequests = [];
  const origin = http.createServer((request, response) => {
    originRequests.push({ url: request.url, host: request.headers.host });
    response.end(`origin:${request.url}`);
  });
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  proxy.setUpstreamProxy({
    host: '127.0.0.1',
    port: 1080,
    type: 'socks5',
    noProxy: ['127.0.0.1']
  });
  const socksDestinations = [];
  proxy._connectViaSocks = async (hostname, port) => {
    socksDestinations.push({ hostname, port });
    const socket = net.connect(originPort, '127.0.0.1');
    await once(socket, 'connect');
    return socket;
  };
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin);
  });

  const proxied = await requestThroughProxy(
    proxy.server.address().port,
    `http://through-socks.example:${originPort}/proxied`
  );
  const direct = await requestThroughProxy(
    proxy.server.address().port,
    `http://127.0.0.1:${originPort}/direct`
  );

  assert.deepEqual(proxied, { statusCode: 200, body: 'origin:/proxied' });
  assert.deepEqual(direct, { statusCode: 200, body: 'origin:/direct' });
  assert.deepEqual(socksDestinations, [{ hostname: 'through-socks.example', port: originPort }]);
  assert.deepEqual(originRequests, [
    { url: '/proxied', host: `through-socks.example:${originPort}` },
    { url: '/direct', host: `127.0.0.1:${originPort}` }
  ]);
});
