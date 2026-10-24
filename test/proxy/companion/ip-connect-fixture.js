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
import tls from 'node:tls';
import forge from 'node-forge';

import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

// Controlled origins prove logical HTTP/TLS identity cannot change the IP dial target.
export const LOGICAL_HOST = 'logical-app.example.invalid';
const isLoopback = address => address === '::1' || (net.isIP(address) === 4 && address.startsWith('127.'));

export async function fixture(t, { h2 = false, dnsOnly = false, address = '127.0.0.1', mode = h2 ? 'h2-only' : 'disabled', certificateName = null, trust = true, fingerprint = 'default' } = {}) {
  assert.ok(isLoopback(address), 'Fixtures must bind only explicit loopback addresses');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'freekit-ip-authority-'));
  const ca = new CertificateAuthority(directory);
  await ca.initialize();
  const material = await ca.generateCertForHost(certificateName || (dnsOnly ? LOGICAL_HOST : address));
  let originCertificate = material.cert;
  if (!dnsOnly && !certificateName) {
    const certificate = forge.pki.certificateFromPem(material.cert);
    certificate.setExtensions(certificate.extensions.map(extension => extension.name === 'subjectAltName'
      ? { name: 'subjectAltName', altNames: [{ type: 7, ip: address }, { type: 2, value: LOGICAL_HOST }] }
      : extension));
    certificate.sign(ca.caKey, forge.md.sha256.create());
    originCertificate = forge.pki.certificateToPem(certificate);
  }
  if (!certificateName) assert.equal(new X509Certificate(originCertificate).checkHost(LOGICAL_HOST), LOGICAL_HOST);
  if (!dnsOnly && !certificateName) assert.equal(new X509Certificate(originCertificate).checkIP(address), address);
  const observed = { requests: [], serverNames: [], connections: 0, handshakes: 0, dnsRetargets: 0, h2ProbeErrors: [], upgrades: [] };
  const sockets = new Set();
  const createOrigin = () => {
    const server = h2
      ? http2.createSecureServer({ key: material.key, cert: originCertificate, allowHTTP1: true })
      : https.createServer({ key: material.key, cert: originCertificate });
    server.on('connection', socket => {
      observed.connections++;
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.on('secureConnection', socket => { observed.handshakes++; observed.serverNames.push(socket.servername || null); });
    server.on('tlsClientError', (_error, socket) => observed.serverNames.push(socket.servername || null));
    if (h2) {
      server.on('stream', (stream, headers) => {
        observed.requests.push({
          authority: headers[':authority'], host: headers.host, path: headers[':path'],
          method: headers[':method'], headers, address: stream.session.socket.localAddress
        });
        stream.respond({ ':status': 200 });
        stream.end('original-ip-origin');
      });
    }
    server.on('request', (request, response) => {
      if (request.httpVersionMajor === 2) return;
      observed.requests.push({
        host: request.headers.host, path: request.url, method: request.method,
        headers: request.headers, address: request.socket.localAddress
      });
      response.setHeader('content-length', '18');
      response.end('original-ip-origin');
    });
    return server;
  };
  const origin = createOrigin();
  const origins = [origin];
  origin.listen(0, address);
  await once(origin, 'listening');

  const events = [];
  const proxy = new ProxyServer(ca, { port: 0, onRequest: event => events.push(event) });
  const connectH2Tls = proxy._connectH2Tls.bind(proxy);
  proxy._connectH2Tls = (...arguments_) => connectH2Tls(...arguments_).catch(error => {
    observed.h2ProbeErrors.push(error);
    throw error;
  });
  proxy.setHttp2Config(mode);
  proxy.setTlsFingerprint(fingerprint);
  if (trust) proxy.setTrustedCAs([ca.caCertPath]);
  await proxy.start();

  // The proxy must dial the original IP. Accidentally resolving
  // the logical authority must fail locally, without an external DNS request.
  const lookup = dns.lookup;
  t.mock.method(dns, 'lookup', function(hostname, ...arguments_) {
    if (!hostname.endsWith('.example.invalid')) return lookup.call(this, hostname, ...arguments_);
    observed.dnsRetargets++;
    const error = Object.assign(new Error('Logical authority was used as a dial target'), { code: 'ERR_TEST_DNS_RETARGET' });
    const callback = arguments_.at(-1);
    queueMicrotask(() => callback(error));
  });

  t.after(async () => {
    await proxy.stop();
    for (const socket of sockets) socket.destroy();
    await Promise.all(origins.map(server => new Promise(resolve => server.close(resolve))));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    proxy, events, observed, origin, ca, address, originPort: origin.address().port, trustedRoot: await readFile(ca.caCertPath),
    async listenAlias(alias) {
      assert.ok(isLoopback(alias), 'Aliases must bind only explicit loopback addresses');
      const server = createOrigin();
      origins.push(server);
      server.listen(origin.address().port, alias);
      await once(server, 'listening');
    }
  };
}

export async function securedTunnel(t, context, servername, alpn) {
  const socket = net.connect(context.proxy.server.address().port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const authority = `${net.isIP(context.address) === 6 ? `[${context.address}]` : context.address}:${context.originPort}`;
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  let response = Buffer.alloc(0);
  while (!response.includes('\r\n\r\n')) {
    const [chunk] = await once(socket, 'data');
    response = Buffer.concat([response, chunk]);
  }
  assert.match(response.toString('latin1'), /^HTTP\/1\.1 200 Connection Established/);
  const secured = tls.connect({
    socket,
    host: context.address,
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

export async function h1Request(t, context, host, servername = LOGICAL_HOST, requestWire = null) {
  const socket = await securedTunnel(t, context, servername, 'http/1.1');
  const chunks = [];
  socket.on('data', chunk => chunks.push(chunk));
  const ended = once(socket, 'end');
  socket.write(requestWire || `GET /authority-gate HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  await ended;
  const wire = Buffer.concat(chunks).toString('utf8');
  return { status: Number(wire.match(/^HTTP\/1\.1 (\d+)/)?.[1]), wire };
}

export async function h2Session(t, context, servername = LOGICAL_HOST) {
  const socket = await securedTunnel(t, context, servername, 'h2');
  const client = http2.connect(`https://${servername || (net.isIP(context.address) === 6 ? `[${context.address}]` : context.address)}:${context.originPort}`, { createConnection: () => socket });
  t.after(() => client.destroy());
  await once(client, 'connect');
  return client;
}

export async function h2Request(client, authority, scheme = 'https', extraHeaders = {}) {
  const request = client.request({ ':method': 'GET', ':path': '/authority-gate', ':authority': authority, ':scheme': scheme, ...extraHeaders });
  const response = once(request, 'response');
  const ended = once(request, 'end');
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.end();
  const [[headers]] = await Promise.all([response, ended]);
  return { status: headers[':status'], body: Buffer.concat(chunks).toString('utf8') };
}
