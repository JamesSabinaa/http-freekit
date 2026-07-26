import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { PassThrough } from 'node:stream';
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

function waitForSocketClose(socket, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeListener('close', handleClose);
      reject(new Error('Timed out waiting for the downstream socket to close'));
    }, timeoutMs);
    const handleClose = () => {
      clearTimeout(timeout);
      resolve();
    };
    socket.once('close', handleClose);
  });
}

test('rejected WebSocket response errors close and finalize only once', async () => {
  const updates = [];
  const proxy = new ProxyServer(null, {
    onRequest: update => updates.push(update)
  });
  const response = new PassThrough();
  response.statusCode = 403;
  response.statusMessage = 'Forbidden';
  response.headers = {
    'content-type': 'text/plain',
    'content-length': '100'
  };
  response.rawHeaders = [
    'Content-Type', 'text/plain',
    'Content-Length', '100'
  ];
  response.socket = null;

  const downstream = new PassThrough();
  const chunks = [];
  downstream.on('data', chunk => chunks.push(chunk));
  let endCalls = 0;
  const end = downstream.end;
  downstream.end = function (...args) {
    endCalls++;
    return end.apply(this, args);
  };
  const finished = once(downstream, 'finish');

  proxy._forwardRejectedUpgradeResponse(response, downstream, {
    id: 'rejected-upgrade',
    protocol: 'ws'
  }, Date.now());
  response.write('partial');

  const upstreamError = Object.assign(new Error('origin response failed'), {
    code: 'ECONNRESET'
  });
  response.emit('error', upstreamError);
  response.emit('aborted');
  response.emit('error', new Error('duplicate stream error'));
  response.end('not forwarded');
  await finished;

  const output = Buffer.concat(chunks).toString('latin1');
  assert.match(output, /^HTTP\/1\.1 403 Forbidden\r\n/);
  assert.match(output, /\r\n\r\npartial$/);
  assert.equal(output.match(/HTTP\/1\.1/g)?.length, 1);
  assert.equal(endCalls, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 'rejected-upgrade');
  assert.equal(updates[0].responseBody, 'partial');
  assert.equal(updates[0].responseBodySize, 7);
  assert.equal(updates[0].error, 'origin response failed');
  assert.equal(updates[0].errorCode, 'ECONNRESET');
});

test('an aborted rejected WebSocket response forwards its partial body and closes the client', async t => {
  const origin = net.createServer(socket => {
    socket.once('data', () => {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\n' +
        'Content-Type: text/plain\r\n' +
        'Content-Length: 100\r\n' +
        'Connection: close\r\n\r\n' +
        'partial'
      );
    });
  });
  const originPort = await listen(origin);
  const events = [];
  const proxy = new ProxyServer(null, {
    port: 0,
    onRequest: event => events.push(event)
  });
  await proxy.start();

  const chunks = [];
  const client = net.connect(proxy.server.address().port, '127.0.0.1');
  client.on('data', chunk => chunks.push(chunk));
  client.on('error', () => {});

  t.after(async () => {
    client.destroy();
    await proxy.stop();
    await close(origin);
  });

  await once(client, 'connect');
  client.write(
    `GET http://127.0.0.1:${originPort}/socket HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${originPort}\r\n` +
    'Connection: Upgrade\r\n' +
    'Upgrade: websocket\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
    'Sec-WebSocket-Version: 13\r\n\r\n'
  );

  await waitForSocketClose(client);

  const response = Buffer.concat(chunks).toString('latin1');
  assert.match(response, /^HTTP\/1\.1 401 Unauthorized\r\n/);
  assert.match(response, /\r\n\r\npartial$/);
  assert.equal(response.match(/HTTP\/1\.1/g)?.length, 1);
  assert.doesNotMatch(response, /502 Bad Gateway/);

  const captures = events.filter(event => event.protocol === 'ws');
  assert.equal(captures.length, 2);
  assert.equal(captures[0]._pending, true);
  assert.equal(captures[1]._update, true);
  assert.equal(captures[1].id, captures[0].id);
  assert.equal(captures[1].statusCode, 401);
  assert.equal(captures[1].responseBody, 'partial');
  assert.equal(captures[1].responseBodySize, 7);
  assert.match(captures[1].error, /response aborted/i);
});
