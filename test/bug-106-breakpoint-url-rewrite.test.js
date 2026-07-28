import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';

import { CertificateAuthority } from '../src/proxy/certificate-authority.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function requestThroughProxy(proxyPort, targetUrl) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: targetUrl,
      headers: { connection: 'close' }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

async function openTunnel(proxyPort, hostname, targetPort = 443) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(
    `CONNECT ${hostname}:${targetPort} HTTP/1.1\r\n` +
    `Host: ${hostname}:${targetPort}\r\n\r\n`
  );
  let response = Buffer.alloc(0);
  while (response.indexOf('\r\n\r\n') === -1) {
    const [chunk] = await once(socket, 'data');
    response = Buffer.concat([response, chunk]);
  }
  assert.match(response.toString('latin1'), /^HTTP\/1\.1 200 /);
  const remaining = response.subarray(response.indexOf('\r\n\r\n') + 4);
  if (remaining.length > 0) socket.unshift(remaining);
  return socket;
}

async function sendTlsHttp1(proxyPort, hostname) {
  const tunnel = await openTunnel(proxyPort, hostname);
  const socket = tls.connect({
    socket: tunnel,
    servername: hostname,
    ALPNProtocols: ['http/1.1'],
    rejectUnauthorized: false
  });
  await once(socket, 'secureConnect');
  socket.write(
    `GET /original HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`
  );
  const chunks = [];
  socket.on('data', chunk => chunks.push(chunk));
  await once(socket, 'end');
  return Buffer.concat(chunks).toString('utf8');
}

test('plain H1 breakpoint rewrites update Host and switch HTTP to HTTPS',
  { timeout: 20000 }, async t => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-breakpoint-rewrite-'));
    const ca = new CertificateAuthority(dataDir);
    await ca.initialize();
    const certificate = await ca.generateCertForHost('127.0.0.1');
    let originalHits = 0;
    const original = http.createServer((_request, response) => {
      originalHits++;
      response.end('wrong origin');
    });
    const originalPort = await listen(original);
    const received = [];
    const secureOrigin = https.createServer({ key: certificate.key, cert: certificate.cert },
      (request, response) => {
        received.push({ url: request.url, host: request.headers.host });
        response.end('secure origin');
      });
    const securePort = await listen(secureOrigin);
    const captures = [];
    let proxy;
    proxy = new ProxyServer(ca, {
      port: 0,
      onRequest: event => captures.push(event),
      onBreakpoint: event => setImmediate(() => proxy.resumeBreakpoint(event.requestId, {
        url: `https://127.0.0.1:${securePort}/rewritten`
      }))
    });
    proxy.setHttpsWhitelist(['127.0.0.1']);
    proxy.breakpointRules = [{ id: 'rewrite-plain-h1', enabled: true, matchers: [] }];
    await proxy.start();
    t.after(async () => {
      await proxy.stop();
      await close(original);
      await close(secureOrigin);
      await rm(dataDir, { recursive: true, force: true });
    });

    const response = await requestThroughProxy(
      proxy.server.address().port,
      `http://127.0.0.1:${originalPort}/original`
    );
    const rewrittenAuthority = `127.0.0.1:${securePort}`;

    assert.equal(response.statusCode, 200);
    assert.equal(response.body, 'secure origin');
    assert.equal(originalHits, 0);
    assert.deepEqual(received, [{ url: '/rewritten', host: rewrittenAuthority }]);
    const completed = captures.findLast(event => event.statusCode === 200);
    assert.equal(completed.protocol, 'https');
    assert.equal(completed.requestHeaders.host, rewrittenAuthority);
  });

test('intercepted H1 breakpoint rewrites switch HTTPS to HTTP in both TLS modes',
  { timeout: 30000 }, async t => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-breakpoint-h1-http-'));
    const ca = new CertificateAuthority(dataDir);
    await ca.initialize();
    const received = [];
    const origin = http.createServer((request, response) => {
      received.push({ url: request.url, host: request.headers.host });
      response.end('plain origin');
    });
    const originPort = await listen(origin);
    t.after(async () => {
      await close(origin);
      await rm(dataDir, { recursive: true, force: true });
    });

    for (const mode of ['disabled', 'all']) {
      const captures = [];
      let proxy;
      proxy = new ProxyServer(ca, {
        port: 0,
        onRequest: event => captures.push(event),
        onBreakpoint: event => setImmediate(() => proxy.resumeBreakpoint(event.requestId, {
          url: `http://127.0.0.1:${originPort}/${mode}`
        }))
      });
      proxy.setTlsFingerprint('passthrough');
      proxy.setHttp2Config(mode);
      proxy.breakpointRules = [{ id: `rewrite-${mode}`, enabled: true, matchers: [] }];
      await proxy.start();
      try {
        const response = await sendTlsHttp1(
          proxy.server.address().port,
          `original-${mode}.example.test`
        );
        const rewrittenAuthority = `127.0.0.1:${originPort}`;

        assert.match(response, /^HTTP\/1\.1 200 /, mode);
        assert.match(response, /plain origin$/, mode);
        assert.deepEqual(received.at(-1), { url: `/${mode}`, host: rewrittenAuthority });
        const completed = captures.findLast(event => event.statusCode === 200);
        assert.equal(completed.protocol, 'http', mode);
        assert.equal(completed.requestHeaders.host, rewrittenAuthority, mode);
      } finally {
        await proxy.stop();
      }
    }
  });
