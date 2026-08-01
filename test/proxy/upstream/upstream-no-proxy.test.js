import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function request(proxyPort, url) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: proxyPort, path: url }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.once('error', reject);
  });
}

test('non-proxied hosts bypass an active upstream proxy', async (t) => {
  let upstreamHits = 0;
  const origin = http.createServer((_req, res) => res.end('direct'));
  const originPort = await listen(origin);
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.end('proxied');
  });
  const upstreamPort = await listen(upstream);
  const proxy = new ProxyServer(null, { port: 0 });
  proxy.setUpstreamProxy({
    host: '127.0.0.1',
    port: upstreamPort,
    type: 'http',
    noProxy: ['127.0.0.1']
  });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(upstream);
    await close(origin);
  });

  const body = await request(proxy.server.address().port, `http://127.0.0.1:${originPort}/resource`);
  assert.equal(body, 'direct');
  assert.equal(upstreamHits, 0);
});

test('upstream proxy remains active for hosts outside the bypass list', async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits++;
    res.end('proxied');
  });
  const upstreamPort = await listen(upstream);
  const proxy = new ProxyServer(null, { port: 0 });
  proxy.setUpstreamProxy({
    host: '127.0.0.1', port: upstreamPort, type: 'http', noProxy: ['*.internal.test']
  });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(upstream);
  });

  const body = await request(proxy.server.address().port, 'http://public.test/resource');
  assert.equal(body, 'proxied');
  assert.equal(upstreamHits, 1);
});

test('no-proxy matching supports suffixes, wildcards, local names, and ports', () => {
  const proxy = new ProxyServer(null);
  proxy.setUpstreamProxy({
    host: 'proxy.test',
    noProxy: ['.example.test', 'api-*.internal', '<local>', 'port.test:8443', '[::1]:9443']
  });

  assert.equal(proxy._shouldUseUpstreamProxy('www.example.test', 443), false);
  assert.equal(proxy._shouldUseUpstreamProxy('api-one.internal', 443), false);
  assert.equal(proxy._shouldUseUpstreamProxy('printer', 80), false);
  assert.equal(proxy._shouldUseUpstreamProxy('port.test', 8443), false);
  assert.equal(proxy._shouldUseUpstreamProxy('port.test', 443), true);
  assert.equal(proxy._shouldUseUpstreamProxy('::1', 9443), false);
  assert.equal(proxy._shouldUseUpstreamProxy('public.test', 443), true);
});

test('renderer saves and restores the configured non-proxied hosts', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');
  assert.match(source, /JSON\.stringify\(\{ host, port, auth: auth \|\| null, type, noProxy \}\)/);
  assert.match(source, /noProxyEl\.value = \(proxy\.noProxy \|\| \[\]\)\.join\(', '\)/);
});
