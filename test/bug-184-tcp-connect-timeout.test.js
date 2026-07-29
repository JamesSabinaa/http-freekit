import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ProxyServer } from '../src/proxy/proxy-server.js';

class PendingSocket extends EventEmitter {
  destroyed = false;

  destroy() {
    this.destroyed = true;
  }
}

function stubDirectConnect(t, socket) {
  const originalConnect = net.connect;
  net.connect = () => socket;
  t.after(() => {
    net.connect = originalConnect;
  });
}

function keepEventLoopAlive(t) {
  const guard = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(guard));
}

test('direct TCP establishment times out and cleans up a pending socket', async (t) => {
  const timeoutMs = 25;
  const proxy = new ProxyServer(null, { upstreamConnectTimeoutMs: timeoutMs });
  const socket = new PendingSocket();
  stubDirectConnect(t, socket);
  keepEventLoopAlive(t);

  const startedAt = Date.now();
  await assert.rejects(
    proxy._connectTcp('pending.example', 443),
    (error) => {
      assert.equal(error.code, 'ETIMEDOUT');
      assert.equal(error.upstreamPhase, 'connect');
      assert.match(error.message, /Upstream connection timeout after 0\.025s/);
      return true;
    }
  );

  assert.ok(Date.now() - startedAt < 500, 'timeout should reject promptly');
  assert.equal(socket.destroyed, true);
  assert.equal(socket.listenerCount('connect'), 0);
  assert.equal(socket.listenerCount('error'), 0);
});

test('direct TCP establishment clears its timer and listeners after connect', async (t) => {
  const timeoutMs = 20;
  const proxy = new ProxyServer(null, { upstreamConnectTimeoutMs: timeoutMs });
  const socket = new PendingSocket();
  stubDirectConnect(t, socket);

  const connection = proxy._connectTcp('connected.example', 443);
  queueMicrotask(() => socket.emit('connect'));

  assert.equal(await connection, socket);
  assert.equal(socket.listenerCount('connect'), 0);
  assert.equal(socket.listenerCount('error'), 0);
  await delay(timeoutMs * 3);
  assert.equal(socket.destroyed, false, 'settled connection must not be destroyed by a stale timer');
});

test('direct TCP establishment clears its timer and listeners after error', async (t) => {
  const timeoutMs = 20;
  const proxy = new ProxyServer(null, { upstreamConnectTimeoutMs: timeoutMs });
  const socket = new PendingSocket();
  const connectError = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
  stubDirectConnect(t, socket);

  const connection = proxy._connectTcp('failed.example', 443);
  queueMicrotask(() => socket.emit('error', connectError));

  await assert.rejects(connection, (error) => error === connectError);
  assert.equal(socket.listenerCount('connect'), 0);
  assert.equal(socket.listenerCount('error'), 0);
  await delay(timeoutMs * 3);
  assert.equal(socket.destroyed, false, 'error settlement must clear the timeout');
});
