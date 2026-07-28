import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';

import { CertificateAuthority } from '../src/proxy/certificate-authority.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withTimeout(promise, message, timeoutMs = 3000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function trackSockets(server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  return () => {
    for (const socket of sockets) socket.destroy();
  };
}

function close(server, destroySockets) {
  destroySockets?.();
  return new Promise(resolve => server.close(resolve));
}

async function openTunnel(proxyPort, targetPort) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(
    `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${targetPort}\r\n\r\n`
  );
  let response = Buffer.alloc(0);
  while (response.indexOf('\r\n\r\n') === -1) {
    const [chunk] = await once(socket, 'data');
    response = Buffer.concat([response, chunk]);
  }
  assert.match(response.toString('latin1'), /^HTTP\/1\.1 200 Connection Established/);
  const remaining = response.subarray(response.indexOf('\r\n\r\n') + 4);
  if (remaining.length > 0) socket.unshift(remaining);
  return socket;
}

test('plain HTTP responses reach the client before the origin ends them', async t => {
  const releaseResponse = deferred();
  const origin = http.createServer(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: first\n\n');
    await releaseResponse.promise;
    response.end('data: last\n\n');
  });
  const destroyOriginSockets = trackSockets(origin);
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(async () => {
    releaseResponse.resolve();
    await proxy.stop();
    await close(origin, destroyOriginSockets);
  });

  const response = await withTimeout(new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port: proxy.server.address().port,
      path: `http://127.0.0.1:${originPort}/events`,
      agent: false,
      headers: { connection: 'close' }
    }, resolve);
    request.once('error', reject);
  }), 'proxy buffered HTTP response headers');
  const [firstChunk] = await withTimeout(
    once(response, 'data'),
    'proxy buffered the first HTTP response chunk'
  );
  assert.equal(firstChunk.toString(), 'data: first\n\n');

  const chunks = [firstChunk];
  response.on('data', chunk => chunks.push(chunk));
  const ended = once(response, 'end');
  releaseResponse.resolve();
  await ended;
  assert.equal(Buffer.concat(chunks).toString(), 'data: first\n\ndata: last\n\n');
});

test('plain HTTP uploads reach the origin before the client ends them', async t => {
  const firstOriginChunk = deferred();
  let received = '';
  const origin = http.createServer((request, response) => {
    request.setEncoding('utf8');
    request.on('data', chunk => {
      received += chunk;
      firstOriginChunk.resolve(chunk);
    });
    request.on('end', () => response.end('ok'));
  });
  const destroyOriginSockets = trackSockets(origin);
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin, destroyOriginSockets);
  });

  const responseComplete = new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: proxy.server.address().port,
      path: `http://127.0.0.1:${originPort}/upload`,
      method: 'POST',
      agent: false,
      headers: { 'content-length': '9', connection: 'close' }
    }, response => {
      response.resume();
      response.once('end', resolve);
    });
    request.once('error', reject);
    request.write('first');
    void withTimeout(
      firstOriginChunk.promise,
      'proxy buffered the HTTP upload until request end'
    ).then(() => request.end('last'), reject);
  });

  assert.equal(await withTimeout(firstOriginChunk.promise, 'origin did not receive upload data'), 'first');
  await responseComplete;
  assert.equal(received, 'firstlast');
});

test('native HTTP/2 streams request and response data bidirectionally', { timeout: 20000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-streaming-h2-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const originCert = await ca.generateCertForHost('127.0.0.1');
  const firstOriginChunk = deferred();
  let received = '';

  const origin = http2.createSecureServer({ key: originCert.key, cert: originCert.cert });
  origin.on('stream', (originStream, headers) => {
    assert.equal(headers.te, 'trailers');
    originStream.on('data', chunk => {
      received += chunk.toString();
      if (received === 'request-first') {
        firstOriginChunk.resolve();
        originStream.respond({ ':status': 200, 'content-type': 'application/grpc' });
        originStream.write('response-first');
      }
    });
    originStream.on('end', () => originStream.end('response-last'));
  });
  const destroyOriginSockets = trackSockets(origin);
  const originPort = await listen(origin);

  const events = [];
  const proxy = new ProxyServer(ca, { port: 0, onRequest: event => events.push(event) });
  proxy.setHttp2Config('h2-only');
  proxy.setHttpsWhitelist(['127.0.0.1']);
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin, destroyOriginSockets);
    await rm(dataDir, { recursive: true, force: true });
  });

  const tunnel = await openTunnel(proxy.server.address().port, originPort);
  const secureSocket = tls.connect({
    socket: tunnel,
    servername: 'localhost',
    ALPNProtocols: ['h2'],
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  const client = http2.connect(`https://127.0.0.1:${originPort}`, {
    createConnection: () => secureSocket
  });
  t.after(() => client.destroy());
  await once(client, 'connect');

  const request = client.request({
    ':method': 'POST',
    ':path': '/bidirectional',
    ':scheme': 'https',
    ':authority': `127.0.0.1:${originPort}`,
    'content-type': 'application/grpc',
    te: 'trailers'
  });
  const responseHeaders = once(request, 'response');
  const firstResponseChunk = once(request, 'data');
  const responseChunks = [];
  request.on('data', chunk => responseChunks.push(chunk));
  request.write('request-first');

  await withTimeout(firstOriginChunk.promise, 'proxy buffered the HTTP/2 upload');
  const [headers] = await withTimeout(responseHeaders, 'proxy buffered HTTP/2 response headers');
  const [firstChunk] = await withTimeout(firstResponseChunk, 'proxy buffered HTTP/2 response data');
  assert.equal(headers[':status'], 200);
  assert.equal(firstChunk.toString(), 'response-first');

  const responseEnd = once(request, 'end');
  request.end('request-last');
  await responseEnd;
  assert.equal(received, 'request-firstrequest-last');
  assert.equal(Buffer.concat(responseChunks).toString(), 'response-firstresponse-last');
  assert.equal(events.at(-1).path, '/bidirectional');
  const decodeCapture = value => Buffer.from(value.split(',', 2)[1], 'base64').toString();
  assert.equal(decodeCapture(events.at(-1).requestBody), 'request-firstrequest-last');
  assert.equal(decodeCapture(events.at(-1).responseBody), 'response-firstresponse-last');

  client.close();
  await once(client, 'close');
});

test('HTTP/1.1 clients stream bidirectionally to HTTP/2 origins', { timeout: 20000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-streaming-h1-h2-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const originCert = await ca.generateCertForHost('127.0.0.1');
  const firstOriginChunk = deferred();
  let received = '';

  const origin = http2.createSecureServer({ key: originCert.key, cert: originCert.cert });
  origin.on('stream', originStream => {
    originStream.on('data', chunk => {
      received += chunk.toString();
      if (received === 'first') {
        firstOriginChunk.resolve();
        originStream.respond({ ':status': 200, 'content-type': 'text/plain' });
        originStream.write('response-first');
      }
    });
    originStream.on('end', () => originStream.end('response-last'));
  });
  const destroyOriginSockets = trackSockets(origin);
  const originPort = await listen(origin);

  const proxy = new ProxyServer(ca, { port: 0 });
  proxy.setHttp2Config('disabled');
  proxy.setHttpsWhitelist(['127.0.0.1']);
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin, destroyOriginSockets);
    await rm(dataDir, { recursive: true, force: true });
  });

  const tunnel = await openTunnel(proxy.server.address().port, originPort);
  const secureSocket = tls.connect({
    socket: tunnel,
    servername: 'localhost',
    ALPNProtocols: ['http/1.1'],
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  assert.equal(secureSocket.alpnProtocol, 'http/1.1');

  const responseChunks = [];
  const firstResponseChunk = deferred();
  secureSocket.on('data', chunk => {
    responseChunks.push(Buffer.from(chunk));
    if (Buffer.concat(responseChunks).includes('response-first')) firstResponseChunk.resolve();
  });
  const responseComplete = once(secureSocket, 'end');
  secureSocket.write(
    `POST /h2-origin HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${originPort}\r\n` +
    'Content-Type: text/plain\r\n' +
    'Content-Length: 9\r\n' +
    'Connection: close\r\n\r\n' +
    'first'
  );

  await withTimeout(firstOriginChunk.promise, 'proxy buffered the H1-to-H2 upload');
  await withTimeout(firstResponseChunk.promise, 'proxy buffered H2 response data');
  const partialResponse = Buffer.concat(responseChunks).toString();
  assert.match(partialResponse, /^HTTP\/1\.1 200 /);
  assert.match(partialResponse, /response-first/);

  secureSocket.write('last');
  await responseComplete;
  assert.equal(received, 'firstlast');
  const completeResponse = Buffer.concat(responseChunks).toString();
  assert.match(completeResponse, /response-first/);
  assert.match(completeResponse, /response-last/);
});

test('HTTP/2 clients stream bidirectionally through the HTTP/1.1 fallback', { timeout: 20000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-streaming-h2-h1-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const originCert = await ca.generateCertForHost('127.0.0.1');
  const firstOriginChunk = deferred();
  let received = '';

  const origin = https.createServer({ key: originCert.key, cert: originCert.cert }, (request, response) => {
    request.on('data', chunk => {
      received += chunk.toString();
      if (received === 'request-first') {
        firstOriginChunk.resolve();
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('response-first');
      }
    });
    request.on('end', () => response.end('response-last'));
  });
  const destroyOriginSockets = trackSockets(origin);
  const originPort = await listen(origin);

  const proxy = new ProxyServer(ca, { port: 0 });
  proxy.setHttp2Config('h2-only');
  proxy.setHttpsWhitelist(['127.0.0.1']);
  proxy._h2Blacklist.add(`127.0.0.1:${originPort}`);
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin, destroyOriginSockets);
    await rm(dataDir, { recursive: true, force: true });
  });

  const tunnel = await openTunnel(proxy.server.address().port, originPort);
  const secureSocket = tls.connect({
    socket: tunnel,
    servername: 'localhost',
    ALPNProtocols: ['h2'],
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  const client = http2.connect(`https://127.0.0.1:${originPort}`, {
    createConnection: () => secureSocket
  });
  t.after(() => client.destroy());
  await once(client, 'connect');

  const request = client.request({
    ':method': 'POST',
    ':path': '/h1-fallback',
    ':scheme': 'https',
    ':authority': `127.0.0.1:${originPort}`,
    'content-type': 'text/plain'
  });
  const responseHeaders = once(request, 'response');
  const firstResponseChunk = once(request, 'data');
  const responseChunks = [];
  request.on('data', chunk => responseChunks.push(chunk));
  request.write('request-first');

  await withTimeout(firstOriginChunk.promise, 'HTTP/1.1 fallback buffered the HTTP/2 upload');
  const [headers] = await withTimeout(
    responseHeaders,
    'HTTP/1.1 fallback buffered response headers'
  );
  const [firstChunk] = await withTimeout(
    firstResponseChunk,
    'HTTP/1.1 fallback buffered response data'
  );
  assert.equal(headers[':status'], 200);
  assert.equal(firstChunk.toString(), 'response-first');

  const responseEnd = once(request, 'end');
  request.end('request-last');
  await responseEnd;
  assert.equal(received, 'request-firstrequest-last');
  assert.equal(Buffer.concat(responseChunks).toString(), 'response-firstresponse-last');

  client.close();
  await once(client, 'close');
});

test('streaming fast paths stop when a mock or breakpoint can depend on the body', () => {
  const proxy = new ProxyServer(null);
  const url = 'http://example.test/upload';
  const headers = { 'content-type': 'text/plain' };

  assert.equal(proxy._canStreamWithoutRequestBuffering('POST', url, headers), true);
  proxy.mockRules = [{
    enabled: true,
    matchers: [
      { type: 'path', value: '/upload' },
      { type: 'body-contains', value: 'token' }
    ],
    action: { type: 'fixed-response', status: 200, body: 'matched' }
  }];
  assert.equal(proxy._canStreamWithoutRequestBuffering('POST', url, headers), false);
  assert.equal(
    proxy._canStreamWithoutRequestBuffering('POST', 'http://example.test/other', headers),
    true
  );

  proxy.mockRules = [];
  proxy.breakpointRules = [{
    enabled: true,
    matchers: [{ type: 'body-contains', value: 'pause-me' }]
  }];
  assert.equal(proxy._canStreamWithoutRequestBuffering('POST', url, headers), false);
});

test('an upstream reset cannot strand a backpressured HTTP/1 upload', { timeout: 15000 }, async t => {
  const origin = net.createServer(socket => {
    socket.pause();
    setTimeout(() => socket.destroy(), 250);
  });
  const destroyOriginSockets = trackSockets(origin);
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin, destroyOriginSockets);
  });

  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  let stopUpload = false;
  const result = new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: proxy.server.address().port,
      path: `http://127.0.0.1:${originPort}/reset-upload`,
      method: 'POST',
      agent,
      headers: { 'content-length': String(64 * 1024 * 1024) }
    }, response => {
      stopUpload = true;
      response.resume();
      resolve(response.statusCode);
      request.destroy();
    });
    request.once('error', error => {
      if (!stopUpload) reject(error);
    });
    void (async () => {
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      while (!stopUpload) {
        if (!request.write(chunk)) await once(request, 'drain');
      }
    })().catch(error => {
      if (!stopUpload) reject(error);
    });
  });

  const statusCode = await withTimeout(result, 'backpressured HTTP/1 upload remained paused', 5000);
  assert.equal(statusCode, 502);
});

test('an upstream reset cannot strand a backpressured HTTP/2 upload', { timeout: 20000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-streaming-reset-h2-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const originCert = await ca.generateCertForHost('127.0.0.1');
  const origin = https.createServer({ key: originCert.key, cert: originCert.cert }, request => {
    request.on('error', () => {});
    request.pause();
    setTimeout(() => request.socket.destroy(), 250);
  });
  const destroyOriginSockets = trackSockets(origin);
  const originPort = await listen(origin);
  const proxy = new ProxyServer(ca, { port: 0 });
  proxy.setHttp2Config('h2-only');
  proxy.setHttpsWhitelist(['127.0.0.1']);
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin, destroyOriginSockets);
    await rm(dataDir, { recursive: true, force: true });
  });

  const tunnel = await openTunnel(proxy.server.address().port, originPort);
  const secureSocket = tls.connect({
    socket: tunnel,
    servername: 'localhost',
    ALPNProtocols: ['h2'],
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  const client = http2.connect(`https://127.0.0.1:${originPort}`, {
    createConnection: () => secureSocket
  });
  t.after(() => client.destroy());
  await once(client, 'connect');

  const request = client.request({
    ':method': 'POST',
    ':path': '/reset-upload',
    ':scheme': 'https',
    ':authority': `127.0.0.1:${originPort}`,
    'content-length': String(64 * 1024 * 1024)
  });
  secureSocket.on('error', () => {});
  client.on('error', () => {});
  const terminal = new Promise(resolve => {
    request.once('response', headers => resolve({ statusCode: headers[':status'] }));
    request.once('error', error => resolve({ error }));
  });
  request.resume();
  let stopUpload = false;
  terminal.then(() => { stopUpload = true; });
  void (async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x62);
    while (!stopUpload) {
      if (!request.write(chunk)) await once(request, 'drain');
    }
  })().catch(() => {});

  const outcome = await withTimeout(terminal, 'backpressured HTTP/2 upload remained paused', 5000);
  assert.ok(
    outcome.statusCode === 502 || outcome.error?.code === 'ECONNRESET',
    `unexpected terminal outcome: ${outcome.error?.code || outcome.statusCode}`
  );
  if (!request.closed) request.close(http2.constants.NGHTTP2_NO_ERROR);
});

test('HTTP/2 response trailers keep chunked framing even when announced late', { timeout: 20000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-streaming-late-trailer-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const originCert = await ca.generateCertForHost('127.0.0.1');
  const origin = http2.createSecureServer({ key: originCert.key, cert: originCert.cert });
  origin.on('stream', originStream => {
    originStream.respond({
      ':status': 200,
      'content-type': 'text/plain',
      'content-length': '5'
    }, { waitForTrailers: true });
    originStream.once('wantTrailers', () => {
      originStream.sendTrailers({ 'x-late': 'yes' });
    });
    originStream.end('hello');
  });
  const destroyOriginSockets = trackSockets(origin);
  const originPort = await listen(origin);
  const proxy = new ProxyServer(ca, { port: 0 });
  proxy.setHttp2Config('disabled');
  proxy.setHttpsWhitelist(['127.0.0.1']);
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin, destroyOriginSockets);
    await rm(dataDir, { recursive: true, force: true });
  });

  const tunnel = await openTunnel(proxy.server.address().port, originPort);
  const secureSocket = tls.connect({
    socket: tunnel,
    servername: 'localhost',
    ALPNProtocols: ['http/1.1'],
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  const chunks = [];
  secureSocket.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const ended = once(secureSocket, 'end');
  secureSocket.write(
    `GET /late-trailer HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${originPort}\r\n` +
    'Connection: close\r\n\r\n'
  );
  await ended;

  const response = Buffer.concat(chunks).toString('latin1');
  assert.match(response, /^HTTP\/1\.1 200 /);
  assert.doesNotMatch(response, /\r\ncontent-length:/i);
  assert.match(response, /\r\ntransfer-encoding: chunked\r\n/i);
  assert.match(response, /\r\n0\r\nx-late: yes\r\n\r\n$/i);
});

test('HTTP/2 CANCEL falls back to HTTP/1 for H1 and H2 clients', { timeout: 30000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-streaming-cancel-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const originCert = await ca.generateCertForHost('127.0.0.1');
  let h2Attempts = 0;
  let h1Attempts = 0;
  const origin = http2.createSecureServer(
    { key: originCert.key, cert: originCert.cert, allowHTTP1: true },
    (request, response) => {
      if (request.httpVersionMajor !== 1) return;
      h1Attempts += 1;
      response.end('fallback');
    }
  );
  origin.on('stream', originStream => {
    h2Attempts += 1;
    originStream.close(http2.constants.NGHTTP2_CANCEL);
  });
  const destroyOriginSockets = trackSockets(origin);
  const originPort = await listen(origin);
  t.after(async () => {
    await close(origin, destroyOriginSockets);
    await rm(dataDir, { recursive: true, force: true });
  });

  const h1Proxy = new ProxyServer(ca, { port: 0 });
  h1Proxy.setHttp2Config('disabled');
  h1Proxy.setHttpsWhitelist(['127.0.0.1']);
  await h1Proxy.start();
  const h1Tunnel = await openTunnel(h1Proxy.server.address().port, originPort);
  const h1Socket = tls.connect({
    socket: h1Tunnel,
    servername: 'localhost',
    ALPNProtocols: ['http/1.1'],
    rejectUnauthorized: false
  });
  await once(h1Socket, 'secureConnect');
  const h1Chunks = [];
  h1Socket.on('data', chunk => h1Chunks.push(Buffer.from(chunk)));
  const h1End = once(h1Socket, 'end');
  h1Socket.write(
    `GET /cancel-h1 HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${originPort}\r\n` +
    'Connection: close\r\n\r\n'
  );
  await withTimeout(h1End, 'H1 client did not receive fallback response', 5000);
  assert.match(Buffer.concat(h1Chunks).toString('latin1'), /^HTTP\/1\.1 200 /);
  assert.match(Buffer.concat(h1Chunks).toString('latin1'), /fallback/);
  await h1Proxy.stop();

  const h2Proxy = new ProxyServer(ca, { port: 0 });
  h2Proxy.setHttp2Config('h2-only');
  h2Proxy.setHttpsWhitelist(['127.0.0.1']);
  await h2Proxy.start();
  t.after(() => h2Proxy.stop());
  const h2Tunnel = await openTunnel(h2Proxy.server.address().port, originPort);
  const h2Socket = tls.connect({
    socket: h2Tunnel,
    servername: 'localhost',
    ALPNProtocols: ['h2'],
    rejectUnauthorized: false
  });
  await once(h2Socket, 'secureConnect');
  const h2Client = http2.connect(`https://127.0.0.1:${originPort}`, {
    createConnection: () => h2Socket
  });
  t.after(() => h2Client.destroy());
  await once(h2Client, 'connect');
  const h2Request = h2Client.request({
    ':method': 'GET',
    ':path': '/cancel-h2',
    ':scheme': 'https',
    ':authority': `127.0.0.1:${originPort}`
  });
  const h2Headers = once(h2Request, 'response');
  const h2Chunks = [];
  h2Request.on('data', chunk => h2Chunks.push(chunk));
  const h2End = once(h2Request, 'end');
  h2Request.end();
  const [headers] = await withTimeout(h2Headers, 'H2 client did not receive fallback headers', 5000);
  await withTimeout(h2End, 'H2 client did not receive fallback body', 5000);
  assert.equal(headers[':status'], 200);
  assert.equal(Buffer.concat(h2Chunks).toString(), 'fallback');
  assert.equal(h2Attempts, 2);
  assert.equal(h1Attempts, 2);
});
