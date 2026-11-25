import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isSupported as isTlsImpersonationSupported } from 'tls-impersonate';
import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

function request(port, agent) {
  const req = https.get({ hostname: '127.0.0.1', port, agent, rejectUnauthorized: false });
  const result = new Promise(resolve => {
    req.on('error', error => resolve({ error }));
    req.on('response', res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', error => resolve({ error }));
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString() }));
    });
  });
  return { req, result };
}

async function setup(t, route = 'direct') {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-agent-retirement-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const cert = await ca.generateCertForHost('127.0.0.1');
  const origin = https.createServer({ key: cert.key, cert: cert.cert });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const proxy = new ProxyServer(ca, {});
  let upstream;
  const tunnels = new Set();
  if (route === 'proxy') {
    upstream = http.createServer();
    upstream.on('connect', (_req, downstream, head) => {
      const target = net.connect(origin.address().port, '127.0.0.1');
      for (const socket of [downstream, target]) {
        tunnels.add(socket);
        socket.on('error', () => socket.destroy());
        socket.once('close', () => tunnels.delete(socket));
      }
      target.once('connect', () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) target.write(head);
        downstream.pipe(target).pipe(downstream);
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    proxy.setUpstreamProxy({ host: '127.0.0.1', port: upstream.address().port, type: 'http' });
  }
  t.after(async () => {
    proxy._destroyUpstreamAgent();
    for (const socket of tunnels) socket.destroy();
    if (upstream) await new Promise(resolve => upstream.close(resolve));
    origin.closeAllConnections();
    await new Promise(resolve => origin.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { origin, proxy, port: origin.address().port };
}

function evict(proxy) {
  for (let index = 1; index <= 128; index++) {
    proxy._getFingerprintAgent('direct', { ciphers: `identity-${index}` });
  }
  assert.equal(proxy._fingerprintedAgents.size, 128);
}

test('cached TLS contexts reacquire a tracked agent after pool eviction', { timeout: 15000 }, async t => {
  if (!isTlsImpersonationSupported()) return t.skip('native TLS mirroring requires a supported runtime');
  const { origin, proxy, port } = await setup(t);
  const hello = {
    tlsVersion: 0x0303,
    cipherSuites: [0x1301, 0xc02f],
    extensions: [
      { id: 10, data: { groups: [29, 23] } },
      { id: 13, data: { algorithms: [0x0403, 0x0804] } },
      { id: 16, data: { protocols: ['http/1.1'] } }
    ]
  };
  const first = proxy._getUpstreamTlsOptions('127.0.0.1', hello);
  assert.ok(first.secureContext);
  evict(proxy);
  assert.equal(proxy._fingerprintAgentStates.has(first.agent), false);

  const next = proxy._getUpstreamTlsOptions('127.0.0.1', hello);
  assert.equal(next.secureContext, first.secureContext, 'TLS contexts remain cached');
  assert.notEqual(next.agent, first.agent, 'a retired agent must not be reused');
  assert.ok(proxy._fingerprintAgentStates.has(next.agent), 'the new pool is tracked for shutdown');
  assert.equal(proxy._getUpstreamTlsOptions('127.0.0.1', hello).agent, next.agent);

  const arrived = once(origin, 'request');
  const pending = request(port, next.agent);
  await arrived;
  proxy._destroyUpstreamAgent();
  assert.ok((await pending.result).error, 'shutdown cancels requests on the refreshed pool');
});

for (const profile of ['default', 'fingerprint']) {
  for (const change of ['rotate', 'disable']) {
    test(`${change} upstream proxy preserves an active direct ${profile} HTTPS request`, { timeout: 15000 }, async t => {
      const { origin, proxy, port } = await setup(t);
      proxy.setUpstreamProxy({ host: 'old.example.test', port: 8080, noProxy: ['127.0.0.1'] });
      const hello = { ciphers: 'direct-profile' };
      const getAgent = () => profile === 'fingerprint'
        ? proxy._getFingerprintAgent('direct', hello)
        : proxy._getUpstreamTlsOptions('127.0.0.1', null).agent;
      const agent = getAgent();
      const proxiedAgent = proxy._getFingerprintAgent('proxy', hello);
      const destroyProxied = t.mock.method(proxiedAgent, 'destroy', () => {});
      const arrived = once(origin, 'request');
      const pending = request(port, agent);
      const [, response] = await arrived;

      proxy.setUpstreamProxy(change === 'disable' ? null : {
        host: 'new.example.test', port: 8080, noProxy: ['127.0.0.1']
      });
      response.end('direct request completed');

      assert.deepEqual(await pending.result, { body: 'direct request completed' });
      assert.equal(getAgent(), agent, 'direct connection pools survive upstream changes');
      assert.equal(destroyProxied.mock.callCount(), 1, 'the old upstream pool is still invalidated');
      assert.equal(proxy._fingerprintAgentStates.has(proxiedAgent), false);
      assert.equal([...proxy._fingerprintedAgents.values()].includes(proxiedAgent), false);
    });
  }
}

for (const route of ['direct', 'proxy']) {
test(`${route} fingerprint eviction lets existing HTTPS requests finish then closes their sockets`, { timeout: 15000 }, async t => {
  const { origin, proxy, port } = await setup(t, route);
  const agent = proxy._getFingerprintAgent(route, { ciphers: 'first' });
  agent.maxSockets = 1;
  const arrived = once(origin, 'request');
  const first = request(port, agent);
  const [, response] = await arrived;
  const socket = first.req.socket;
  const closed = once(socket, 'close');
  const second = request(port, agent);
  if (route === 'direct') assert.equal(Object.values(agent.requests).flat().length, 1);
  evict(proxy);
  assert.equal([...proxy._fingerprintedAgents.values()].includes(agent), false);
  const secondArrived = once(origin, 'request');
  response.end('first completed');
  assert.deepEqual(await first.result, { body: 'first completed' });
  const [, secondResponse] = await secondArrived;
  const secondSocket = second.req.socket;
  const secondClosed = secondSocket === socket ? closed : once(secondSocket, 'close');
  secondResponse.end('queued completed');
  assert.deepEqual(await second.result, { body: 'queued completed' });
  await Promise.all([closed, secondClosed]);
  assert.equal(Object.values(agent.freeSockets).flat().length, 0);
  assert.equal(proxy._fingerprintAgentStates.has(agent), false);
});
}

test('fingerprint eviction closes idle keep-alive sockets immediately', { timeout: 15000 }, async t => {
  const { origin, proxy, port } = await setup(t);
  origin.on('request', (_req, res) => res.end('idle'));
  const agent = proxy._getFingerprintAgent('direct', { ciphers: 'first' });
  const completed = request(port, agent);
  assert.deepEqual(await completed.result, { body: 'idle' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(Object.values(agent.freeSockets).flat().length, 1);
  const closed = once(completed.req.socket, 'close');
  evict(proxy);
  await closed;
  assert.equal(proxy._fingerprintAgentStates.has(agent), false);
});

test('shutdown still destroys active sockets belonging to evicted fingerprint agents', { timeout: 15000 }, async t => {
  const { origin, proxy, port } = await setup(t);
  const agent = proxy._getFingerprintAgent('direct', { ciphers: 'first' });
  const arrived = once(origin, 'request');
  const held = request(port, agent);
  await arrived;
  evict(proxy);
  assert.equal(held.req.socket.destroyed, false);
  proxy._destroyUpstreamAgent();
  assert.ok((await held.result).error);
  assert.equal(held.req.socket.destroyed, true);
});
