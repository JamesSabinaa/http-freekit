import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function exchange(port, request, expected) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 2000);
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.includes(expected)) {
        clearTimeout(timer);
        socket.destroy();
        resolve(data);
      }
    });
    socket.once('error', reject);
  });
}

test('TLS passthrough CONNECT uses the configured upstream proxy', async (t) => {
  let connectCount = 0;
  const target = net.createServer(socket => socket.on('data', chunk => socket.write(chunk)));
  const targetPort = await listen(target);
  const upstream = http.createServer();
  upstream.on('connect', (req, clientSocket, head) => {
    connectCount++;
    const targetSocket = net.connect(targetPort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) targetSocket.write(head);
      clientSocket.pipe(targetSocket).pipe(clientSocket);
    });
  });
  const upstreamPort = await listen(upstream);
  const proxy = new ProxyServer(null, { port: 0 });
  proxy.setTlsPassthrough(['127.0.0.1']);
  proxy.setUpstreamProxy({ host: '127.0.0.1', port: upstreamPort, type: 'http' });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(upstream);
    await close(target);
  });

  const socket = net.connect(proxy.server.address().port, '127.0.0.1');
  let response = '';
  await new Promise((resolve, reject) => {
    socket.once('connect', () => socket.write(
      `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`
    ));
    socket.on('data', chunk => {
      response += chunk.toString('utf8');
      if (response.includes('\r\n\r\n')) resolve();
    });
    socket.once('error', reject);
  });
  socket.write('tunnel-data');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for tunnel echo')), 2000);
    socket.on('data', chunk => {
      if (chunk.toString('utf8').includes('tunnel-data')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  socket.destroy();
  assert.equal(connectCount, 1);
});

test('plain WebSocket upgrades use the configured upstream proxy', async (t) => {
  let upgradeCount = 0;
  const upstream = http.createServer();
  upstream.on('upgrade', (req, socket) => {
    upgradeCount++;
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  const upstreamPort = await listen(upstream);
  const proxy = new ProxyServer(null, { port: 0 });
  proxy.setUpstreamProxy({ host: '127.0.0.1', port: upstreamPort, type: 'http' });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(upstream);
  });

  const response = await exchange(proxy.server.address().port,
    'GET http://example.test/socket HTTP/1.1\r\n' +
      'Host: example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    '101 Switching Protocols');

  assert.match(response, /101 Switching Protocols/);
  assert.equal(upgradeCount, 1);
});

test('Google messaging passthrough carries binary traffic through the configured upstream', { timeout: 5000 }, async t => {
  const sockets = new Set();
  const upstream = http.createServer();
  upstream.on('connect', (request, socket, head) => {
    assert.equal(request.url, 'mtalk.google.com:5228');
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.write(head);
    socket.on('data', chunk => socket.write(chunk));
    socket.on('end', () => socket.end());
  });
  const upstreamPort = await listen(upstream);
  const events = [];
  let resolveCapture;
  const captured = new Promise(resolve => { resolveCapture = resolve; });
  const proxy = new ProxyServer(null, { port: 0, onRequest: event => {
    events.push(event);
    resolveCapture(event);
  } });
  proxy.setTlsPassthrough(['mtalk.google.com']);
  proxy.setUpstreamProxy({ host: '127.0.0.1', port: upstreamPort, type: 'http' });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    for (const socket of sockets) socket.destroy();
    await close(upstream);
  });
  assert.equal(proxy._isTlsPassthrough('mtalk.google.com'), true);
  assert.equal(proxy._isTlsPassthrough('www.google.com'), false);
  assert.equal(proxy._isTlsPassthrough('mtalk.google.com.example.test'), false);

  const client = net.connect(proxy.server.address().port, '127.0.0.1');
  t.after(() => client.destroy());
  await once(client, 'connect');
  const headers = once(client, 'data');
  client.write('CONNECT mtalk.google.com:5228 HTTP/1.1\r\nHost: mtalk.google.com:5228\r\n\r\n');
  assert.match((await headers)[0].toString(), /^HTTP\/1\.1 200 /);
  const bytes = Buffer.from([0x29, 0x02, 0x00, 0x01, 0xff, 0x00]);
  const echo = once(client, 'data');
  client.write(bytes);
  assert.deepEqual((await echo)[0], bytes);
  client.destroy();
  await captured;
  assert.equal(events.length, 1);
  assert.equal(events[0].protocol, 'tunnel');
  assert.equal(events[0].statusCode, 200);
  assert.equal(events[0].requestBodySize, bytes.length);
  assert.equal(events[0].responseBodySize, bytes.length);
});
