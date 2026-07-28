import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http2 from 'node:http2';
import test from 'node:test';

import { ProxyServer } from '../src/proxy/proxy-server.js';

function fakeSession() {
  const session = new EventEmitter();
  session.destroyed = false;
  session.closed = false;
  session.closeCalls = 0;
  session.close = () => {
    session.closeCalls++;
    session.closed = true;
  };
  session.destroy = () => { session.destroyed = true; };
  return session;
}

test('passthrough H2 sessions use and cache by captured ClientHello parameters', async t => {
  const proxy = new ProxyServer(null);
  proxy.setTlsFingerprint('passthrough');
  const originalConnect = http2.connect;
  const connections = [];
  http2.connect = (url, options) => {
    const session = fakeSession();
    connections.push({ url, options, session });
    queueMicrotask(() => session.emit('connect'));
    return session;
  };
  t.after(() => {
    proxy._closeAllH2Sessions();
    http2.connect = originalConnect;
  });

  const chromeLike = {
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    ciphers: 'TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256',
    sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256',
    ecdhCurve: 'X25519:P-256'
  };
  const firefoxLike = {
    ...chromeLike,
    ciphers: 'TLS_CHACHA20_POLY1305_SHA256:ECDHE-RSA-CHACHA20-POLY1305'
  };

  const first = await proxy._getH2Session('fingerprint.example.test', 443, chromeLike);
  const reused = await proxy._getH2Session('fingerprint.example.test', 443, { ...chromeLike });
  const second = await proxy._getH2Session('fingerprint.example.test', 443, firefoxLike);

  assert.equal(first, reused);
  assert.notEqual(first, second);
  assert.equal(connections.length, 2);
  assert.equal(proxy._h2Sessions.size, 2);
  assert.equal(connections[0].url, 'https://fingerprint.example.test:443');
  assert.equal(connections[0].options.minVersion, chromeLike.minVersion);
  assert.equal(connections[0].options.maxVersion, chromeLike.maxVersion);
  assert.equal(connections[0].options.ciphers, chromeLike.ciphers);
  assert.equal(connections[0].options.sigalgs, chromeLike.sigalgs);
  assert.equal(connections[0].options.ecdhCurve, chromeLike.ecdhCurve);
  assert.deepEqual(connections[0].options.ALPNProtocols, ['h2']);
  assert.equal(connections[1].options.ciphers, firefoxLike.ciphers);
});

test('changing the TLS fingerprint evicts sessions and the fingerprinted proxy agent', t => {
  const proxy = new ProxyServer(null);
  const firstSession = fakeSession();
  const firstTimer = setTimeout(() => {}, 60000);
  let agentDestroyed = false;
  proxy._h2Sessions.set('cached.example.test:443', {
    session: firstSession,
    timer: firstTimer,
    pending: null,
    attempt: Symbol('first')
  });
  proxy._h2Blacklist.add('blacklisted.example.test:443');
  proxy._upstreamAgent = { destroy: () => { agentDestroyed = true; } };
  proxy._upstreamAgentKey = 'old-fingerprint';
  t.after(() => proxy._closeAllH2Sessions());

  proxy.setTlsFingerprint('safari-18');

  assert.equal(firstSession.closeCalls, 1);
  assert.equal(agentDestroyed, true);
  assert.equal(proxy._h2Sessions.size, 0);
  assert.equal(proxy._h2Blacklist.size, 0);

  const retainedSession = fakeSession();
  proxy._h2Sessions.set('retained.example.test:443', {
    session: retainedSession,
    timer: setTimeout(() => {}, 60000),
    pending: null,
    attempt: Symbol('retained')
  });
  proxy.setTlsFingerprint('safari-18');

  assert.equal(retainedSession.closeCalls, 0);
  assert.equal(proxy._h2Sessions.size, 1);
});
