import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';
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

function requestThroughProxy(proxyPort, targetUrl) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: targetUrl
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

async function createSocketTrap(t) {
  let connections = 0;
  const sockets = new Set();
  const server = net.createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.end('HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  const port = await listen(server);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return close(server);
  });
  return { port, get connections() { return connections; } };
}

test('Send rejects unsupported URL schemes before opening a socket', async t => {
  const trap = await createSocketTrap(t);

  await assert.rejects(
    ApiServer.prototype._sendRequest.call(
      {},
      `ftp://127.0.0.1:${trap.port}/resource`,
      'GET',
      {},
      ''
    ),
    /Unsupported Send URL protocol: ftp:/
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(trap.connections, 0);
});

test('plain proxy rejects unsupported absolute-form schemes before opening a socket', async t => {
  const trap = await createSocketTrap(t);
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(() => proxy.stop());

  const response = await requestThroughProxy(
    proxy.server.address().port,
    `ftp://127.0.0.1:${trap.port}/resource`
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(response.statusCode, 400);
  assert.match(response.body, /Unsupported request URL protocol: ftp:/);
  assert.equal(trap.connections, 0);
});

test('proxy Upgrade rejects unsupported absolute-form schemes before opening a socket', async t => {
  const trap = await createSocketTrap(t);
  const proxy = new ProxyServer(null, { port: 0 });
  const socket = new PassThrough();
  const chunks = [];
  socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const ended = once(socket, 'end');

  proxy._handleHttpUpgrade({
    url: `ftp://127.0.0.1:${trap.port}/socket`,
    rawHeaders: [
      'Host', `127.0.0.1:${trap.port}`,
      'Connection', 'Upgrade',
      'Upgrade', 'websocket'
    ],
    headers: { connection: 'Upgrade', upgrade: 'websocket' }
  }, socket, Buffer.alloc(0));
  await ended;
  await new Promise(resolve => setImmediate(resolve));

  const response = Buffer.concat(chunks).toString('latin1');
  assert.match(response, /^HTTP\/1\.1 400 Bad Request/);
  assert.match(response, /Unsupported upgrade URL protocol: ftp:/);
  assert.equal(trap.connections, 0);
});

test('plain proxy forwards absolute-form HTTPS over TLS', { timeout: 20000 }, async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-bug-176-'));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const originCert = await ca.generateCertForHost('127.0.0.1');
  let originRequests = 0;
  const origin = https.createServer({ key: originCert.key, cert: originCert.cert }, (req, res) => {
    originRequests++;
    res.end('secure response');
  });
  const originPort = await listen(origin);

  const proxy = new ProxyServer(ca, { port: 0 });
  proxy.setHttpsWhitelist(['127.0.0.1']);
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin);
    await rm(dataDir, { recursive: true, force: true });
  });

  const response = await requestThroughProxy(
    proxy.server.address().port,
    `https://127.0.0.1:${originPort}/secure`
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'secure response');
  assert.equal(originRequests, 1);
});

test('mock forwards reject unsupported URL schemes before opening a socket', async t => {
  const trap = await createSocketTrap(t);
  const proxy = new ProxyServer(null, { port: 0 });
  proxy.mockRules = [{
    enabled: true,
    matchers: [],
    action: {
      type: 'forward',
      forwardTo: `ftp://127.0.0.1:${trap.port}`
    }
  }];
  await proxy.start();
  t.after(() => proxy.stop());

  const response = await requestThroughProxy(
    proxy.server.address().port,
    'http://original.invalid/resource'
  );
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(response.statusCode, 500);
  assert.match(response.body, /Unsupported mock forward URL protocol: ftp:/);
  assert.equal(trap.connections, 0);
});
