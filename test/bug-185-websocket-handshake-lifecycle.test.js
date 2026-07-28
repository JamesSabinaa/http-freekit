import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import { ProxyServer } from '../src/proxy/proxy-server.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function waitFor(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function captureTraffic() {
  const events = [];
  const traffic = [];

  return {
    events,
    traffic,
    onRequest(data) {
      const event = {
        ...data,
        requestHeaders: { ...data.requestHeaders },
        responseHeaders: { ...data.responseHeaders }
      };
      events.push(event);

      const record = { ...event };
      delete record._pending;
      delete record._update;
      if (event._update) {
        const index = traffic.findIndex(item => item.id === event.id);
        if (index === -1) traffic.push(record);
        else traffic[index] = record;
      } else {
        traffic.push(record);
      }
    }
  };
}

async function openUpgrade(proxyPort, originPort) {
  const chunks = [];
  const socket = net.connect(proxyPort, '127.0.0.1');
  socket.on('data', chunk => chunks.push(chunk));
  await once(socket, 'connect');
  socket.on('error', () => {});
  socket.write(
    `GET http://127.0.0.1:${originPort}/socket HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${originPort}\r\n` +
    'Connection: Upgrade\r\n' +
    'Upgrade: websocket\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
    'Sec-WebSocket-Version: 13\r\n\r\n'
  );
  return {
    socket,
    response: () => Buffer.concat(chunks).toString('latin1')
  };
}

test('a rejected WebSocket handshake completes its pending traffic parent', async t => {
  const origin = http.createServer((_req, res) => {
    res.writeHead(401, {
      'Content-Type': 'text/plain',
      'WWW-Authenticate': 'Bearer realm="test"'
    });
    res.end('denied');
  });
  const originPort = await listen(origin);
  const capture = captureTraffic();
  const proxy = new ProxyServer(null, { port: 0, onRequest: data => capture.onRequest(data) });
  await proxy.start();
  const client = await openUpgrade(proxy.server.address().port, originPort);

  t.after(async () => {
    client.socket.destroy();
    await proxy.stop();
    await close(origin);
  });

  await waitFor(
    () => capture.events.some(event => event._update && event.statusCode === 401),
    'Timed out waiting for the rejected handshake capture'
  );
  await waitFor(() => client.response().includes('denied'), 'Timed out waiting for the 401 response body');

  const parents = capture.events.filter(event => event.protocol === 'ws');
  assert.equal(parents.length, 2);
  assert.equal(parents[0]._pending, true);
  assert.equal(parents[0].statusCode, null);
  assert.equal(parents[1]._update, true);
  assert.equal(parents[1].id, parents[0].id);
  assert.equal(parents[1].statusCode, 401);
  assert.equal(parents[1].responseBody, 'denied');
  assert.equal(parents[1].responseBodySize, 6);
  assert.match(client.response(), /^HTTP\/1\.1 401 Unauthorized/m);

  const storedParents = capture.traffic.filter(event => event.protocol === 'ws');
  assert.equal(storedParents.length, 1);
  assert.equal(storedParents[0].statusCode, 401);
});

test('an upstream WebSocket error completes its pending traffic parent as 502', async t => {
  const unavailable = net.createServer();
  const unavailablePort = await listen(unavailable);
  await close(unavailable);

  const capture = captureTraffic();
  const proxy = new ProxyServer(null, { port: 0, onRequest: data => capture.onRequest(data) });
  await proxy.start();
  const client = await openUpgrade(proxy.server.address().port, unavailablePort);

  t.after(async () => {
    client.socket.destroy();
    await proxy.stop();
  });

  await waitFor(
    () => capture.events.some(event => event._update && event.statusCode === 502),
    'Timed out waiting for the failed handshake capture'
  );
  await waitFor(() => client.response().includes('502 Bad Gateway'), 'Timed out waiting for the 502 response');

  const parents = capture.events.filter(event => event.protocol === 'ws');
  assert.equal(parents.length, 2);
  assert.equal(parents[0]._pending, true);
  assert.equal(parents[1]._update, true);
  assert.equal(parents[1].id, parents[0].id);
  assert.equal(parents[1].statusCode, 502);
  assert.match(parents[1].responseBody, /^Proxy Error:/);
  assert.equal(parents[1].errorCode, 'ECONNREFUSED');

  const storedParents = capture.traffic.filter(event => event.protocol === 'ws');
  assert.equal(storedParents.length, 1);
  assert.equal(storedParents[0].statusCode, 502);
});

test('shutdown aborts a delayed upstream upgrade before it can publish a late 101', async t => {
  let originSocket;
  let reportHandshake;
  const handshakeReceived = new Promise(resolve => { reportHandshake = resolve; });
  const origin = net.createServer(socket => {
    originSocket = socket;
    socket.on('error', () => {});
    socket.once('data', reportHandshake);
  });
  const originPort = await listen(origin);
  const capture = captureTraffic();
  const proxy = new ProxyServer(null, { port: 0, onRequest: data => capture.onRequest(data) });
  await proxy.start();
  const client = await openUpgrade(proxy.server.address().port, originPort);

  t.after(async () => {
    client.socket.destroy();
    originSocket?.destroy();
    await proxy.stop();
    await close(origin);
  });

  await handshakeReceived;
  client.socket.destroy();
  await proxy.stop();
  await waitFor(() => originSocket?.destroyed, 'Timed out waiting for the upstream handshake abort');

  const eventsAtStop = capture.events.length;
  if (!originSocket.destroyed) {
    originSocket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Connection: Upgrade\r\n' +
      'Upgrade: websocket\r\n\r\n'
    );
  }
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(capture.events.length, eventsAtStop);
  assert.equal(capture.events.some(event => event.statusCode === 101), false);
  assert.equal(proxy._pendingWsCaptureFinalizations.size, 0);
  const finalParent = capture.events.filter(event => event.protocol === 'ws').at(-1);
  assert.equal(finalParent.statusMessage, 'Client Disconnected');
  assert.equal(finalParent.errorCode, 'ERR_DOWNSTREAM_ABORTED');

  await Promise.race([
    proxy.stop(),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('A repeated stop waited on a late handshake lifecycle')),
      250
    ))
  ]);
});

test('forced shutdown closes both halves of an established WebSocket', async t => {
  let originSocket;
  let reportOriginClosed;
  const originClosed = new Promise(resolve => { reportOriginClosed = resolve; });
  const origin = net.createServer(socket => {
    originSocket = socket;
    socket.on('error', () => {});
    socket.once('close', reportOriginClosed);
    socket.once('data', () => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n\r\n'
      );
    });
  });
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  const client = await openUpgrade(proxy.server.address().port, originPort);

  t.after(async () => {
    client.socket.destroy();
    originSocket?.destroy();
    await proxy.stop();
    await close(origin);
  });

  await waitFor(
    () => client.response().includes('101 Switching Protocols'),
    'Timed out waiting for the established WebSocket'
  );
  await proxy.stop();
  await Promise.race([
    originClosed,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('Origin WebSocket stayed open after proxy shutdown')),
      500
    ))
  ]);

  assert.equal(client.socket.destroyed, true);
  assert.equal(originSocket.destroyed, true);
  assert.equal(proxy._pendingWsCaptureFinalizations.size, 0);
});

test('an open WebSocket has its 101 parent before frames and updates it on close', async t => {
  const serverFrame = Buffer.from([0x81, 0x02, 0x6f, 0x6b]);
  const originSockets = new Set();
  const origin = http.createServer();
  origin.on('upgrade', (_req, socket) => {
    originSockets.add(socket);
    socket.once('close', () => originSockets.delete(socket));
    socket.on('error', () => {});
    socket.on('end', () => socket.end());
    socket.write(Buffer.concat([
      Buffer.from(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n\r\n',
        'latin1'
      ),
      serverFrame
    ]));
  });
  const originPort = await listen(origin);
  const capture = captureTraffic();
  const proxy = new ProxyServer(null, { port: 0, onRequest: data => capture.onRequest(data) });
  await proxy.start();
  const client = await openUpgrade(proxy.server.address().port, originPort);

  t.after(async () => {
    client.socket.destroy();
    for (const socket of originSockets) socket.destroy();
    await proxy.stop();
    await close(origin);
  });

  await waitFor(
    () => capture.events.some(event => event.protocol === 'ws-frame'),
    'Timed out waiting for the WebSocket frame capture'
  );
  await waitFor(
    () => client.response().includes('101 Switching Protocols'),
    'Timed out waiting for the 101 response'
  );

  const pendingIndex = capture.events.findIndex(event => event.protocol === 'ws' && event._pending);
  const connectedIndex = capture.events.findIndex(
    event => event.protocol === 'ws' && event._update && event.statusCode === 101
  );
  const frameIndex = capture.events.findIndex(event => event.protocol === 'ws-frame');
  const pending = capture.events[pendingIndex];
  const connected = capture.events[connectedIndex];
  const frame = capture.events[frameIndex];

  assert.ok(pendingIndex >= 0 && pendingIndex < connectedIndex);
  assert.ok(connectedIndex < frameIndex);
  assert.equal(connected.id, pending.id);
  assert.equal(frame.parentId, pending.id);
  assert.equal(frame.requestBody, 'ok');
  assert.equal(client.socket.destroyed, false);
  assert.match(client.response(), /^HTTP\/1\.1 101 Switching Protocols/m);

  let storedParents = capture.traffic.filter(event => event.protocol === 'ws');
  assert.equal(storedParents.length, 1);
  assert.equal(storedParents[0].statusCode, 101);
  assert.equal(storedParents[0].responseBody, 'WebSocket connection open');

  client.socket.end();
  await waitFor(
    () => capture.events.filter(
      event => event.protocol === 'ws' && event._update && event.statusCode === 101
    ).length === 2,
    'Timed out waiting for the final WebSocket summary'
  );

  const finalParent = capture.events.filter(event => event.protocol === 'ws').at(-1);
  assert.equal(finalParent.id, pending.id);
  assert.equal(finalParent.requestBody, 'WebSocket: 0 sent, 1 received');
  assert.equal(finalParent.responseBody, '1 messages (4 bytes)');
  assert.equal(finalParent.responseBodySize, 4);

  storedParents = capture.traffic.filter(event => event.protocol === 'ws');
  assert.equal(storedParents.length, 1);
  assert.equal(storedParents[0].responseBody, '1 messages (4 bytes)');
});
