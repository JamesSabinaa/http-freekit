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

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function openTunnel(proxyPort, hostname, port) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(
    `CONNECT ${hostname}:${port} HTTP/1.1\r\n` +
    `Host: ${hostname}:${port}\r\n\r\n`
  );
  let response = Buffer.alloc(0);
  while (response.indexOf('\r\n\r\n') === -1) {
    const [chunk] = await once(socket, 'data');
    response = Buffer.concat([response, chunk]);
  }
  assert.match(response.toString('latin1'), /^HTTP\/1\.1 200 Connection Established/);
  return socket;
}

test('downstream H1 disconnect cancels a slow upstream response', async t => {
  let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const origin = http.createServer((request, response) => {
    resolveStarted();
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    const interval = setInterval(() => response.write('still streaming\n'), 20);
    response.once('close', () => {
      clearInterval(interval);
      resolveClosed();
    });
  });
  const destroyOriginSockets = trackSockets(origin);
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    destroyOriginSockets();
    await close(origin);
  });

  const client = http.get({
    hostname: '127.0.0.1',
    port: proxy.server.address().port,
    path: `http://127.0.0.1:${originPort}/slow`
  });
  client.once('error', () => {});
  await started;
  client.destroy();

  const stoppedPromptly = await Promise.race([
    closed.then(() => true),
    delay(300).then(() => false)
  ]);
  assert.equal(stoppedPromptly, true, 'origin response kept streaming after the client disconnected');
});

test('ALPN HTTP/1.1 fallback cancels its upstream response on disconnect', { timeout: 20000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-cancel-h1-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const originCert = await ca.generateCertForHost('127.0.0.1');
  let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const origin = https.createServer({ key: originCert.key, cert: originCert.cert }, (request, response) => {
    resolveStarted();
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    const interval = setInterval(() => response.write('still streaming\n'), 20);
    response.once('close', () => {
      clearInterval(interval);
      resolveClosed();
    });
  });
  const destroyOriginSockets = trackSockets(origin);
  const originPort = await listen(origin);
  const proxy = new ProxyServer(ca, { port: 0 });
  proxy.setHttp2Config('all');
  proxy.setHttpsWhitelist(['127.0.0.1']);
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    destroyOriginSockets();
    await close(origin);
    await rm(dataDir, { recursive: true, force: true });
  });

  const tunnel = await openTunnel(proxy.server.address().port, '127.0.0.1', originPort);
  const client = tls.connect({
    socket: tunnel,
    ALPNProtocols: ['http/1.1'],
    rejectUnauthorized: false
  });
  client.once('error', () => {});
  await once(client, 'secureConnect');
  client.write(
    `GET /slow HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nConnection: close\r\n\r\n`
  );
  await started;
  client.destroy();

  assert.equal(
    await Promise.race([closed.then(() => true), delay(500).then(() => false)]),
    true,
    'ALPN H1 origin response kept streaming after the client disconnected'
  );
});

test('disconnecting a paused request breakpoint never forwards it to the origin', async t => {
  let originHits = 0;
  const origin = http.createServer((request, response) => {
    originHits++;
    response.end('unexpected');
  });
  const originPort = await listen(origin);
  let resolveBreakpoint;
  const breakpointHit = new Promise(resolve => { resolveBreakpoint = resolve; });
  const proxy = new ProxyServer(null, {
    port: 0,
    onBreakpoint: event => {
      if (event.type === 'breakpoint-hit') resolveBreakpoint(event.requestId);
    }
  });
  proxy.breakpointRules = [{ id: 'pause-all', enabled: true, matchers: [] }];
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin);
  });

  const client = http.get({
    hostname: '127.0.0.1',
    port: proxy.server.address().port,
    path: `http://127.0.0.1:${originPort}/unsafe-action`
  });
  client.once('error', () => {});
  const requestId = await breakpointHit;
  client.destroy();
  await delay(150);

  assert.equal(originHits, 0);
  assert.equal(proxy.pendingBreakpoints.has(requestId), false);
});

test('an abort signal cancels an active upstream H2 stream', async t => {
  let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const origin = http2.createServer();
  origin.on('stream', stream => {
    stream.respond({ ':status': 200, 'content-type': 'text/plain' });
    const interval = setInterval(() => stream.write('still streaming\n'), 20);
    stream.once('close', () => {
      clearInterval(interval);
      resolveClosed();
    });
    resolveStarted();
  });
  const originPort = await listen(origin);
  const session = http2.connect(`http://127.0.0.1:${originPort}`);
  await once(session, 'connect');
  t.after(async () => {
    session.destroy();
    await close(origin);
  });

  const controller = new AbortController();
  const proxy = new ProxyServer(null);
  const request = proxy._makeH2Request(
    session,
    'GET',
    '127.0.0.1',
    originPort,
    '/slow',
    {},
    Buffer.alloc(0),
    {},
    controller.signal
  );
  const outcome = request.then(
    () => ({ resolved: true }),
    error => ({ error })
  );
  await started;
  controller.abort();

  const result = await Promise.race([outcome, delay(300).then(() => null)]);
  assert.equal(result?.error?.code, 'ERR_DOWNSTREAM_ABORTED');
  assert.equal(await Promise.race([closed.then(() => true), delay(300).then(() => false)]), true);
});
