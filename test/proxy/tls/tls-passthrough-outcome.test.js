import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await delay(5);
  }
}

function openTunnel(proxyPort, target) {
  const socket = net.connect(proxyPort, '127.0.0.1');
  socket.once('connect', () => socket.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`
  ));
  return socket;
}

function waitForHeaders(socket) {
  return new Promise((resolve, reject) => {
    let response = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for CONNECT response')), 1000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const onData = (chunk) => {
      response += chunk.toString('utf8');
      if (response.includes('\r\n\r\n')) {
        cleanup();
        resolve(response);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      if (!response.includes('\r\n\r\n')) {
        cleanup();
        reject(new Error(`Socket closed before complete response: ${response}`));
      }
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

test('failed TLS passthrough emits one 502 tunnel event', async (t) => {
  const closedPortProbe = net.createServer();
  const closedPort = await listen(closedPortProbe);
  await close(closedPortProbe);

  const events = [];
  const proxy = new ProxyServer(null, {
    port: 0,
    upstreamConnectTimeoutMs: 200,
    onRequest: (event) => events.push(event)
  });
  proxy.setTlsPassthrough(['127.0.0.1']);
  await proxy.start();
  t.after(() => proxy.stop());

  const client = openTunnel(proxy.server.address().port, `127.0.0.1:${closedPort}`);
  t.after(() => client.destroy());
  const response = await waitForHeaders(client);
  assert.match(response, /^HTTP\/1\.1 502 Bad Gateway/);

  await waitFor(() => events.length === 1);
  await delay(20);
  assert.equal(events.length, 1);
  assert.equal(events[0].statusCode, 502);
  assert.equal(events[0].statusMessage, 'Bad Gateway');
  assert.equal(events[0].responseBodySize, 0);
  assert.equal(events[0].errorCode, 'ECONNREFUSED');
  assert.equal(events[0].errorPhase, 'connect');
  assert.match(events[0].error, /ECONNREFUSED|refused/i);
});

test('successful TLS passthrough emits one 200 only after relaying data', async (t) => {
  const targetSockets = new Set();
  const target = net.createServer((socket) => {
    targetSockets.add(socket);
    socket.once('close', () => targetSockets.delete(socket));
    socket.on('data', (chunk) => socket.write(chunk));
  });
  const targetPort = await listen(target);

  const events = [];
  const proxy = new ProxyServer(null, {
    port: 0,
    onRequest: (event) => events.push(event)
  });
  proxy.setTlsPassthrough(['127.0.0.1']);
  await proxy.start();
  t.after(async () => {
    for (const socket of targetSockets) socket.destroy();
    await proxy.stop();
    await close(target);
  });

  const client = openTunnel(proxy.server.address().port, `127.0.0.1:${targetPort}`);
  t.after(() => client.destroy());
  const response = await waitForHeaders(client);
  assert.match(response, /^HTTP\/1\.1 200 Connection Established/);
  assert.equal(events.length, 0, 'the successful tunnel remains pending while it is open');

  const echoed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for tunnel echo')), 1000);
    client.once('data', (chunk) => {
      clearTimeout(timer);
      resolve(chunk.toString('utf8'));
    });
    client.once('error', reject);
  });
  client.write('tunnel-data');
  assert.equal(await echoed, 'tunnel-data');

  client.destroy();
  await waitFor(() => events.length === 1);
  await delay(20);
  assert.equal(events.length, 1);
  assert.equal(events[0].statusCode, 200);
  assert.equal(events[0].statusMessage, 'Tunnel Established');
  assert.equal(events[0].requestBodySize, Buffer.byteLength('tunnel-data'));
  assert.equal(events[0].responseBodySize, Buffer.byteLength('tunnel-data'));
  assert.equal(events[0].error, undefined);
});

test('client close before upstream connection cannot emit tunnel success', async (t) => {
  const upstreamSockets = new Set();
  const upstream = http.createServer();
  upstream.on('connection', (socket) => {
    upstreamSockets.add(socket);
    socket.once('close', () => upstreamSockets.delete(socket));
  });
  const pendingConnect = new Promise((resolve) => upstream.once('connect', resolve));
  upstream.on('connect', () => {});
  const upstreamPort = await listen(upstream);

  const events = [];
  const proxy = new ProxyServer(null, {
    port: 0,
    upstreamConnectTimeoutMs: 200,
    upstreamIdleTimeoutMs: 50,
    onRequest: (event) => events.push(event)
  });
  proxy.setTlsPassthrough(['early-close.example']);
  proxy.setUpstreamProxy({ host: '127.0.0.1', port: upstreamPort, type: 'http' });
  await proxy.start();
  t.after(async () => {
    for (const socket of upstreamSockets) socket.destroy();
    await proxy.stop();
    await close(upstream);
  });

  const client = openTunnel(proxy.server.address().port, 'early-close.example:443');
  t.after(() => client.destroy());
  await pendingConnect;
  client.destroy();

  await waitFor(() => events.length === 1);
  await delay(20);
  assert.equal(events.length, 1);
  assert.equal(events[0].statusCode, 502);
  assert.notEqual(events[0].statusCode, 200);
  assert.equal(events[0].responseBodySize, 0);
  assert.equal(events[0].errorPhase, 'response');
  assert.match(events[0].error, /timeout/i);
});
