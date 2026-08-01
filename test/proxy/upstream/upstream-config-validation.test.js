import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../../../src/api/api-server.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';
import { restoreUpstreamProxySetting } from '../../../src/proxy/upstream-proxy-config.js';

function postJson(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/upstream-proxy',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

test('direct upstream configuration accepts supported types and documented defaults', () => {
  const proxy = new ProxyServer(null);
  const defaults = {
    http: 8080,
    https: 443,
    socks4: 1080,
    socks4a: 1080,
    socks5: 1080,
    socks5h: 1080
  };

  for (const [type, port] of Object.entries(defaults)) {
    proxy.setUpstreamProxy({ host: 'proxy.example', type });
    assert.deepEqual(proxy.upstreamProxy, {
      host: 'proxy.example',
      port,
      auth: null,
      type,
      noProxy: []
    });
  }

  proxy.setUpstreamProxy({
    host: '[2001:db8::1]',
    type: 'socks5h',
    noProxy: [' localhost, .example.test ', '[::1]:9443']
  });
  assert.equal(proxy.upstreamProxy.host, '[2001:db8::1]');
  assert.deepEqual(proxy.upstreamProxy.noProxy, ['localhost', '.example.test', '[::1]:9443']);
  assert.equal(proxy._getUpstreamProxyUrl(), 'socks5h://[2001:db8::1]:1080');
});

test('invalid direct configuration cannot mutate live proxy state or its agent generation', () => {
  const proxy = new ProxyServer(null);
  proxy.setUpstreamProxy({ host: 'known-good.example', port: 8080, type: 'http' });
  const previousConfig = proxy.upstreamProxy;
  const previousGeneration = proxy.getUpstreamProxyGeneration();
  let destroyed = 0;
  proxy._upstreamAgent = { destroy: () => { destroyed++; } };

  const invalidConfigs = [
    {},
    { host: '' },
    { host: '   ' },
    { host: 'http://proxy.example', port: 8080 },
    { host: '[not-ipv6]', port: 8080 },
    { host: 'proxy.example', type: 'ftp', port: 21 },
    { host: 'proxy.example', type: null, port: 8080 },
    { host: 'proxy.example', port: 0 },
    { host: 'proxy.example', port: 65536 },
    { host: 'proxy.example', port: 1.5 },
    { host: 'proxy.example', port: '8080' }
  ];

  for (const config of invalidConfigs) {
    assert.throws(
      () => proxy.setUpstreamProxy(config),
      error => error?.code === 'ERR_INVALID_UPSTREAM_PROXY_CONFIG'
    );
    assert.equal(proxy.upstreamProxy, previousConfig);
    assert.equal(proxy.getUpstreamProxyGeneration(), previousGeneration);
  }
  assert.equal(destroyed, 0);
});

test('upstream proxy API rejects invalid submissions without persistence or mutation', async t => {
  const proxy = new ProxyServer(null);
  proxy.setUpstreamProxy({
    host: 'existing.example',
    port: 3128,
    type: 'http',
    noProxy: ['localhost']
  });
  const previousConfig = proxy.upstreamProxy;
  const persisted = [];
  const api = new ApiServer(proxy, null, null);
  api.settings = { set: (...args) => persisted.push(args) };
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  for (const body of [
    { host: '', port: 8080, type: 'http' },
    { host: 'proxy.example', port: 70000, type: 'http' },
    { host: 'proxy.example', port: 8080, type: 'unknown' },
    { host: 'proxy.example', port: null, type: 'http' }
  ]) {
    const result = await postJson(port, body);
    assert.equal(result.statusCode, 400);
    assert.match(result.body.error, /upstream proxy/i);
    assert.equal(proxy.upstreamProxy, previousConfig);
    assert.deepEqual(persisted, []);
  }

  const valid = await postJson(port, {
    host: '[::1]',
    type: 'https',
    noProxy: 'localhost, .example.test, [::1]:9443'
  });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(valid.body.upstreamProxy, {
    host: '[::1]',
    port: 443,
    auth: null,
    type: 'https',
    noProxy: ['localhost', '.example.test', '[::1]:9443']
  });
  assert.deepEqual(persisted, [['upstreamProxy', proxy.upstreamProxy]]);
});

test('startup ignores and clears malformed persisted upstream proxy settings safely', () => {
  const proxy = new ProxyServer(null);
  const writes = [];
  const messages = [];
  const settings = {
    get: () => ({ host: 'proxy.example', port: 70000, type: 'http' }),
    set: (...args) => writes.push(args)
  };
  const logger = { error: message => messages.push(message) };

  assert.equal(restoreUpstreamProxySetting(proxy, settings, logger), false);
  assert.equal(proxy.upstreamProxy, null);
  assert.equal(proxy.getUpstreamProxyGeneration(), 0);
  assert.deepEqual(writes, [['upstreamProxy', null]]);
  assert.match(messages[0], /ignoring invalid saved upstream proxy/i);

  settings.set = () => { throw new Error('read-only settings'); };
  assert.doesNotThrow(() => restoreUpstreamProxySetting(proxy, settings, logger));
  assert.match(messages.at(-1), /could not clear invalid saved upstream proxy/i);
});

test('startup restores valid IPv6 and noProxy settings', () => {
  const proxy = new ProxyServer(null);
  const saved = {
    host: '2001:db8::1',
    type: 'socks4a',
    noProxy: ['localhost', '[::1]:9443']
  };
  const settings = {
    get: () => saved,
    set: () => assert.fail('valid settings must not be rewritten')
  };

  assert.equal(restoreUpstreamProxySetting(proxy, settings), true);
  assert.deepEqual(proxy.upstreamProxy, {
    host: '2001:db8::1',
    port: 1080,
    auth: null,
    type: 'socks4a',
    noProxy: ['localhost', '[::1]:9443']
  });
});
