import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import WebSocket from 'ws';

import { ApiServer } from '../../../src/api/api-server.js';

function createApi() {
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null, { authToken: 'shutdown-secret' });
  api.port = 0;
  return api;
}

function websocketRequest() {
  const key = crypto.randomBytes(16).toString('base64');
  return [
    'GET /ws?authToken=shutdown-secret HTTP/1.1',
    'Host: 127.0.0.1',
    'Connection: Upgrade',
    'Upgrade: websocket',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '',
    ''
  ].join('\r\n');
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function readHeaders(socket) {
  return new Promise((resolve, reject) => {
    let response = '';
    const onData = (chunk) => {
      response += chunk.toString('latin1');
      const end = response.indexOf('\r\n\r\n');
      if (end === -1) return;
      cleanup();
      resolve(response.slice(0, end + 4));
    };
    const onClose = () => {
      cleanup();
      resolve(response);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

async function completesWithin(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('stop promptly terminates an authenticated raw WebSocket peer that ignores close', async t => {
  t.mock.method(console, 'log', () => {});
  const api = createApi();
  await api.start();
  t.after(() => api.stop());
  const socket = await connect(api.httpServer.address().port);
  t.after(() => socket.destroy());
  socket.write(websocketRequest());
  assert.match(await readHeaders(socket), /^HTTP\/1\.1 101 Switching Protocols/);
  assert.equal(api.clients.size, 1);
  const closed = once(socket, 'close');
  const startedAt = Date.now();

  await completesWithin(
    api.stop(),
    750,
    'ApiServer.stop() did not terminate the raw WebSocket peer'
  );

  assert.ok(Date.now() - startedAt < 750);
  await closed;
  assert.equal(api.clients.size, 0);
  assert.equal(api.httpServer, null);
  assert.equal(api.wss, null);
});

test('shutdown state rejects authenticated upgrade races', async t => {
  t.mock.method(console, 'log', () => {});
  const api = createApi();
  await api.start();
  t.after(() => api.stop());
  const socket = await connect(api.httpServer.address().port);
  t.after(() => socket.destroy());
  api._stopping = true;
  socket.write(websocketRequest());

  assert.match(await readHeaders(socket), /^HTTP\/1\.1 503 Service Unavailable/);
});

test('management WebSocket lifecycle keeps start and stop idempotent', async t => {
  t.mock.method(console, 'log', () => {});
  const api = createApi();
  t.after(() => api.stop());

  const firstStart = api.start();
  const firstServer = api.httpServer;
  const duplicateStart = api.start();
  assert.equal(duplicateStart, firstStart);
  await Promise.all([firstStart, duplicateStart]);
  assert.equal(api.httpServer, firstServer);

  const ws = new WebSocket(`ws://127.0.0.1:${api.httpServer.address().port}/ws?authToken=shutdown-secret`);
  await once(ws, 'message');
  const wsClosed = once(ws, 'close');
  const firstStop = api.stop();
  const duplicateStop = api.stop();
  assert.equal(duplicateStop, firstStop);
  await Promise.all([firstStop, duplicateStop]);
  await wsClosed;
  await api.stop();
  assert.equal(api.httpServer, null);
  assert.equal(api.wss, null);

  await api.start();
  assert.equal(api.httpServer.listening, true);
  await api.stop();
});

test('stop settles an in-progress start without leaving a listener behind', async t => {
  t.mock.method(console, 'log', () => {});
  const api = createApi();
  const starting = api.start();
  const stopping = api.stop();

  await assert.rejects(starting, /startup cancelled by shutdown/);
  await completesWithin(stopping, 750, 'stop did not settle after cancelling start');
  assert.equal(api.httpServer, null);
  assert.equal(api.wss, null);
  assert.equal(api._httpSockets.size, 0);
});
