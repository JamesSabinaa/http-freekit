import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';

import { CertificateAuthority } from '../src/proxy/certificate-authority.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

function createDownstream() {
  return {
    completed: 0,
    complete() {
      this.completed += 1;
    }
  };
}

async function openTunnel(proxyPort, hostname) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\n\r\n`);

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

async function sendH2Post(proxyPort, hostname) {
  const tunnel = await openTunnel(proxyPort, hostname);
  const secureSocket = tls.connect({
    socket: tunnel,
    servername: hostname,
    ALPNProtocols: ['h2'],
    rejectUnauthorized: false
  });
  await once(secureSocket, 'secureConnect');
  const client = http2.connect(`https://${hostname}`, { createConnection: () => secureSocket });
  await once(client, 'connect');

  try {
    const request = client.request({
      ':method': 'POST',
      ':path': '/mutate',
      ':authority': hostname,
      ':scheme': 'https'
    });
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    const responsePromise = once(request, 'response');
    const endPromise = once(request, 'end');
    request.end('mutation');
    const [headers] = await responsePromise;
    await endPromise;
    return { headers, body: Buffer.concat(chunks).toString('utf8') };
  } finally {
    client.destroy();
  }
}

test('an attempted H2 mutation is settled instead of falling back and replaying', () => {
  const proxy = new ProxyServer();
  const error = new Error('stream reset after origin processed request');

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT']) {
    const downstream = createDownstream();
    const responses = [];

    const settled = proxy._settleNonReplayableH2Failure(
      method, true, error, downstream, value => responses.push(value)
    );

    assert.equal(settled, true, method);
    assert.equal(downstream.completed, 1, method);
    assert.deepEqual(responses, [error], method);
  }
});

test('H2 setup failures and safe methods may still fall back to HTTP/1.1', () => {
  const proxy = new ProxyServer();
  const error = new Error('h2 unavailable');

  for (const [method, requestAttempted] of [
    ['POST', false],
    ['GET', true],
    ['HEAD', true],
    ['OPTIONS', true],
    ['TRACE', true]
  ]) {
    const downstream = createDownstream();
    let responded = false;

    const settled = proxy._settleNonReplayableH2Failure(
      method, requestAttempted, error, downstream, () => { responded = true; }
    );

    assert.equal(settled, false, `${method}/${requestAttempted}`);
    assert.equal(downstream.completed, 0, `${method}/${requestAttempted}`);
    assert.equal(responded, false, `${method}/${requestAttempted}`);
  }
});

test('H2 stream creation is reported only after session.request succeeds', async () => {
  const proxy = new ProxyServer();
  const setupError = new Error('session closed before stream creation');
  let created = 0;
  const requestArgs = [
    'POST', 'example.test', 443, '/', {}, Buffer.alloc(0), {}, null, null,
    () => { created += 1; }
  ];

  await assert.rejects(
    proxy._makeH2Request({ request: () => { throw setupError; } }, ...requestArgs),
    setupError
  );
  assert.equal(created, 0);

  const attemptedError = new Error('failed after stream creation');
  const stream = new EventEmitter();
  stream.destroyed = false;
  stream.closed = false;
  stream.end = () => { throw attemptedError; };
  stream.close = () => { stream.closed = true; };
  await assert.rejects(
    proxy._makeH2Request({ request: () => stream }, ...requestArgs),
    attemptedError
  );
  assert.equal(created, 1);
});

test('H2 routing never replays an attempted POST but falls back after setup failure',
  { timeout: 20000 }, async t => {
    t.mock.method(console, 'log', () => {});
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-h2-replay-'));
    const ca = new CertificateAuthority(dataDir);
    await ca.initialize();
    const proxy = new ProxyServer(ca, { port: 0 });
    proxy.setHttp2Config('h2-only');
    proxy.setTlsFingerprint('passthrough');

    let failureMode = 'attempted';
    let h1Requests = 0;
    proxy._getH2Session = async () => ({
      request() {
        if (failureMode === 'setup') throw new Error('setup H2 failure');
        const request = new EventEmitter();
        request.destroyed = false;
        request.closed = false;
        request.writableEnded = false;
        request.write = () => true;
        request.sendTrailers = () => {};
        request.close = () => { request.closed = true; };
        request.destroy = () => { request.destroyed = true; };
        request.pipe = () => request;
        request.end = () => setImmediate(() => {
          const error = new Error('attempted H2 failure');
          error.code = 'ECONNRESET';
          request.emit('error', error);
        });
        return request;
      }
    });
    t.mock.method(https, 'request', () => {
      h1Requests += 1;
      const request = new EventEmitter();
      request.write = () => true;
      request.addTrailers = () => {};
      request.destroy = () => {};
      request.setTimeout = () => request;
      request.end = () => setImmediate(() => {
        const error = new Error('H1 fallback reached');
        error.code = 'EINVAL';
        request.emit('error', error);
      });
      return request;
    });

    await proxy.start();
    t.after(async () => {
      await proxy.stop();
      await rm(dataDir, { recursive: true, force: true });
    });

    const attempted = await sendH2Post(proxy.server.address().port, 'attempted.example.test');
    assert.equal(attempted.headers[':status'], 502);
    assert.match(attempted.body, /attempted H2 failure/);
    assert.equal(h1Requests, 0);

    failureMode = 'setup';
    const setup = await sendH2Post(proxy.server.address().port, 'setup.example.test');
    assert.equal(setup.headers[':status'], 502);
    assert.match(setup.body, /H1 fallback reached/);
    assert.equal(h1Requests, 1);
  });
