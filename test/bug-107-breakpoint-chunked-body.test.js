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

const EDITED_BODY = 'edited body';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function captureRequest(request) {
  return new Promise(resolve => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve({
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8')
    }));
  });
}

function sendChunkedThroughProxy(proxyPort, targetUrl) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: targetUrl,
      method: 'POST',
      headers: {
        connection: 'close',
        'transfer-encoding': 'chunked'
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    request.end('original');
  });
}

async function openTunnel(proxyPort, hostname, targetPort) {
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

async function sendTlsChunked(proxyPort, hostname, targetPort) {
  const tunnel = await openTunnel(proxyPort, hostname, targetPort);
  const socket = tls.connect({
    socket: tunnel,
    ALPNProtocols: ['http/1.1'],
    rejectUnauthorized: false
  });
  await once(socket, 'secureConnect');
  socket.write(
    'POST /original HTTP/1.1\r\n' +
    `Host: ${hostname}:${targetPort}\r\n` +
    'Connection: close\r\n' +
    'Transfer-Encoding: chunked\r\n\r\n' +
    '8\r\noriginal\r\n0\r\n\r\n'
  );
  const chunks = [];
  socket.on('data', chunk => chunks.push(chunk));
  await once(socket, 'end');
  return Buffer.concat(chunks).toString('utf8');
}

function configureBodyBreakpoint(proxy) {
  proxy.breakpointRules = [{ id: 'edit-chunked-body', enabled: true, matchers: [] }];
  proxy.onBreakpoint = event => setImmediate(() => proxy.resumeBreakpoint(event.requestId, {
    body: EDITED_BODY
  }));
}

function assertEditedRequest(observed) {
  assert.equal(observed.headers['transfer-encoding'], undefined);
  assert.equal(observed.headers['content-length'], String(Buffer.byteLength(EDITED_BODY)));
  assert.equal(observed.body, EDITED_BODY);
}

test('plain H1 breakpoint body edits replace chunked framing with Content-Length', async t => {
  let observed;
  const origin = http.createServer(async (request, response) => {
    observed = await captureRequest(request);
    response.end('ok');
  });
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  configureBodyBreakpoint(proxy);
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin);
  });

  const response = await sendChunkedThroughProxy(
    proxy.server.address().port,
    `http://127.0.0.1:${originPort}/original`
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'ok');
  assertEditedRequest(observed);
});

test('intercepted H1 body edits replace chunked framing in both TLS modes',
  { timeout: 30000 }, async t => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-breakpoint-chunked-'));
    const ca = new CertificateAuthority(dataDir);
    await ca.initialize();
    const certificate = await ca.generateCertForHost('127.0.0.1');
    const observed = [];
    const origin = https.createServer({ key: certificate.key, cert: certificate.cert },
      async (request, response) => {
        observed.push(await captureRequest(request));
        response.end('ok');
      });
    const originPort = await listen(origin);
    t.after(async () => {
      await close(origin);
      await rm(dataDir, { recursive: true, force: true });
    });

    for (const mode of ['disabled', 'all']) {
      const proxy = new ProxyServer(ca, { port: 0 });
      proxy.setTlsFingerprint('passthrough');
      proxy.setHttp2Config(mode);
      proxy.setHttpsWhitelist(['127.0.0.1']);
      configureBodyBreakpoint(proxy);
      await proxy.start();
      try {
        const response = await sendTlsChunked(
          proxy.server.address().port,
          '127.0.0.1',
          originPort
        );

        assert.match(response, /^HTTP\/1\.1 200 /, mode);
        assert.match(response, /ok$/, mode);
        assertEditedRequest(observed.at(-1));
      } finally {
        await proxy.stop();
      }
    }
  });
