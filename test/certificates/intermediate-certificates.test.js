import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import test from 'node:test';
import forge from 'node-forge';
import { ProxyServer } from '../../src/proxy/proxy-server.js';
import {
  IntermediateCertificates, downloadIssuer, isPublicCertificateAddress
} from '../../src/proxy/intermediate-certificates.js';

const { pki, asn1 } = forge;
const keys = Array.from({ length: 4 }, () => pki.rsa.generateKeyPair(2048));
let serial = 1;
function certificate(name, keyIndex, issuer, { ca = false, aia, expired = false } = {}) {
  const cert = pki.createCertificate();
  cert.publicKey = keys[keyIndex].publicKey;
  cert.serialNumber = String(serial++).padStart(2, '0');
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + (expired ? -1000 : 86400000));
  cert.setSubject([{ name: 'commonName', value: name }]);
  cert.setIssuer(issuer ? issuer.cert.subject.attributes : cert.subject.attributes);
  const extensions = [
    { name: 'basicConstraints', cA: ca, critical: true },
    { name: 'keyUsage', keyCertSign: ca, digitalSignature: true, keyEncipherment: !ca, critical: true },
    { name: 'subjectKeyIdentifier' },
    ...(!ca ? [{ name: 'subjectAltName', altNames: [{ type: 2, value: name }] }] : [])
  ];
  if (aia) extensions.push({
    id: '1.3.6.1.5.5.7.1.1',
    value: asn1.toDer(asn1.create(0, 16, true, [asn1.create(0, 16, true, [
      asn1.create(0, 6, false, asn1.oidToDer('1.3.6.1.5.5.7.48.2').getBytes()),
      asn1.create(asn1.Class.CONTEXT_SPECIFIC, 6, false, aia)
    ])])).getBytes()
  });
  cert.setExtensions(extensions);
  cert.sign(keys[issuer?.keyIndex ?? keyIndex].privateKey, forge.md.sha256.create());
  return {
    cert, keyIndex, pem: pki.certificateToPem(cert),
    der: Buffer.from(asn1.toDer(pki.certificateToAsn1(cert)).getBytes(), 'binary'),
    key: pki.privateKeyToPem(keys[keyIndex].privateKey)
  };
}

const root = certificate('Trusted root', 0, null, { ca: true });
const intermediate = certificate('Missing issuer', 1, root, { ca: true, aia: 'http://ca.test/root' });
const leaf = certificate('localhost', 2, intermediate, { aia: 'http://ca.test/intermediate' });

async function fixture(t, { leafCert = leaf, trusted = root.pem, downloads, h2 = false } = {}) {
  let requests = 0;
  const handler = (req, res) => { requests++; req.resume(); res.end('verified'); };
  const server = h2
    ? http2.createSecureServer({ key: leafCert.key, cert: leafCert.pem }, handler)
    : https.createServer({ key: leafCert.key, cert: leafCert.pem }, handler);
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const proxy = new ProxyServer(null);
  proxy._trustedCaCertificates = trusted ? [trusted] : [];
  const fetched = [];
  proxy._intermediateCertificates = new IntermediateCertificates({
    download: async url => {
      fetched.push(url);
      const value = (downloads || { 'http://ca.test/intermediate': intermediate.der, 'http://ca.test/root': root.der })[url];
      if (!value) throw new Error('Issuer unavailable');
      return value;
    }
  });
  t.after(async () => {
    proxy._closeAllH2Sessions();
    proxy._destroyUpstreamAgent();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  });
  const port = server.address().port;
  const request = () => new Promise((resolve, reject) => {
    const req = proxy._requestWithExactMethod(https, {
      host: '127.0.0.1', port, method: 'POST',
      ...proxy._getUpstreamTlsOptions('localhost'),
      headers: { Connection: 'close' }
    }, res => {
      assert.equal(res.socket.authorized, true);
      res.resume();
      res.once('end', resolve);
    });
    req.once('error', reject);
    req.end('only send after verification');
  });
  return { proxy, port, fetched, request, requests: () => requests };
}

test('repairs a missing DER intermediate before sending a POST and caches the verified chain', async t => {
  const f = await fixture(t);
  await f.request();
  assert.equal(f.requests(), 1);
  assert.deepEqual(f.fetched, ['http://ca.test/intermediate']);
  await f.request();
  assert.equal(f.requests(), 2);
  assert.equal(f.fetched.length, 1);
});

test('repairs multiple missing intermediates, including PEM issuer responses', async t => {
  const lower = certificate('Lower intermediate', 3, intermediate, { ca: true, aia: 'http://ca.test/intermediate' });
  const lowerLeaf = certificate('localhost', 2, lower, { aia: 'http://ca.test/lower' });
  const f = await fixture(t, { leafCert: lowerLeaf, downloads: {
    'http://ca.test/lower': lower.pem, 'http://ca.test/intermediate': intermediate.pem
  } });
  await f.request();
  assert.deepEqual(f.fetched, ['http://ca.test/lower', 'http://ca.test/intermediate']);
  assert.equal(f.requests(), 1);
});

test('downloaded roots cannot establish trust, and partial chains are rejected', async t => {
  const f = await fixture(t, { trusted: null });
  await assert.rejects(f.request(), error => /^UNABLE_TO_GET_ISSUER_CERT/.test(error.code));
  assert.equal(f.requests(), 0);
  assert.equal(f.proxy._intermediateCertificates.cache.size, 0);
});

test('hostname mismatches, expiration, wrong issuers and failed downloads stay rejected', async t => {
  for (const [name, options, code] of [
    ['hostname', { leafCert: certificate('wrong.test', 2, intermediate, { aia: 'http://ca.test/intermediate' }) }, 'ERR_TLS_CERT_ALTNAME_INVALID'],
    ['expiration', { leafCert: certificate('localhost', 2, intermediate, { aia: 'http://ca.test/intermediate', expired: true }) }, 'CERT_HAS_EXPIRED'],
    ['wrong issuer', { downloads: { 'http://ca.test/intermediate': root.der } }, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
    ['malformed issuer', { downloads: { 'http://ca.test/intermediate': Buffer.from('invalid') } }, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
    ['unavailable issuer', { downloads: {} }, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']
  ]) await t.test(name, async t => {
    const f = await fixture(t, options);
    await assert.rejects(f.request(), { code });
    assert.equal(f.requests(), 0);
  });
});

test('HTTP/2 verifies the repaired chain before creating a session', async t => {
  const f = await fixture(t, { h2: true });
  const session = await f.proxy._getH2Session('localhost', f.port);
  assert.ok(session);
  assert.equal(session.socket.authorized, true);
  const stream = session.request({ ':path': '/' });
  stream.resume();
  await once(stream, 'end');
  assert.equal(f.requests(), 1);
  assert.deepEqual(f.fetched, ['http://ca.test/intermediate']);
});

test('recovery preserves the configured CONNECT proxy route', async t => {
  const f = await fixture(t);
  let tunnels = 0;
  const sockets = new Set();
  const tunnel = http.createServer();
  tunnel.on('connect', (req, client, head) => {
    tunnels++;
    const upstream = net.connect(f.port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
    }
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
  });
  tunnel.listen(0, '127.0.0.1');
  await once(tunnel, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => tunnel.close(resolve));
  });
  f.proxy.setUpstreamProxy({ type: 'http', host: '127.0.0.1', port: tunnel.address().port });
  await new Promise((resolve, reject) => {
    const req = https.get({ host: 'localhost', port: f.port,
      ...f.proxy._getUpstreamTlsOptions('localhost'), agent: f.proxy._getUpstreamAgent()
    }, res => { res.resume(); res.once('end', resolve); });
    req.once('error', reject);
  });
  assert.equal(tunnels, 2);
  assert.equal(f.requests(), 1);
});

test('certificate URL discovery blocks private and non-HTTP destinations', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.0.1', '169.254.169.254',
    '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::']) {
    assert.equal(isPublicCertificateAddress(address), false, address);
  }
  assert.equal(isPublicCertificateAddress('8.8.8.8'), true);
  assert.equal(isPublicCertificateAddress('2606:4700:4700::1111'), true);
  for (const url of ['file:///ca.pem', 'http://127.0.0.1/ca', 'http://[::1]/ca',
    'http://user:secret@ca.test/ca', 'http://ca.test:8080/ca', 'http://localhost/ca']) {
    await assert.rejects(async () => downloadIssuer(url));
  }
});

test('issuer downloads enforce size and time limits and refuse redirects', async t => {
  for (const scenario of ['success', 'size', 'timeout', 'redirect']) await t.test(scenario, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    t.mock.method(http, 'get', (_url, options, onResponse) => {
      calls++;
      assert.equal(options.agent, false);
      assert.equal(options.headers.Authorization, undefined);
      const request = new EventEmitter();
      request.destroy = error => {
        if (error) request.emit('error', error);
        request.emit('close');
      };
      queueMicrotask(() => {
        if (scenario === 'timeout') return;
        const response = new PassThrough();
        response.statusCode = scenario === 'redirect' ? 302 : 200;
        response.headers = { location: 'http://127.0.0.1/private' };
        onResponse(response);
        if (scenario !== 'redirect') response.end(scenario === 'size' ? Buffer.alloc(128 * 1024 + 1) : intermediate.der);
        request.emit('close');
      });
      return request;
    });
    const pending = downloadIssuer('http://ca.test/issuer');
    if (scenario === 'success') assert.deepEqual(await pending, intermediate.der);
    else {
      const rejected = assert.rejects(pending, scenario === 'size' ? /too large/ : scenario === 'timeout' ? /timeout/ : /HTTP 302/);
      if (scenario === 'timeout') t.mock.timers.tick(3000);
      await rejected;
    }
    assert.equal(calls, 1);
  });
});

test('an expired downloaded intermediate remains invalid', async t => {
  const expired = certificate('Expired issuer', 1, root, { ca: true, expired: true });
  const expiredLeaf = certificate('localhost', 2, expired, { aia: 'http://ca.test/expired' });
  const f = await fixture(t, { leafCert: expiredLeaf, downloads: { 'http://ca.test/expired': expired.der } });
  await assert.rejects(f.request(), { code: 'CERT_HAS_EXPIRED' });
  assert.equal(f.requests(), 0);
});

test('aborting a TLS handshake closes its socket without sending application data', async t => {
  const server = net.createServer(socket => socket.on('data', () => {}));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const controller = new AbortController();
  const resolver = new IntermediateCertificates();
  let socket;
  const pending = resolver.connect(() => {
    socket = tls.connect({ host: '127.0.0.1', port: server.address().port });
    return socket;
  }, { signal: controller.signal });
  await Promise.resolve();
  controller.abort(new Error('Cancelled by user'));
  await assert.rejects(pending, /Cancelled by user/);
  assert.equal(socket.destroyed, true);
  await new Promise(resolve => server.close(resolve));
});

test('cancellation settles a pending tunnel and destroys a socket returned later', async () => {
  const controller = new AbortController();
  let finishTunnel;
  const pending = new IntermediateCertificates().connect(
    () => new Promise(resolve => { finishTunnel = resolve; }),
    { signal: controller.signal }
  );
  await Promise.resolve();
  controller.abort(new Error('Tunnel cancelled'));
  await assert.rejects(pending, /Tunnel cancelled/);
  let destroyed = false;
  finishTunnel({ destroy() { destroyed = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(destroyed, true);
});
