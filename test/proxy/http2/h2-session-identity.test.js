import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http2 from 'node:http2';
import test from 'node:test';

import { ProxyServer } from '../../../src/proxy/proxy-server.js';

const HOSTNAME = 'h2-race.example.test';
const PORT = 443;
const ORIGIN = `${HOSTNAME}:${PORT}`;

function fakeSession(name) {
  const session = new EventEmitter();
  session.name = name;
  session.destroyed = false;
  session.closed = false;
  session.closeCalls = 0;
  session.destroyCalls = 0;
  session.close = () => {
    session.closeCalls += 1;
    session.closed = true;
  };
  session.destroy = () => {
    session.destroyCalls += 1;
    session.destroyed = true;
  };
  return session;
}

function installTimerHarness(t) {
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);
  const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const timers = [];

  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay !== 5000 && delay !== 60000) {
      return realSetTimeout(callback, delay, ...args);
    }
    const timer = {
      delay,
      cleared: false,
      run: () => callback(...args)
    };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => {
    if (timers.includes(timer)) {
      timer.cleared = true;
      return;
    }
    realClearTimeout(timer);
  });

  return timers;
}

function createHarness(t, sessions) {
  const proxy = new ProxyServer(null);
  const timers = installTimerHarness(t);
  let connectCalls = 0;
  t.mock.method(http2, 'connect', () => {
    const session = sessions[connectCalls];
    connectCalls += 1;
    assert.ok(session, `unexpected HTTP/2 connect call ${connectCalls}`);
    return session;
  });
  t.after(() => proxy._closeAllH2Sessions());
  return { proxy, timers, getConnectCalls: () => connectCalls };
}

async function connectSession(proxy, session) {
  const pending = proxy._getH2Session(HOSTNAME, PORT);
  session.emit('connect');
  assert.equal(await pending, session);
  return proxy._h2Sessions.get(ORIGIN);
}

test('concurrent HTTP/2 callers still coalesce onto one pending attempt', async t => {
  const session = fakeSession('coalesced');
  const { proxy, getConnectCalls } = createHarness(t, [session]);

  const first = proxy._getH2Session(HOSTNAME, PORT);
  const second = proxy._getH2Session(HOSTNAME, PORT);

  assert.equal(first, second);
  assert.equal(getConnectCalls(), 1);

  session.emit('connect');
  assert.deepEqual(await Promise.all([first, second]), [session, session]);
  assert.equal(await proxy._getH2Session(HOSTNAME, PORT), session);
  assert.equal(getConnectCalls(), 1, 'the connected session remains cached');
});

test('stale established-session callbacks cannot evict or blacklist a replacement', async t => {
  for (const callbackName of ['close', 'error', 'goaway', 'idle']) {
    await t.test(callbackName, async t => {
      const sessionA = fakeSession('A');
      const sessionB = fakeSession('B');
      const { proxy, timers } = createHarness(t, [sessionA, sessionB]);
      const entryA = await connectSession(proxy, sessionA);
      const idleTimerA = timers.find(timer => timer.delay === 60000 && !timer.cleared);
      assert.ok(idleTimerA, 'session A has an identity-bound idle callback');

      assert.equal(
        proxy._evictH2Session(ORIGIN, sessionA, entryA.attempt),
        true,
        'session A is removed before replacement'
      );
      const entryB = await connectSession(proxy, sessionB);

      if (callbackName === 'error') sessionA.emit('error', new Error('late A error'));
      else if (callbackName === 'idle') idleTimerA.run();
      else sessionA.emit(callbackName);

      assert.equal(proxy._h2Sessions.get(ORIGIN), entryB);
      assert.equal(entryB.session, sessionB);
      assert.equal(sessionB.closeCalls, 0);
      assert.equal(proxy._h2Blacklist.has(ORIGIN), false);
    });
  }
});

test('eviction deletes the mapped session before close can synchronously install a replacement', async t => {
  const sessionA = fakeSession('A');
  const sessionB = fakeSession('B');
  const { proxy, getConnectCalls } = createHarness(t, [sessionA, sessionB]);
  const entryA = await connectSession(proxy, sessionA);
  let mappedDuringClose;
  let replacementPending;
  sessionA.close = () => {
    sessionA.closeCalls += 1;
    mappedDuringClose = proxy._h2Sessions.get(ORIGIN);
    replacementPending = proxy._getH2Session(HOSTNAME, PORT);
    sessionA.closed = true;
  };

  proxy._evictH2Session(ORIGIN, sessionA, entryA.attempt);

  assert.equal(mappedDuringClose, undefined);
  assert.equal(getConnectCalls(), 2, 'close observes an empty cache and starts replacement B');
  assert.equal(proxy._h2Sessions.get(ORIGIN).session, sessionB);

  sessionB.emit('connect');
  assert.equal(await replacementPending, sessionB);
  assert.equal(proxy._h2Sessions.get(ORIGIN).session, sessionB);
});

test('closeAll invalidates a pending attempt before its callbacks race with replacement B', async t => {
  const sessionA = fakeSession('pending A');
  const sessionB = fakeSession('replacement B');
  const { proxy, timers } = createHarness(t, [sessionA, sessionB]);
  const pendingA = proxy._getH2Session(HOSTNAME, PORT);
  const connectTimerA = timers.find(timer => timer.delay === 5000 && !timer.cleared);
  assert.ok(connectTimerA);

  proxy._closeAllH2Sessions();

  assert.equal(await pendingA, null, 'bulk close settles the invalidated pending caller');
  assert.equal(proxy._h2Sessions.has(ORIGIN), false);
  assert.equal(proxy._h2Blacklist.has(ORIGIN), false);
  assert.equal(sessionA.closeCalls, 1);

  const entryB = await connectSession(proxy, sessionB);

  // Every callback from pending A is stale now, including a connect or timeout
  // that was already queued when closeAll invalidated the attempt.
  sessionA.emit('connect');
  sessionA.emit('error', new Error('late pending A error'));
  sessionA.emit('close');
  sessionA.emit('goaway');
  connectTimerA.run();

  assert.equal(proxy._h2Sessions.get(ORIGIN), entryB);
  assert.equal(entryB.session, sessionB);
  assert.equal(sessionB.closeCalls, 0);
  assert.equal(proxy._h2Blacklist.has(ORIGIN), false);
});

test('current pre-connect errors and timeouts retain existing null/blacklist behavior', async t => {
  for (const failure of ['error', 'timeout']) {
    await t.test(failure, async t => {
      const session = fakeSession(failure);
      const { proxy, timers } = createHarness(t, [session]);
      const pending = proxy._getH2Session(HOSTNAME, PORT);

      if (failure === 'error') session.emit('error', new Error('ALPN failed'));
      else timers.find(timer => timer.delay === 5000 && !timer.cleared).run();

      assert.equal(await pending, null);
      assert.equal(proxy._h2Sessions.has(ORIGIN), false);
      assert.equal(proxy._h2Blacklist.has(ORIGIN), true);
      if (failure === 'timeout') assert.equal(session.destroyCalls, 1);
    });
  }
});
