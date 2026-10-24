import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import dns from 'node:dns';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import forge from 'node-forge';

import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

// Characterization evidence for an OPEN compatibility gate. These assertions
// describe current failures; they do not establish logical-authority support.
const LOGICAL_HOST = 'logical-app.example.invalid';

async function fixture(t, { h2 = false, dnsOnly = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'freekit-ip-authority-'));
  const ca = new CertificateAuthority(directory);
  await ca.initialize();
  const material = await ca.generateCertForHost(dnsOnly ? LOGICAL_HOST : '127.0.0.1');
  let originCertificate = material.cert;
  if (!dnsOnly) {
    const certificate = forge.pki.certificateFromPem(material.cert);
    certificate.setExtensions(certificate.extensions.map(extension => extension.name === 'subjectAltName'
      ? { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: LOGICAL_HOST }] }
      : extension));
    certificate.sign(ca.caKey, forge.md.sha256.create());
    originCertificate = forge.pki.certificateToPem(certificate);
  }
  assert.equal(new X509Certificate(originCertificate).checkHost(LOGICAL_HOST), LOGICAL_HOST);
  if (!dnsOnly) assert.equal(new X509Certificate(originCertificate).checkIP('127.0.0.1'), '127.0.0.1');
  const observed = { requests: [], serverNames: [], connections: 0, dnsRetargets: 0, h2ProbeErrors: [] };
  const origin = h2
    ? http2.createSecureServer({ key: material.key, cert: originCertificate })
    : https.createServer({ key: material.key, cert: originCertificate });
  const sockets = new Set();
  origin.on('connection', socket => {
    observed.connections++;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  origin.on('secureConnection', socket => observed.serverNames.push(socket.servername || null));
  origin.on('tlsClientError', (_error, socket) => observed.serverNames.push(socket.servername || null));
  if (h2) {
    origin.on('stream', (stream, headers) => {
      observed.requests.push({ authority: headers[':authority'], host: headers.host });
      stream.respond({ ':status': 200 });
      stream.end('original-ip-origin');
    });
  } else {
    origin.on('request', (request, response) => {
      observed.requests.push({ host: request.headers.host });
      response.end('original-ip-origin');
    });
  }
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');

  const events = [];
  const proxy = new ProxyServer(ca, { port: 0, onRequest: event => events.push(event) });
  const connectH2Tls = proxy._connectH2Tls.bind(proxy);
  proxy._connectH2Tls = (...arguments_) => connectH2Tls(...arguments_).catch(error => {
    observed.h2ProbeErrors.push(error);
    throw error;
  });
  proxy.setHttp2Config(h2 ? 'h2-only' : 'disabled');
  proxy.setTlsFingerprint('default');
  proxy.setTrustedCAs([ca.caCertPath]);
  await proxy.start();

  // A future implementation must dial the original IP. Accidentally resolving
  // the logical authority must fail locally, without an external DNS request.
  const lookup = dns.lookup;
  t.mock.method(dns, 'lookup', function(hostname, ...arguments_) {
    if (hostname !== LOGICAL_HOST) return lookup.call(this, hostname, ...arguments_);
    observed.dnsRetargets++;
    const error = Object.assign(new Error('Logical authority was used as a dial target'), { code: 'ERR_TEST_DNS_RETARGET' });
    const callback = arguments_.at(-1);
    queueMicrotask(() => callback(error));
  });

  t.after(async () => {
    await proxy.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => origin.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { proxy, events, observed, originPort: origin.address().port, trustedRoot: await readFile(ca.caCertPath) };
}

async function securedTunnel(t, context, servername, alpn) {
  const socket = net.connect(context.proxy.server.address().port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write(`CONNECT 127.0.0.1:${context.originPort} HTTP/1.1\r\nHost: 127.0.0.1:${context.originPort}\r\n\r\n`);
  let response = Buffer.alloc(0);
  while (!response.includes('\r\n\r\n')) {
    const [chunk] = await once(socket, 'data');
    response = Buffer.concat([response, chunk]);
  }
  assert.match(response.toString('latin1'), /^HTTP\/1\.1 200 Connection Established/);
  const secured = tls.connect({
    socket,
    host: '127.0.0.1',
    ...(servername ? { servername } : {}),
    ca: context.trustedRoot,
    rejectUnauthorized: true,
    ALPNProtocols: [alpn]
  });
  t.after(() => secured.destroy());
  await once(secured, 'secureConnect');
  assert.equal(secured.authorized, true, 'The downstream logical certificate must verify before testing egress');
  return secured;
}

async function h1Request(t, context, host, servername = LOGICAL_HOST) {
  const socket = await securedTunnel(t, context, servername, 'http/1.1');
  const chunks = [];
  socket.on('data', chunk => chunks.push(chunk));
  const ended = once(socket, 'end');
  socket.write(`GET /authority-gate HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  await ended;
  const wire = Buffer.concat(chunks).toString('utf8');
  return { status: Number(wire.match(/^HTTP\/1\.1 (\d+)/)?.[1]), wire };
}

async function h2Session(t, context, servername = LOGICAL_HOST) {
  const socket = await securedTunnel(t, context, servername, 'h2');
  const client = http2.connect(`https://${servername || '127.0.0.1'}:${context.originPort}`, { createConnection: () => socket });
  t.after(() => client.destroy());
  await once(client, 'connect');
  return client;
}

async function h2Request(client, authority, scheme = 'https') {
  const request = client.request({ ':method': 'GET', ':path': '/authority-gate', ':authority': authority, ':scheme': scheme });
  const response = once(request, 'response');
  const ended = once(request, 'end');
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.end();
  const [headers] = await response;
  await ended;
  return { status: headers[':status'], body: Buffer.concat(chunks).toString('utf8') };
}

test('open gate: IP CONNECT does not yet authenticate a DNS-only upstream identity', { timeout: 20000 }, async t => {
  const context = await fixture(t, { dnsOnly: true });
  const response = await h1Request(t, context, `${LOGICAL_HOST}:${context.originPort}`);
  assert.equal(response.status, 502);
  assert.ok(context.events.some(event => event.errorCode === 'ERR_TLS_CERT_ALTNAME_INVALID'));
  assert.equal(context.observed.requests.length, 0, 'Upstream hostname verification must not be disabled to hide the gap');
  assert.ok(context.observed.connections > 0, 'The original IP was dialed');
  assert.equal(context.observed.dnsRetargets, 0);
});

test('open gate: H1 logical and conflicting Host values are both coerced to the CONNECT IP', { timeout: 20000 }, async t => {
  const context = await fixture(t);
  for (const host of [`${LOGICAL_HOST}:${context.originPort}`, `other.example.invalid:${context.originPort}`]) {
    const response = await h1Request(t, context, host);
    assert.equal(response.status, 200);
    assert.match(response.wire, /original-ip-origin/);
  }
  assert.deepEqual(context.observed.requests.map(request => request.host), Array(2).fill(`127.0.0.1:${context.originPort}`));
  assert.ok(context.observed.serverNames.length > 0);
  assert.ok(context.observed.serverNames.every(name => name === null), 'The logical upstream SNI is also lost');
  assert.equal(context.observed.dnsRetargets, 0);
});

test('open gate: H2 rejects the matching logical SNI authority along with hostile mismatches', { timeout: 20000 }, async t => {
  const context = await fixture(t, { h2: true });
  const client = await h2Session(t, context);
  for (const [authority, scheme] of [
    [`${LOGICAL_HOST}:${context.originPort}`, 'https'],
    [`other.example.invalid:${context.originPort}`, 'https'],
    [`127.0.0.1:${context.originPort + 1}`, 'https'],
    [`127.0.0.1:${context.originPort}`, 'http']
  ]) {
    assert.deepEqual(await h2Request(client, authority, scheme), { status: 421, body: 'Misdirected Request' });
  }
  assert.equal(context.observed.connections, 0, 'Authority rejection must precede egress');
  assert.equal(context.events.length, 0, 'Rejected authorities must not reach matching/capture');
  assert.equal(context.observed.dnsRetargets, 0);
});

for (const h2 of [false, true]) {
  test(`IP CONNECT without SNI retains its existing ${h2 ? 'H2 authority' : 'H1 Host'} fallback`, { timeout: 20000 }, async t => {
    const context = await fixture(t, { h2 });
    const authority = `127.0.0.1:${context.originPort}`;
    if (h2) {
      const client = await h2Session(t, context, null);
      assert.deepEqual(await h2Request(client, authority), { status: 200, body: 'original-ip-origin' });
      assert.equal(context.observed.requests[0].authority, authority);
    } else {
      const response = await h1Request(t, context, authority, null);
      assert.equal(response.status, 200);
      assert.match(response.wire, /original-ip-origin/);
      assert.equal(context.observed.requests[0].host, authority);
    }
    assert.equal(context.observed.dnsRetargets, 0);
  });
}
