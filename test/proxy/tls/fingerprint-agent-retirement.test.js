import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
