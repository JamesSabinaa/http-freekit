import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function request(port, url) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: url }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.once('error', reject);
  });
}

test('IPv6 bypass entries compare address values while retaining port restrictions', () => {
  const proxy = new ProxyServer(null);
  const groups = [
    ['::1', '0:0:0:0:0:0:0:1'],
    ['2001:db8::a', '2001:0DB8:0:0:0:0:0:000A'],
    ['::ffff:192.0.2.1', '0:0:0:0:0:ffff:c000:201']
  ];
  for (const spellings of groups) {
    for (const address of spellings) {
      for (const entry of [address, `[${address}]`, `[${address}]:8443`]) {
        proxy.setUpstreamProxy({ host: 'proxy.test', noProxy: [entry] });
        for (const target of spellings) {
          for (const host of [target, `[${target}]`]) {
            assert.equal(proxy._shouldUseUpstreamProxy(host, 8443), false, `${entry} should bypass ${host}`);
            assert.equal(proxy._shouldUseUpstreamProxy(host, 9443), entry.endsWith(']:8443'), entry);
          }
        }
        assert.equal(proxy._shouldUseUpstreamProxy('::2', 8443), true);
        assert.equal(proxy._shouldUseUpstreamProxy('unrelated.test', 8443), true);
      }
    }
  }
});

test('expanded IPv6 bypass entries reach the local origin instead of the upstream', async t => {
  let originHits = 0;
  let upstreamHits = 0;
  const origin = http.createServer((_req, res) => { originHits++; res.end('direct'); });
  const upstream = http.createServer((_req, res) => { upstreamHits++; res.end('upstream'); });
  const proxy = new ProxyServer(null, { port: 0 });
  t.after(async () => {
    await proxy.stop();
    await Promise.all([origin, upstream].map(server => new Promise(resolve => server.close(resolve))));
  });
  const originPort = await listen(origin, '::1');
  const upstreamPort = await listen(upstream);
  await proxy.start();
  const configure = entry => proxy.setUpstreamProxy({ host: '127.0.0.1', port: upstreamPort, noProxy: [entry] });
  const url = `http://[0:0:0:0:0:0:0:1]:${originPort}/resource`;
  for (const address of ['::1', '0:0:0:0:0:0:0:1']) {
    for (const entry of [address, `[${address}]`, `[${address}]:${originPort}`]) {
      configure(entry);
      assert.equal((await request(proxy.server.address().port, url)).body, 'direct', entry);
    }
  }
  assert.equal(originHits, 6);
  assert.equal(upstreamHits, 0);
  configure(`[0:0:0:0:0:0:0:1]:${originPort === 65535 ? 65534 : originPort + 1}`);
  assert.equal((await request(proxy.server.address().port, url)).body, 'upstream');
  configure('[::2]');
  assert.equal((await request(proxy.server.address().port, url)).body, 'upstream');
  assert.equal(originHits, 6);
  assert.equal(upstreamHits, 2);
});

test('host and hostname rules match equivalent IPv6 spellings without losing port or address boundaries', async t => {
  const proxy = new ProxyServer(null, { port: 0 });
  t.after(() => proxy.stop());
  await proxy.start();
  for (const spellings of [
    ['::1', '0:0:0:0:0:0:0:1'],
    ['2001:db8::a', '2001:0DB8:0:0:0:0:0:000A'],
    ['::ffff:192.0.2.1', '0:0:0:0:0:ffff:c000:201']
  ]) {
    for (const type of ['host', 'hostname']) {
      for (const address of spellings) {
        const value = `[${address}]${type === 'host' ? ':8443' : ''}`;
        const matcher = { type, value };
        proxy.mockRules = [];
        proxy.addMockRule({ matchers: [matcher], action: { type: 'fixed-response', status: 201 } });
        proxy.addMockRule({ matchers: [], action: { type: 'fixed-response', status: 202 } });
        for (const target of spellings) {
          const url = `http://[${target}]:8443/resource`;
          assert.equal((await request(proxy.server.address().port, url)).status, 201, `${type}: ${value} matches ${url}`);
          assert.equal(proxy._evaluateMatcher(matcher, 'GET', url.replace(':8443', ':9443'), {}, ''), type === 'hostname');
        }
        assert.equal(proxy._evaluateMatcher(matcher, 'GET', 'http://[::2]:8443/resource', {}, ''), false);
      }
    }
  }
});
