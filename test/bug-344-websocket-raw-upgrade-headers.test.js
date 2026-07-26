import assert from 'node:assert/strict';
import { once } from 'node:events';
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

function readUpgradeAndFrame(socket, frameLength) {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for proxied WebSocket upgrade and first frame'));
    }, 2000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const onData = chunk => {
      received = Buffer.concat([received, chunk]);
      const headerEnd = received.indexOf('\r\n\r\n');
      if (headerEnd !== -1 && received.length >= headerEnd + 4 + frameLength) {
        cleanup();
        resolve(received);
      }
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('WebSocket closed before its first frame arrived'));
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

test('accepted WebSocket upgrades preserve raw header fields and bytes before proxyHead', async t => {
  const firstCookie = 'session=one; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/';
  const secondCookie = 'preference=two; HttpOnly';
  const expectedHeaders = Buffer.from(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Connection: Upgrade\r\n' +
    'Upgrade: websocket\r\n' +
    'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n' +
    `Set-Cookie: ${firstCookie}\r\n` +
    'X-Trace: first\r\n' +
    `Set-Cookie: ${secondCookie}\r\n` +
    'x-TRACE: second\r\n' +
    'X-Obs-Text: café\r\n\r\n',
    'latin1'
  );
  const firstFrame = Buffer.from([0x81, 0x02, 0x6f, 0x6b]);
  const originSockets = new Set();
  const origin = net.createServer(originSocket => {
    originSockets.add(originSocket);
    originSocket.once('close', () => originSockets.delete(originSocket));
    originSocket.on('error', () => {});
    let request = Buffer.alloc(0);
    let responded = false;
    originSocket.on('data', chunk => {
      if (responded) return;
      request = Buffer.concat([request, chunk]);
      if (request.indexOf('\r\n\r\n') === -1) return;
      responded = true;
      originSocket.write(Buffer.concat([expectedHeaders, firstFrame]));
    });
  });
  const originPort = await listen(origin);
  const events = [];
  const proxy = new ProxyServer(null, { port: 0, onRequest: event => events.push(event) });
  await proxy.start();
  const client = net.connect(proxy.server.address().port, '127.0.0.1');

  t.after(async () => {
    client.destroy();
    for (const originSocket of originSockets) originSocket.destroy();
    await proxy.stop();
    await close(origin);
  });

  await once(client, 'connect');
  const responsePromise = readUpgradeAndFrame(client, firstFrame.length);
  client.write(
    `GET http://127.0.0.1:${originPort}/socket HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${originPort}\r\n` +
    'Connection: Upgrade\r\n' +
    'Upgrade: websocket\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
    'Sec-WebSocket-Version: 13\r\n\r\n'
  );
  const response = await responsePromise;
  const headerEnd = response.indexOf('\r\n\r\n') + 4;

  assert.deepEqual(response.subarray(0, headerEnd), expectedHeaders);
  assert.deepEqual(response.subarray(headerEnd, headerEnd + firstFrame.length), firstFrame);
  assert.equal(response.subarray(0, headerEnd).includes(Buffer.from([0xe9])), true);
  assert.equal(response.subarray(0, headerEnd).includes(Buffer.from([0xc3, 0xa9])), false);

  const connectedIndex = events.findIndex(
    event => event.protocol === 'ws' && event._update && event.statusCode === 101
  );
  const frameIndex = events.findIndex(event => event.protocol === 'ws-frame');
  assert.ok(connectedIndex >= 0 && connectedIndex < frameIndex);
  assert.deepEqual(events[connectedIndex].responseHeaders['set-cookie'], [firstCookie, secondCookie]);
  assert.equal(events[connectedIndex].responseHeaders['x-trace'], 'first, second');
  assert.equal(events[connectedIndex].responseHeaders['x-obs-text'], 'café');
});
