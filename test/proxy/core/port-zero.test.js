import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';

import { ProxyServer } from '../../../src/proxy/proxy-server.js';

function rawExchange(port, requestText) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    const timeout = setTimeout(() => socket.destroy(new Error('response timed out')), 2000);
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('close', hadError => {
      clearTimeout(timeout);
      if (!hadError) resolve(Buffer.concat(chunks).toString('latin1'));
    });
    socket.once('connect', () => socket.end(requestText));
  });
}

test('explicit destination port zero is rejected for HTTP, CONNECT, and upgrades', async t => {
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(() => proxy.stop());
  const port = proxy.server.address().port;

  const requests = [
    'GET http://127.0.0.1:0/path HTTP/1.1\r\nHost: 127.0.0.1:0\r\nConnection: close\r\n\r\n',
    'CONNECT 127.0.0.1:0 HTTP/1.1\r\nHost: 127.0.0.1:0\r\n\r\n',
    'GET ws://127.0.0.1:0/socket HTTP/1.1\r\nHost: 127.0.0.1:0\r\n' +
      'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
  ];

  for (const request of requests) {
    assert.match(await rawExchange(port, request), /^HTTP\/1\.1 400 /);
  }
});

test('outbound URL validation rejects port zero before a request is opened', () => {
  const proxy = new ProxyServer(null);
  assert.throws(
    () => proxy._assertSupportedOutboundUrl(new URL('http://example.test:0/'), 'request URL'),
    /port must be between 1 and 65535/
  );
  assert.match(
    proxy.validateBreakpointModifications({ url: 'https://example.test:0/path' }),
    /port must be between 1 and 65535/
  );
});
