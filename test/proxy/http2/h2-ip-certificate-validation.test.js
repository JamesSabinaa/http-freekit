import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

async function fixture(t, address, certificateName = address, trustOrigin = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'freekit-h2-ip-certificate-'));
  const ca = new CertificateAuthority(directory);
  await ca.initialize();
  const certificate = await ca.generateCertForHost(certificateName);
  const origin = http2.createSecureServer({ key: certificate.key, cert: certificate.cert });
  const sockets = new Set();
  const observed = { serverNames: [], requests: [], dialTargets: [] };
  origin.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  origin.on('secureConnection', socket => observed.serverNames.push(socket.servername || null));
  origin.on('stream', (stream, headers) => {
    observed.requests.push(headers);
    stream.respond({ ':status': 200 });
    stream.end('verified-ip-origin');
  });
  origin.listen(0, address);
  await once(origin, 'listening');
  const proxy = new ProxyServer(ca, { port: 0 });
  proxy.setTlsFingerprint('default');
  if (trustOrigin) proxy.setTrustedCAs([ca.caCertPath]);
  const connectTcp = proxy._connectTcp.bind(proxy);
  proxy._connectTcp = (hostname, port) => {
    observed.dialTargets.push({ hostname, port });
    return connectTcp(hostname, port);
  };
  t.after(async () => {
    await proxy.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => origin.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { proxy, observed, port: origin.address().port };
}

for (const address of ['127.0.0.1', '::1']) {
  test(`trusted H2 upstream over ${address} verifies the IP SAN using the existing socket`, { timeout: 20000 }, async t => {
    const context = await fixture(t, address);
    const socket = await context.proxy._connectH2Tls(address, context.port, null, new AbortController().signal);
    t.after(() => socket.destroy());
    assert.equal(socket.authorized, true);
    assert.equal(socket.alpnProtocol, 'h2');
    assert.deepEqual(context.observed.dialTargets, [{ hostname: address, port: context.port }]);
    const authority = address === '::1' ? `[::1]:${context.port}` : `${address}:${context.port}`;
    const client = http2.connect(`https://${authority}`, { createConnection: () => socket });
    t.after(() => client.destroy());
    await once(client, 'connect');
    const request = client.request({ ':method': 'GET', ':path': '/verified-ip', ':authority': authority });
    const response = once(request, 'response');
    const ended = once(request, 'end');
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.end();
    const [headers] = await response;
    await ended;
    assert.equal(headers[':status'], 200);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'verified-ip-origin');
    assert.equal(context.observed.requests[0][':authority'], authority);
    assert.deepEqual(context.observed.serverNames, [null], 'An IP verification host must not introduce DNS SNI');
    client.destroy();
  });
}

test('H2 upstream still rejects a trusted DNS certificate that lacks the original IP SAN', { timeout: 20000 }, async t => {
  const context = await fixture(t, '127.0.0.1', 'logical-only.example.invalid');
  await assert.rejects(
    context.proxy._connectH2Tls('127.0.0.1', context.port, null, new AbortController().signal),
    error => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID' && error.message.includes('127.0.0.1')
  );
  assert.deepEqual(context.observed.dialTargets, [{ hostname: '127.0.0.1', port: context.port }]);
  assert.equal(context.observed.requests.length, 0);
});

test('H2 upstream still rejects an IP certificate from an untrusted CA', { timeout: 20000 }, async t => {
  const context = await fixture(t, '127.0.0.1', '127.0.0.1', false);
  await assert.rejects(
    context.proxy._connectH2Tls('127.0.0.1', context.port, null, new AbortController().signal),
    error => /CERT|ISSUER|SIGNATURE/.test(error.code)
  );
  assert.equal(context.observed.requests.length, 0);
});
