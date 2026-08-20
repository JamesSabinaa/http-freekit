import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http2 from 'node:http2';
import test from 'node:test';

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
  const session = fakeSession();
  const getTimer = captureTimeout(t, 123);
  t.mock.method(http2, 'connect', () => session);
  t.after(() => proxy._closeAllH2Sessions());

  const pending = proxy._getH2Session('timeout.example.test', 443);
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
  assert.ok(getTimer());
  getTimer().run();

  assert.equal(await pending, null);
});

test('a zero upstream connect timeout disables the H2 probe timer', async t => {
  const proxy = new ProxyServer(null, { upstreamConnectTimeoutMs: 0 });
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
