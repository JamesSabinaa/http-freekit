import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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

test('a failed H2 capability probe is retried after its cooldown', async t => {
  let now = 10000;
  const failedSession = fakeSession();
  const recoveredSession = fakeSession();
  const sessions = [failedSession, recoveredSession];
  let connectCalls = 0;
  const proxy = new ProxyServer(null, { h2BlacklistTtlMs: 1000 });
  t.mock.method(proxy, '_connectH2Tls', async () => ({ destroy() {} }));

  t.mock.method(Date, 'now', () => now);
  t.mock.method(http2, 'connect', () => sessions[connectCalls++]);
  t.after(() => proxy._closeAllH2Sessions());

  const firstAttempt = proxy._getH2Session('recovered.example.test', 443);
  await nextTurn();
  failedSession.emit('error', new Error('temporary connection failure'));
  assert.equal(await firstAttempt, null);
  assert.equal(connectCalls, 1);

  now += 999;
  assert.equal(await proxy._getH2Session('recovered.example.test', 443), null);
  assert.equal(connectCalls, 1, 'the cooldown suppresses repeated capability probes');

  now += 1;
  const retry = proxy._getH2Session('recovered.example.test', 443);
  await nextTurn();
  assert.equal(connectCalls, 2, 'the origin is retried when the cooldown expires');
  recoveredSession.emit('connect');
  assert.equal(await retry, recoveredSession);
  assert.equal(proxy._h2Blacklist.size, 0);
  assert.equal(proxy._h2BlacklistExpiresAt.size, 0);
});

test('closing H2 state clears failure cooldown metadata', async t => {
  const failedSession = fakeSession();
  const proxy = new ProxyServer(null);
  t.mock.method(proxy, '_connectH2Tls', async () => ({ destroy() {} }));
  t.mock.method(http2, 'connect', () => failedSession);
  t.after(() => proxy._closeAllH2Sessions());

  const attempt = proxy._getH2Session('reset.example.test', 443);
  await nextTurn();
  failedSession.emit('error', new Error('temporary connection failure'));
  assert.equal(await attempt, null);
  assert.equal(proxy._h2BlacklistExpiresAt.size, 1);

  proxy._closeAllH2Sessions();
  assert.equal(proxy._h2Blacklist.size, 0);
  assert.equal(proxy._h2BlacklistExpiresAt.size, 0);
});

test('new H2 failures release expired cooldowns for origins that are never revisited', t => {
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const proxy = new ProxyServer(null, { h2BlacklistTtlMs: 1000 });
  proxy._blacklistH2Origin('old.example.test:443');
  now += 500;
  proxy._blacklistH2Origin('recent.example.test:443');
  now += 500;
  proxy._blacklistH2Origin('new.example.test:443');

  assert.equal(proxy._h2Blacklist.has('old.example.test:443'), false);
  assert.equal(proxy._h2BlacklistExpiresAt.has('old.example.test:443'), false);
  assert.equal(proxy._isH2Blacklisted('recent.example.test:443'), true);
  assert.equal(proxy._isH2Blacklisted('new.example.test:443'), true);
});

test('H2 failure cooldown storage is bounded while explicit capability exclusions remain', () => {
  const proxy = new ProxyServer(null);
  proxy._h2Blacklist.add('excluded.example.test:443');
  for (let index = 0; index < 512; index++) {
    proxy._blacklistH2Origin(`failed-${index}.example.test:443`);
  }

  assert.ok(proxy._h2BlacklistExpiresAt.size <= 128);
  assert.ok(proxy._h2Blacklist.size <= 129);
  assert.equal(proxy._isH2Blacklisted('failed-0.example.test:443'), false);
  assert.equal(proxy._isH2Blacklisted('failed-511.example.test:443'), true);
  assert.equal(proxy._isH2Blacklisted('excluded.example.test:443'), true);
});
