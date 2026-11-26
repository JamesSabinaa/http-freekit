import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import http2 from 'node:http2';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { ProxyServer } from '../../../src/proxy/proxy-server.js';

function fakeSession() {
  const session = new EventEmitter();
  session.destroyed = false;
  session.closed = false;
  session.close = () => { session.closed = true; };
  session.destroy = () => { session.destroyed = true; };
  return session;
}

function captureTimeout(t, expectedDelay) {
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);
  const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
  let timer = null;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay !== expectedDelay) return realSetTimeout(callback, delay, ...args);
    timer = {
      cleared: false,
      unref() {},
      run: () => callback(...args)
    };
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', candidate => {
    if (candidate === timer) {
      candidate.cleared = true;
      return;
    }
    realClearTimeout(candidate);
  });
  return () => timer;
}

test('direct H2 probes use the configured upstream connect timeout', async t => {
  const proxy = new ProxyServer(null, { upstreamConnectTimeoutMs: 123 });
  t.mock.method(proxy, '_connectH2Tls', async () => ({ destroy() {} }));
  const session = fakeSession();
  const getTimer = captureTimeout(t, 123);
  t.mock.method(http2, 'connect', () => session);
  t.after(() => proxy._closeAllH2Sessions());

  const pending = proxy._getH2Session('timeout.example.test', 443);
  await nextTurn();
  assert.ok(getTimer());
  getTimer().run();

  assert.equal(await pending, null);
  assert.equal(session.destroyed, true);
});

test('proxied H2 probes use the configured upstream connect timeout', async t => {
  const proxy = new ProxyServer(null, { upstreamConnectTimeoutMs: 234 });
  proxy.setUpstreamProxy({ host: '127.0.0.1', port: 9999, type: 'http' });
  proxy._connectTcp = () => new Promise(() => {});
  const getTimer = captureTimeout(t, 234);
  t.after(() => proxy._closeAllH2Sessions());

  const pending = proxy._getH2Session('timeout.example.test', 443);
  await nextTurn();
  assert.ok(getTimer());
  getTimer().run();

  assert.equal(await pending, null);
});

test('a zero upstream connect timeout disables the H2 probe timer', async t => {
  const proxy = new ProxyServer(null, { upstreamConnectTimeoutMs: 0 });
  t.mock.method(proxy, '_connectH2Tls', async () => ({ destroy() {} }));
  const session = fakeSession();
  const scheduled = [];
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    scheduled.push(delay);
    return realSetTimeout(callback, delay, ...args);
  });
  t.mock.method(http2, 'connect', () => session);

  const pending = proxy._getH2Session('no-timeout.example.test', 443);
  assert.deepEqual(scheduled, []);
  proxy._closeAllH2Sessions();

  assert.equal(await pending, null);
});

test('closing H2 state cancels a stalled upstream HTTP CONNECT socket', { timeout: 5000 }, async t => {
  const upstream = http.createServer();
  const sockets = new Set();
  upstream.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const proxy = new ProxyServer(null, { upstreamConnectTimeoutMs: 0, upstreamIdleTimeoutMs: 0 });
  proxy.setUpstreamProxy({ host: '127.0.0.1', port: upstream.address().port });
  t.after(async () => {
    proxy._closeAllH2Sessions();
    proxy._destroyUpstreamAgent();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
  });

  const connected = once(upstream, 'connect');
  const pending = proxy._getH2Session('stalled.example.test', 443);
  const [, tunnel] = await connected;
  tunnel.once('end', () => tunnel.end());
  tunnel.resume();
  const closed = new Promise(resolve => tunnel.once('close', () => resolve(true)));
  proxy._closeAllH2Sessions();
  assert.equal(await pending, null);
  let deadline;
  try {
    const didClose = await Promise.race([
      closed,
      new Promise(resolve => { deadline = setTimeout(() => resolve(false), 500); })
    ]);
    assert.equal(didClose, true, 'shutdown must close CONNECT sockets before their response arrives');
  } finally {
    clearTimeout(deadline);
  }
});
