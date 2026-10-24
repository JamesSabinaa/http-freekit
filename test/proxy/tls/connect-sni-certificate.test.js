import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';

import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';
import { createConnectSniCallback, normalizeConnectServerName } from '../../../src/proxy/connect-tls-identity.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

async function fixture(t, http2Mode = 'disabled') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'freekit-connect-sni-'));
  const ca = new CertificateAuthority(directory);
  await ca.initialize();
  const proxy = new ProxyServer(ca, { port: 0 });
  proxy.setHttp2Config(http2Mode);
  proxy.setTlsFingerprint('default');
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return { proxy, ca, trustedRoot: await readFile(ca.caCertPath) };
}

async function tunnel(t, proxy, authority) {
  const socket = net.connect(proxy.server.address().port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  let response = Buffer.alloc(0);
  while (!response.includes('\r\n\r\n')) {
    const [chunk] = await once(socket, 'data');
    response = Buffer.concat([response, chunk]);
  }
  assert.match(response.toString('latin1'), /^HTTP\/1\.1 200 Connection Established\r\n/);
  return socket;
}

for (const mode of ['disabled', 'h2-only']) {
  test(`IP CONNECT selects a DNS SNI certificate with ${mode} ALPN`, { timeout: 20000 }, async t => {
    const { proxy, trustedRoot } = await fixture(t, mode);
    const socket = await tunnel(t, proxy, '127.0.0.1:443');
    const secured = tls.connect({
      socket,
      servername: 'app.example.invalid',
      ca: trustedRoot,
      rejectUnauthorized: true,
      ALPNProtocols: [mode === 'h2-only' ? 'h2' : 'http/1.1']
    });
    t.after(() => secured.destroy());
    await once(secured, 'secureConnect');
    assert.equal(secured.authorized, true);
    assert.equal(secured.getPeerCertificate().subjectaltname, 'DNS:app.example.invalid');
    assert.equal(secured.alpnProtocol, mode === 'h2-only' ? 'h2' : 'http/1.1');
    secured.destroy();
  });
}

test('SNI certificate selection keeps the original IP CONNECT egress and upstream trust', { timeout: 20000 }, async t => {
  const { proxy, ca, trustedRoot } = await fixture(t);
  const originCertificate = await ca.generateCertForHost('app.example.invalid');
  let receivedHost;
  const origin = https.createServer({ key: originCertificate.key, cert: originCertificate.cert }, (request, response) => {
    receivedHost = request.headers.host;
    response.end('original-ip-origin');
  });
  const sockets = new Set();
  origin.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => origin.close(resolve));
  });
  const originPort = origin.address().port;
  proxy.setTrustedCAs([ca.caCertPath]);
  const socket = await tunnel(t, proxy, `127.0.0.1:${originPort}`);
  // This DNS name cannot be resolved. A response proves the logical identity
  // is preserved independently of the original IP dial destination.
  const secured = tls.connect({ socket, servername: 'app.example.invalid', ca: trustedRoot, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
  t.after(() => secured.destroy());
  await once(secured, 'secureConnect');
  assert.equal(secured.authorized, true);
  const chunks = [];
  secured.on('data', chunk => chunks.push(chunk));
  const ended = once(secured, 'end');
  secured.write(`GET /sni-routing HTTP/1.1\r\nHost: app.example.invalid:${originPort}\r\nConnection: close\r\n\r\n`);
  await ended;
  assert.match(Buffer.concat(chunks).toString('utf8'), /original-ip-origin/);
  assert.equal(receivedHost, `app.example.invalid:${originPort}`);
});

test('a client without SNI still verifies the CONNECT IP certificate', { timeout: 20000 }, async t => {
  const { proxy, trustedRoot } = await fixture(t);
  const socket = await tunnel(t, proxy, '127.0.0.1:443');
  const secured = tls.connect({ socket, host: '127.0.0.1', ca: trustedRoot, rejectUnauthorized: true });
  t.after(() => secured.destroy());
  await once(secured, 'secureConnect');
  assert.equal(secured.authorized, true);
  assert.equal(secured.getPeerCertificate().subjectaltname, 'IP Address:127.0.0.1');
  secured.destroy();
});

test('SNI certificate selection does not make the interception CA implicitly trusted', { timeout: 20000 }, async t => {
  const { proxy } = await fixture(t);
  const socket = await tunnel(t, proxy, '127.0.0.1:443');
  const secured = tls.connect({ socket, servername: 'app.example.invalid', rejectUnauthorized: true });
  t.after(() => secured.destroy());
  await assert.rejects(once(secured, 'secureConnect'), error => /CERT|ISSUER|SIGNATURE/.test(error.code));
});

test('malformed wire SNI aborts the handshake before requesting a certificate', { timeout: 20000 }, async t => {
  const { proxy, ca, trustedRoot } = await fixture(t);
  const generatedNames = [];
  const generate = ca.generateCertForHost.bind(ca);
  ca.generateCertForHost = hostname => { generatedNames.push(hostname); return generate(hostname); };
  for (const servername of ['bad/name.test', '*.example.test', 'a'.repeat(64) + '.test', 'a'.repeat(254)]) {
    const socket = await tunnel(t, proxy, '127.0.0.1:443');
    const secured = tls.connect({ socket, servername, ca: trustedRoot, rejectUnauthorized: true });
    t.after(() => secured.destroy());
    await assert.rejects(once(secured, 'secureConnect'), error => /ERR_SSL_|ECONNRESET/.test(error.code));
  }
  assert.deepEqual(generatedNames, Array(4).fill('127.0.0.1'));
});

test('SNI syntax and length are bounded before certificate generation', async () => {
  const valid = new Map([
    ['Example.TEST.', 'example.test'], ['localhost', 'localhost'], ['xn--bcher-kva.test', 'xn--bcher-kva.test'],
    ['127.0.0.1', '127.0.0.1'], ['2001:DB8::1', '2001:db8::1'],
    [`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`, `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`]
  ]);
  for (const [input, expected] of valid) assert.equal(normalizeConnectServerName(input), expected);
  let generated = false;
  const callback = createConnectSniCallback({ generateCertForHost() { generated = true; throw new Error('must not run'); } });
  for (const input of ['', null, undefined, {}, ' space.test', 'space.test ', 'two..labels', '-bad.test', 'bad-.test', '*.test', 'https://site.test', 'user@site.test', 'site.test/path', 'bad\0.test', 'bad\n.test', 'a'.repeat(64) + '.test', 'a'.repeat(254), 'fe80::1%eth0', '[::1]', '127.0.0.01', 'bücher.test']) {
    assert.equal(normalizeConnectServerName(input), '');
    await assert.rejects(new Promise((resolve, reject) => callback(input, (error, context) => error ? reject(error) : resolve(context))), { code: 'ERR_INVALID_TLS_SERVERNAME' });
  }
  assert.equal(generated, false);
});

test('SNI context creation failures abort with a sanitized error', async () => {
  const callback = createConnectSniCallback({ generateCertForHost() { throw new Error('fixture-sensitive-detail'); } });
  await assert.rejects(
    new Promise((resolve, reject) => callback('app.example.invalid', (error, context) => error ? reject(error) : resolve(context))),
    error => error.code === 'ERR_TLS_INTERCEPTION_CONTEXT' && error.message === 'Cannot create TLS interception context'
  );
});
