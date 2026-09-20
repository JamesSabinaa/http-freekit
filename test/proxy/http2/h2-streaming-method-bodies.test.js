import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

async function connectH2(proxyPort, originPort) {
  const tunnel = net.connect(proxyPort, '127.0.0.1');
  await once(tunnel, 'connect');
  tunnel.write(`CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`);
  let response = Buffer.alloc(0);
  while (!response.includes('\r\n\r\n')) {
    const [chunk] = await once(tunnel, 'data');
    response = Buffer.concat([response, chunk]);
  }
  assert.match(response.toString(), /^HTTP\/1\.1 200 /);
  const remaining = response.subarray(response.indexOf('\r\n\r\n') + 4);
  if (remaining.length) tunnel.unshift(remaining);
  const socket = tls.connect({ socket: tunnel, servername: 'localhost', ALPNProtocols: ['h2'], rejectUnauthorized: false });
  await once(socket, 'secureConnect');
  assert.equal(socket.alpnProtocol, 'h2');
  const client = http2.connect(`https://127.0.0.1:${originPort}`, { createConnection: () => socket });
  await once(client, 'connect');
  return client;
}

for (const ingress of ['HTTP/1', 'HTTP/2']) {
  test(`${ingress} streaming preserves method bodies and trailers to an HTTP/2 origin`, { timeout: 30000 }, async t => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-h2-method-body-'));
    const sockets = new Set();
    let origin;
    let proxy;
    let client;
    t.after(async () => {
      client?.destroy();
      try {
        await proxy?.stop();
      } finally {
        for (const socket of sockets) socket.destroy();
        if (origin?.listening) await new Promise(resolve => origin.close(resolve));
        await rm(dataDir, { recursive: true, force: true });
      }
    });
    const ca = new CertificateAuthority(dataDir);
    await ca.initialize();
    const cert = await ca.generateCertForHost('127.0.0.1');
    origin = http2.createSecureServer({ key: cert.key, cert: cert.cert, allowHTTP1: true });
    origin.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    const received = new Map();
    let fallbackRequests = 0;
    origin.on('request', (request, response) => {
      if (request.httpVersionMajor !== 1) return;
      fallbackRequests++;
      request.resume();
      request.on('end', () => response.end());
    });
    origin.on('stream', (stream, headers) => {
      const chunks = [];
      let trailers = {};
      stream.on('error', () => {});
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('trailers', values => { trailers = Object.fromEntries(Object.entries(values)); });
      stream.on('end', () => {
        received.set(headers[':path'], { method: headers[':method'], body: Buffer.concat(chunks), trailers });
        if (stream.destroyed) return;
        stream.respond({ ':status': 200, 'x-origin-protocol': 'h2' });
        stream.end();
      });
    });
    origin.listen(0, '127.0.0.1');
    await once(origin, 'listening');
    const originPort = origin.address().port;
    proxy = new ProxyServer(ca, { port: 0 });
    proxy.setHttp2Config('h2-only');
    proxy.setHttpsWhitelist(['127.0.0.1']);
    await proxy.start();
    const proxyPort = proxy.server.address().port;
    if (ingress === 'HTTP/2') client = await connectH2(proxyPort, originPort);

    for (const method of ['DELETE', 'GET', 'HEAD', 'POST']) {
      for (const framing of ['empty', 'length', 'trailers']) {
        await t.test(`${method} ${framing}`, async () => {
          const requestPath = `/${method}/${framing}`;
          const body = framing === 'empty' ? Buffer.alloc(0) : Buffer.from('alpha\r\ncafé');
          const trailers = framing === 'trailers' ? { 'x-upload-checksum': 'complete' } : {};
          const headers = framing === 'trailers'
            ? { te: 'trailers', ...(client ? {} : { 'transfer-encoding': 'chunked', trailer: 'x-upload-checksum' }) }
            : { 'content-length': String(body.length) };
          let status;
          let protocol;
          let request;
          const finished = new Promise((resolve, reject) => {
            if (client) {
              request = client.request({ ':method': method, ':path': requestPath, ...headers }, {
                endStream: false, waitForTrailers: framing === 'trailers'
              });
              request.once('response', response => {
                status = response[':status']; protocol = response['x-origin-protocol'];
              });
              request.on('data', () => {});
              request.once('end', resolve);
              if (framing === 'trailers') request.once('wantTrailers', () => request.sendTrailers(trailers));
            } else {
              request = http.request({ hostname: '127.0.0.1', port: proxyPort,
                method, path: `https://127.0.0.1:${originPort}${requestPath}`, headers, agent: false }, response => {
                status = response.statusCode; protocol = response.headers['x-origin-protocol'];
                response.resume(); response.once('end', resolve); response.once('error', reject);
              });
            }
            request.once('error', reject);
          });
          if (body.length) request.write(body.subarray(0, 3));
          if (!client && framing === 'trailers') request.addTrailers(trailers);
          request.end(body.subarray(3));
          await finished;
          assert.equal(status, 200);
          assert.equal(protocol, 'h2', 'request must not fall back to HTTP/1 to preserve its body');
          assert.deepEqual(received.get(requestPath), { method, body, trailers });
        });
      }
    }
    assert.equal(fallbackRequests, 0);
  });
}
