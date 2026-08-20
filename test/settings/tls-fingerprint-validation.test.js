import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import {
  restoreSavedTlsFingerprintSetting
} from '../../src/proxy/tls-fingerprint-config.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';
import { Settings } from '../../src/settings.js';

function requestJson(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/tls-fingerprint',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

function getJson(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/api/tls-fingerprint'
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
  });
}

async function createHarness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-tls-fingerprint-'));
  const proxy = new ProxyServer(null);
  const settings = new Settings(dataDir);
  const api = new ApiServer(proxy, null, null);
  api.settings = settings;
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { port: server.address().port, proxy, settings };
}

function countConnectionResets(proxy) {
  const counts = { agents: 0, sessions: 0 };
  proxy._destroyUpstreamAgent = () => { counts.agents++; };
  proxy._closeAllH2Sessions = () => { counts.sessions++; };
  return counts;
}

test('TLS fingerprint setter accepts only presets and explicit modes', () => {
  const proxy = new ProxyServer(null);
  const supported = [
    ...Object.keys(ProxyServer.TLS_FINGERPRINTS),
    'default',
    'passthrough',
    'legacy-passthrough'
  ];
  for (const fingerprint of supported) {
    proxy.setTlsFingerprint(fingerprint);
    assert.equal(proxy.tlsFingerprint, fingerprint);
  }

  proxy.setTlsFingerprint('chrome-136');
  const resets = countConnectionResets(proxy);
  const beforeOptions = proxy._getUpstreamTlsOptions('example.test');
  for (const fingerprint of [undefined, null, '', 'unknown', '__proto__', 'toString', 42]) {
    assert.throws(
      () => proxy.setTlsFingerprint(fingerprint),
      error => error?.code === 'ERR_INVALID_TLS_FINGERPRINT'
    );
    assert.equal(proxy.tlsFingerprint, 'chrome-136');
  }
  assert.equal(proxy._getUpstreamTlsOptions('example.test').ciphers, beforeOptions.ciphers);
  assert.deepEqual(resets, { agents: 0, sessions: 0 });
});

test('TLS fingerprint API rejects unsupported IDs without runtime or persistence changes',
  async t => {
    const { port, proxy, settings } = await createHarness(t);
    proxy.setTlsFingerprint('firefox-133');
    settings.set('tlsFingerprint', proxy.tlsFingerprint);
    const beforeSettings = fs.readFileSync(settings.filePath);
    const resets = countConnectionResets(proxy);

    for (const body of [{}, { fingerprint: null }, { fingerprint: '' }, {
      fingerprint: 'unsupported-client'
    }]) {
      const response = await requestJson(port, body);
      assert.equal(response.statusCode, 400);
      assert.match(response.body.error, /Invalid TLS fingerprint/);
      assert.equal(proxy.tlsFingerprint, 'firefox-133');
      assert.deepEqual(fs.readFileSync(settings.filePath), beforeSettings);
    }
    assert.deepEqual(resets, { agents: 0, sessions: 0 });

    const response = await requestJson(port, { fingerprint: 'default' });
    assert.equal(response.statusCode, 200);
    assert.equal(proxy.tlsFingerprint, 'default');
    assert.equal(settings.get('tlsFingerprint'), 'default');

    const legacyResponse = await requestJson(port, { fingerprint: 'legacy-passthrough' });
    assert.equal(legacyResponse.statusCode, 200);
    assert.equal(proxy.tlsFingerprint, 'legacy-passthrough');
    assert.equal(settings.get('tlsFingerprint'), 'legacy-passthrough');
  });

test('startup ignores invalid saved TLS fingerprints without rewriting settings', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-tls-fingerprint-boot-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const settings = new Settings(dataDir);
  const proxy = new ProxyServer(null);
  proxy.setTlsFingerprint('safari-18');
  settings.set('tlsFingerprint', 'removed-preset');
  const beforeSettings = fs.readFileSync(settings.filePath);
  const resets = countConnectionResets(proxy);
  const errors = [];

  assert.equal(restoreSavedTlsFingerprintSetting(proxy, settings, {
    error: message => errors.push(message)
  }), false);
  assert.equal(proxy.tlsFingerprint, 'safari-18');
  assert.deepEqual(fs.readFileSync(settings.filePath), beforeSettings);
  assert.deepEqual(resets, { agents: 0, sessions: 0 });
  assert.match(
    errors[0],
    /Ignoring invalid saved TLS fingerprint: Invalid TLS fingerprint/
  );

  settings.set('tlsFingerprint', 'legacy-passthrough');
  assert.equal(restoreSavedTlsFingerprintSetting(proxy, settings), true);
  assert.equal(proxy.tlsFingerprint, 'legacy-passthrough');
});

test('TLS fingerprint settings expose the raw ClientHello fidelity limit', async t => {
  const { port } = await createHarness(t);
  const response = await getJson(port);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.fidelity.byteExactClientHello, false);
  assert.equal(typeof response.body.fidelity.clientHelloMirroringSupported, 'boolean');
  assert.equal(response.body.fidelity.runtime.node, process.versions.node);
  assert.equal(response.body.fidelity.runtime.openssl, process.versions.openssl);
  assert.ok(response.body.fidelity.limitations.some(limitation => /GREASE/.test(limitation)));

  const settingsHtml = fs.readFileSync(
    new URL('../../src/ui/index.html', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(settingsHtml, /Client impersonation \(full\)/);
  assert.match(settingsHtml, /Raw ClientHello\/JA3 can still differ/);
});
