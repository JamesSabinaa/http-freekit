import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http2 from 'node:http2';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProxyServer } from '../src/proxy/proxy-server.js';

function createCertificateFiles(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-client-cert-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const wildcardPath = path.join(tempDir, 'wildcard.pfx');
  const exactPath = path.join(tempDir, 'exact.pfx');
  fs.writeFileSync(wildcardPath, Buffer.from('wildcard-certificate'));
  fs.writeFileSync(exactPath, Buffer.from('exact-certificate'));
  return { wildcardPath, exactPath };
}

function wildcardCertificate(pfxPath) {
  return { host: ' * ', pfxPath, passphrase: 'wildcard-secret' };
}

function exactCertificate(pfxPath) {
  return { host: '  API.EXAMPLE.TEST.  ', pfxPath, passphrase: 'exact-secret' };
}

test('wildcard client certificates are fallbacks and exact normalized hosts always win', (t) => {
  const { wildcardPath, exactPath } = createCertificateFiles(t);
  const proxy = new ProxyServer(null);

  for (const certificates of [
    [wildcardCertificate(wildcardPath), exactCertificate(exactPath)],
    [exactCertificate(exactPath), wildcardCertificate(wildcardPath)]
  ]) {
    proxy.setClientCertificates(certificates);

    const exact = proxy._getClientCertificateOptions('api.example.test');
    assert.deepEqual(exact.pfx, Buffer.from('exact-certificate'));
    assert.equal(exact.passphrase, 'exact-secret');

    const fallback = proxy._getClientCertificateOptions('other.example.test');
    assert.deepEqual(fallback.pfx, Buffer.from('wildcard-certificate'));
    assert.equal(fallback.passphrase, 'wildcard-secret');
  }

  assert.deepEqual(proxy._getClientCertificateOptions(''), {});
});

test('malformed client certificate entries stay ignored and unmatched hosts get no certificate', (t) => {
  const { exactPath } = createCertificateFiles(t);
  const proxy = new ProxyServer(null);

  proxy.setClientCertificates([
    null,
    { host: '', pfxPath: exactPath },
    { host: '   ', pfxPath: exactPath },
    { host: 123, pfxPath: exactPath },
    { host: 'api.example.test', pfxPath: '' },
    { host: 'api.example.test', pfxPath: 123 },
    { host: '*.', pfxPath: exactPath },
    { host: '*.example.test', pfxPath: exactPath },
    exactCertificate(exactPath)
  ]);

  assert.equal(proxy._clientCertificateOptions.length, 1);
  assert.deepEqual(proxy._getClientCertificateOptions('unmatched.example.test'), {});
});

test('the HTTP/1 request path passes wildcard client certificate options to HTTPS', async (t) => {
  const { wildcardPath } = createCertificateFiles(t);
  const proxy = new ProxyServer(null, {
    upstreamConnectTimeoutMs: 0,
    upstreamIdleTimeoutMs: 0
  });
  proxy.setClientCertificates([wildcardCertificate(wildcardPath)]);

  const originalRequest = https.request;
  let capturedOptions;
  https.request = (options, callback) => {
    capturedOptions = options;
    const request = new EventEmitter();
    request.socket = { remoteAddress: '127.0.0.1', remotePort: 443 };
    request.write = () => true;
    request.addTrailers = () => {};
    request.destroy = (error) => error && request.emit('error', error);
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.statusMessage = 'OK';
      response.headers = {};
      response.trailers = {};
      response.destroy = () => {};
      callback(response);
      response.emit('end');
    });
    return request;
  };
  t.after(() => { https.request = originalRequest; });

  await proxy._requestMockForward({
    forwardUrl: new URL('https://fallback.example.test/'),
    path: '/',
    method: 'GET',
    headers: {},
    body: Buffer.alloc(0)
  });

  assert.deepEqual(capturedOptions.pfx, Buffer.from('wildcard-certificate'));
  assert.equal(capturedOptions.passphrase, 'wildcard-secret');
});

test('the HTTP/2 session path passes the exact certificate over an earlier wildcard', async (t) => {
  const { wildcardPath, exactPath } = createCertificateFiles(t);
  const proxy = new ProxyServer(null);
  proxy.setClientCertificates([
    wildcardCertificate(wildcardPath),
    exactCertificate(exactPath)
  ]);

  const originalConnect = http2.connect;
  let capturedUrl;
  let capturedOptions;
  http2.connect = (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    const session = new EventEmitter();
    session.destroyed = false;
    session.closed = false;
    session.close = () => { session.closed = true; };
    session.destroy = () => { session.destroyed = true; };
    queueMicrotask(() => session.emit('connect'));
    return session;
  };
  t.after(() => {
    proxy._closeAllH2Sessions();
    http2.connect = originalConnect;
  });

  await proxy._getH2Session('api.example.test', 443);

  assert.equal(capturedUrl, 'https://api.example.test:443');
  assert.deepEqual(capturedOptions.pfx, Buffer.from('exact-certificate'));
  assert.equal(capturedOptions.passphrase, 'exact-secret');
  assert.deepEqual(capturedOptions.ALPNProtocols, ['h2']);
});

test('HTTPS upstream agents receive wildcard client certificate options', (t) => {
  const { wildcardPath } = createCertificateFiles(t);
  const proxy = new ProxyServer(null);
  proxy.setClientCertificates([wildcardCertificate(wildcardPath)]);
  proxy.setUpstreamProxy({ type: 'https', host: 'proxy.example.test', port: 8443 });
  t.after(() => proxy._destroyUpstreamAgent());

  const agent = proxy._getUpstreamAgent();

  assert.deepEqual(agent.connectOpts.pfx, Buffer.from('wildcard-certificate'));
  assert.equal(agent.connectOpts.passphrase, 'wildcard-secret');
});
