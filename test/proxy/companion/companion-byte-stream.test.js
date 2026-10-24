import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { WebSocketServer } from 'ws';

import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

// This tests the explicit-proxy bytes proposed for a companion stream. There is
// no gateway, enrollment protocol, Android device, or production transport here.
const TIMEOUT_MS = 10000;
const HEADER_END = Buffer.from('\r\n\r\n');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function bounded(promise, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), TIMEOUT_MS);
    })
  ]).finally(() => clearTimeout(timer));
}

class WireReader {
  constructor(socket) {
    this.socket = socket;
    this.bytes = Buffer.alloc(0);
    this.waiters = new Set();
    this.failure = null;
    this.onData = chunk => {
      this.bytes = Buffer.concat([this.bytes, chunk]);
      this.wake();
    };
    this.onError = error => { this.failure = error; this.wake(); };
    this.onClose = () => { this.failure ||= new Error('Byte stream closed'); this.wake(); };
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  wake() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  async wait() {
    if (this.failure) throw this.failure;
    await bounded(new Promise(resolve => this.waiters.add(resolve)), 'Timed out reading proxy bytes');
  }

  take(length) {
    const result = this.bytes.subarray(0, length);
    this.bytes = this.bytes.subarray(length);
    return result;
  }

  async headers() {
    while (true) {
      const end = this.bytes.indexOf(HEADER_END);
      if (end !== -1) return this.take(end + HEADER_END.length).toString('latin1');
      assert.ok(this.bytes.length <= 64 * 1024, 'Response headers exceeded the fixture budget');
      await this.wait();
    }
  }

  async exactly(length) {
    while (this.bytes.length < length) await this.wait();
    return this.take(length);
  }

  detach() {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('error', this.onError);
    this.socket.removeListener('close', this.onClose);
  }
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function track(server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  };
}

async function connect(t, port) {
  const socket = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.setNoDelay(true);
  return socket;
}

async function fragmentedWrite(socket, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  // The receiver must treat these as ordered bytes, not as message boundaries.
  for (const [start, end] of [[0, 2], [2, 17], [17, bytes.length - 1], [bytes.length - 1, bytes.length]]) {
    if (end <= start) continue;
    await new Promise((resolve, reject) => socket.write(bytes.subarray(start, end), error => error ? reject(error) : resolve()));
    await new Promise(resolve => setImmediate(resolve));
  }
}

for (const encrypted of [false, true]) {
  test(`companion bytes preserve incremental binary upload and download over ${encrypted ? 'CONNECT and trusted TLS' : 'absolute-form HTTP'}`, { timeout: 30000 }, async t => {
    const firstUpload = deferred();
    const uploadEnded = deferred();
    const releaseResponse = deferred();
    const requestBody = Buffer.from(Array.from({ length: 256 * 1024 + 13 }, (_, index) => index % 251));
    const responseBody = Buffer.from(Array.from({ length: 256 * 1024 + 7 }, (_, index) => 255 - (index % 251)));
    const requestChunks = [];
    let receivedHeaders;
    let requestComplete = false;
    const handler = (request, response) => {
      receivedHeaders = request.headers;
      request.on('data', chunk => {
        requestChunks.push(chunk);
        firstUpload.resolve();
      });
      request.on('end', () => {
        requestComplete = true;
        uploadEnded.resolve();
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': responseBody.length });
        response.write(responseBody.subarray(0, 8192));
        void releaseResponse.promise.then(() => response.end(responseBody.subarray(8192)));
      });
    };

    let ca = null;
    let trustedRoot;
    let origin;
    if (encrypted) {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'freekit-companion-wire-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      ca = new CertificateAuthority(directory);
      await ca.initialize();
      const certificate = await ca.generateCertForHost('127.0.0.1');
      trustedRoot = await readFile(ca.caCertPath);
      origin = https.createServer({ key: certificate.key, cert: certificate.cert }, handler);
    } else {
      origin = http.createServer(handler);
    }
    const closeOrigin = track(origin);
    const originPort = await listen(origin);
    const events = [];
    const proxy = new ProxyServer(ca, { port: 0, onRequest: event => events.push(event) });
    if (encrypted) {
      proxy.setTlsFingerprint('default');
      proxy.setTrustedCAs([ca.caCertPath]);
    }
    await proxy.start();
    t.after(async () => {
      releaseResponse.resolve();
      await proxy.stop();
      await closeOrigin();
    });

    let socket = await connect(t, proxy.server.address().port);
    let reader = new WireReader(socket);
    if (encrypted) {
      await fragmentedWrite(socket, `CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`);
      assert.match(await reader.headers(), /^HTTP\/1\.1 200 Connection Established\r\n/);
      assert.equal(reader.bytes.length, 0, 'CONNECT response must precede the TLS exchange');
      reader.detach();
      socket = tls.connect({ socket, host: '127.0.0.1', ca: trustedRoot, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
      t.after(() => socket.destroy());
      await once(socket, 'secureConnect');
      assert.equal(socket.authorized, true);
      reader = new WireReader(socket);
    }

    const requestTarget = encrypted ? '/companion-stream?binary=1' : `http://127.0.0.1:${originPort}/companion-stream?binary=1`;
    await fragmentedWrite(socket,
      `POST ${requestTarget} HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n` +
      `Content-Type: application/octet-stream\r\nContent-Length: ${requestBody.length}\r\nConnection: close\r\n\r\n`
    );
    socket.write(requestBody.subarray(0, 8192));
    await bounded(firstUpload.promise, 'Proxy buffered the upload until its end');
    assert.equal(requestComplete, false, 'First upload bytes reached the origin before EOF');
    await fragmentedWrite(socket, requestBody.subarray(8192));
    await bounded(uploadEnded.promise, 'Origin did not receive the full upload');
    assert.deepEqual(Buffer.concat(requestChunks), requestBody);
    assert.equal(receivedHeaders.host, `127.0.0.1:${originPort}`);

    assert.match(await reader.headers(), /^HTTP\/1\.1 200 OK\r\n/);
    assert.deepEqual(await reader.exactly(8192), responseBody.subarray(0, 8192));
    assert.equal(origin.listening, true);
    // The origin has not ended its response until the first bytes reach us.
    releaseResponse.resolve();
    assert.deepEqual(await reader.exactly(responseBody.length - 8192), responseBody.subarray(8192));
    assert.ok(events.some(event => event.protocol === (encrypted ? 'https' : 'http') && event.path === '/companion-stream?binary=1'));
    reader.detach();
    socket.destroy();
  });
}

function maskedFrame(opcode, payload) {
  assert.ok(payload.length < 126);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const encoded = Buffer.from(payload.map((value, index) => value ^ mask[index % 4]));
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, encoded]);
}

test('companion WebSocket bytes preserve a binary frame in the upgrade head', { timeout: 20000 }, async t => {
  const payload = Buffer.from(Array.from({ length: 80 }, (_, index) => (index * 71) % 256));
  const origin = http.createServer();
  const closeOrigin = track(origin);
  const websocketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const received = deferred();
  origin.on('upgrade', (request, socket, head) => {
    websocketServer.handleUpgrade(request, socket, head, websocket => {
      websocket.on('error', () => {});
      websocket.on('message', (bytes, isBinary) => {
        received.resolve({ bytes, isBinary });
        websocket.send(bytes, { binary: true });
      });
    });
  });
  const originPort = await listen(origin);
  const events = [];
  const proxy = new ProxyServer(null, { port: 0, onRequest: event => events.push(event) });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    for (const client of websocketServer.clients) client.terminate();
    await new Promise(resolve => websocketServer.close(resolve));
    await closeOrigin();
  });
  const socket = await connect(t, proxy.server.address().port);
  const reader = new WireReader(socket);
  socket.write(Buffer.concat([
    Buffer.from(`GET http://127.0.0.1:${originPort}/companion-socket HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n` +
      'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'),
    maskedFrame(2, payload)
  ]));
  const headers = await reader.headers();
  assert.match(headers, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(headers, /sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/i);
  assert.deepEqual(await bounded(received.promise, 'Origin did not receive the binary WebSocket frame'), { bytes: payload, isBinary: true });
  assert.deepEqual(await reader.exactly(2), Buffer.from([0x82, payload.length]));
  assert.deepEqual(await reader.exactly(payload.length), payload);
  assert.ok(events.some(event => event.protocol === 'ws' && event.statusCode === 101));
  reader.detach();
  socket.destroy();
});

test('companion passthrough CONNECT preserves write-side EOF while reading the reply', { timeout: 20000 }, async t => {
  const requestBytes = Buffer.from('request-before-write-eof');
  const responseBytes = Buffer.from('reply-after-write-eof');
  const originBytes = [];
  const origin = net.createServer({ allowHalfOpen: true }, socket => {
    socket.on('data', chunk => originBytes.push(chunk));
    socket.on('end', () => socket.end(responseBytes));
  });
  const closeOrigin = track(origin);
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  proxy.setTlsPassthrough(['127.0.0.1']);
  await proxy.start();
  t.after(async () => { await proxy.stop(); await closeOrigin(); });
  const socket = await connect(t, proxy.server.address().port);
  const reader = new WireReader(socket);
  await fragmentedWrite(socket, `CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`);
  assert.match(await reader.headers(), /^HTTP\/1\.1 200 Connection Established\r\n/);
  socket.end(requestBytes);
  assert.deepEqual(await reader.exactly(responseBytes.length), responseBytes);
  assert.deepEqual(Buffer.concat(originBytes), requestBytes);
  reader.detach();
  socket.destroy();
});

test('CONNECT to an IP can present the original DNS TLS identity from SNI', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'freekit-companion-wire-'));
  const ca = new CertificateAuthority(directory);
  await ca.initialize();
  const proxy = new ProxyServer(ca, { port: 0 });
  proxy.setTlsFingerprint('default');
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const tunnel = await connect(t, proxy.server.address().port);
  const reader = new WireReader(tunnel);
  // No origin is needed: this checks the client/proxy TLS identity only.
  await fragmentedWrite(tunnel, 'CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n');
  assert.match(await reader.headers(), /^HTTP\/1\.1 200 Connection Established\r\n/);
  reader.detach();
  const secureSocket = tls.connect({
    socket: tunnel,
    servername: 'original-app.example.invalid',
    ca: await readFile(ca.caCertPath),
    rejectUnauthorized: true,
    ALPNProtocols: ['http/1.1']
  });
  t.after(() => secureSocket.destroy());
  await bounded(once(secureSocket, 'secureConnect'), 'Expected the DNS identity to validate');
  assert.equal(secureSocket.authorized, true);
  assert.equal(secureSocket.getPeerCertificate().subjectaltname, 'DNS:original-app.example.invalid');
  secureSocket.destroy();
});
