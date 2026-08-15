import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import { CertificateAuthority } from '../../src/proxy/certificate-authority.js';
import {
  MAX_HTTPS_WHITELIST_HOSTS,
  MAX_HTTPS_WHITELIST_PATTERN_LENGTH,
  restoreHttpsWhitelistSetting
} from '../../src/proxy/https-whitelist.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';
import { Settings } from '../../src/settings.js';

function requestJson(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let responseBody = text;
        try { responseBody = JSON.parse(text); } catch {}
        resolve({ statusCode: response.statusCode, body: responseBody });
      });
    });
    request.once('error', reject);
    request.end(payload);
  });
}

async function createApiHarness(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-https-whitelist-api-'));
  const settings = new Settings(dataDir);
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  api.settings = settings;
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { proxy, settings, port: server.address().port };
}

function malformedDirectCandidates(accessState) {
  const sparse = new Array(1);
  const inherited = new Array(1);
  Object.setPrototypeOf(inherited, Object.create(Array.prototype, {
    0: { value: 'inherited.test', enumerable: true }
  }));
  const accessor = [];
  Object.defineProperty(accessor, '0', {
    enumerable: true,
    configurable: true,
    get() {
      accessState.invoked = true;
      throw new Error('must not run');
    }
  });
  accessor.length = 1;
  const descriptorTrap = new Proxy(['trapped.test'], {
    getOwnPropertyDescriptor() {
      throw new Error('descriptor trap');
    }
  });

  return [
    'scalar.test',
    null,
    { 0: 'array-like.test', length: 1 },
    Object.setPrototypeOf({ 0: 'prototype-shaped.test', length: 1 }, Array.prototype),
    ['valid.test', 7],
    ['valid.test', new String('boxed.test')],
    [''],
    ['[]'],
    ['line\nbreak.test'],
    sparse,
    inherited,
    accessor,
    descriptorTrap,
    Array(MAX_HTTPS_WHITELIST_HOSTS + 1).fill('too-many.test'),
    ['x'.repeat(MAX_HTTPS_WHITELIST_PATTERN_LENGTH + 1)]
  ];
}

test('direct HTTPS whitelist updates reject exotic candidates before runtime mutation', () => {
  const proxy = new ProxyServer(null);
  const callerOwned = ['*.Example.Test.', '[::1]', 'exact.test'];
  proxy.setHttpsWhitelist(callerOwned);
  callerOwned[2] = 'mutated-after-install.test';
  const previous = proxy.httpsWhitelist;
  const accessState = { invoked: false };
  let resets = 0;
  proxy._destroyUpstreamAgent = () => { resets++; };
  proxy._closeAllH2Sessions = () => { resets++; };

  for (const candidate of malformedDirectCandidates(accessState)) {
    assert.throws(
      () => proxy.setHttpsWhitelist(candidate),
      error => error?.code === 'ERR_INVALID_HTTPS_WHITELIST'
    );
    assert.equal(proxy.httpsWhitelist, previous);
  }

  assert.equal(accessState.invoked, false);
  assert.equal(resets, 0);
  assert.equal(Object.isFrozen(proxy.httpsWhitelist), true);
  assert.equal(proxy._isHttpsWhitelisted('api.example.test'), false);
  assert.equal(proxy._isHttpsWhitelisted('*.example.test'), true);
  assert.equal(proxy._isHttpsWhitelisted('example.test'), false);
  assert.equal(proxy._isHttpsWhitelisted('::1'), true);
  assert.equal(proxy._isHttpsWhitelisted('exact.test'), true);
  assert.equal(proxy._isHttpsWhitelisted('mutated-after-install.test'), false);

  proxy.httpsWhitelist = { some: 'corrupt direct state' };
  assert.doesNotThrow(() => proxy._isHttpsWhitelisted('*.example.test'));
  assert.equal(proxy._isHttpsWhitelisted('api.example.test'), false);
  assert.equal(proxy._isHttpsWhitelisted('*.example.test'), true);
  assert.equal(proxy._isHttpsWhitelisted({ toString: null }), false);
});

test('HTTPS whitelist API rejects malformed arrays without mutating or writing settings', async t => {
  const { proxy, settings, port } = await createApiHarness(t);
  proxy.setHttpsWhitelist(['before.test']);
  settings.set('httpsWhitelist', proxy.httpsWhitelist);
  const previous = proxy.httpsWhitelist;
  const beforeBytes = fs.readFileSync(settings.filePath);

  for (const body of [
    {},
    { hosts: 'scalar.test' },
    { hosts: { 0: 'array-like.test', length: 1 } },
    { hosts: ['valid.test', 9] },
    { hosts: [null] },
    { hosts: ['   '] },
    { hosts: ['line\nbreak.test'] }
  ]) {
    const response = await requestJson(port, 'POST', '/api/https-whitelist', body);
    assert.equal(response.statusCode, 400);
    assert.match(response.body.error, /HTTPS whitelist/);
    assert.equal(proxy.httpsWhitelist, previous);
    assert.deepEqual(fs.readFileSync(settings.filePath), beforeBytes);
  }

  const invalidItem = await requestJson(port, 'POST', '/api/https-whitelist/items', {
    host: { hostname: 'object.test' }
  });
  assert.equal(invalidItem.statusCode, 400);
  assert.equal(proxy.httpsWhitelist, previous);
  assert.deepEqual(fs.readFileSync(settings.filePath), beforeBytes);

  const success = await requestJson(port, 'POST', '/api/https-whitelist', {
    hosts: ['*.Example.Test.', '[::1]', ' exact.test ']
  });
  assert.equal(success.statusCode, 200);
  assert.deepEqual(proxy.httpsWhitelist, ['*.Example.Test.', '[::1]', 'exact.test']);
  assert.deepEqual(settings.get('httpsWhitelist'), proxy.httpsWhitelist);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(settings.filePath, 'utf8')).httpsWhitelist,
    proxy.httpsWhitelist
  );

  const clear = await requestJson(port, 'POST', '/api/https-whitelist', { hosts: [] });
  assert.equal(clear.statusCode, 200);
  assert.deepEqual(proxy.httpsWhitelist, []);
  assert.deepEqual(settings.get('httpsWhitelist'), []);
});

test('valid HTTPS whitelist persistence failures restore the exact prior runtime state', async t => {
  const { proxy, settings, port } = await createApiHarness(t);
  proxy.setHttpsWhitelist(['before.test']);
  settings.set('httpsWhitelist', proxy.httpsWhitelist);
  const previous = proxy.httpsWhitelist;
  const beforeBytes = fs.readFileSync(settings.filePath);
  settings._save = () => { throw new Error('disk full'); };

  const response = await requestJson(port, 'POST', '/api/https-whitelist', {
    hosts: ['after.test']
  });

  assert.equal(response.statusCode, 500);
  assert.equal(proxy.httpsWhitelist, previous);
  assert.deepEqual(proxy.httpsWhitelist, ['before.test']);
  assert.equal(proxy._isHttpsWhitelisted('before.test'), true);
  assert.equal(proxy._isHttpsWhitelisted('after.test'), false);
  assert.deepEqual(settings.get('httpsWhitelist'), ['before.test']);
  assert.deepEqual(fs.readFileSync(settings.filePath), beforeBytes);
});

test('startup ignores invalid saved HTTPS whitelists without runtime or persistence changes', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-https-whitelist-startup-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const settings = new Settings(dataDir);
  settings.set('httpsWhitelist', 'persisted-scalar.test');
  const beforeBytes = fs.readFileSync(settings.filePath);
  const proxy = new ProxyServer(null);
  proxy.setHttpsWhitelist(['before.test']);
  const previous = proxy.httpsWhitelist;
  const errors = [];

  assert.equal(
    restoreHttpsWhitelistSetting(proxy, settings, { error: message => errors.push(message) }),
    false
  );
  assert.equal(proxy.httpsWhitelist, previous);
  assert.deepEqual(fs.readFileSync(settings.filePath), beforeBytes);
  assert.match(errors[0], /Ignoring invalid saved HTTPS whitelist/);

  const accessState = { invoked: false };
  for (const candidate of malformedDirectCandidates(accessState).slice(2, 13)) {
    let writes = 0;
    const fakeSettings = {
      get: () => candidate,
      set: () => { writes++; }
    };
    assert.equal(restoreHttpsWhitelistSetting(proxy, fakeSettings, { error() {} }), false);
    assert.equal(proxy.httpsWhitelist, previous);
    assert.equal(writes, 0);
  }
  assert.equal(accessState.invoked, false);

  settings.set('httpsWhitelist', ['*.valid.test', '[::1]']);
  assert.equal(restoreHttpsWhitelistSetting(proxy, settings), true);
  assert.deepEqual(proxy.httpsWhitelist, ['*.valid.test', '[::1]']);
  assert.equal(proxy._isHttpsWhitelisted('api.valid.test'), false);
  assert.equal(proxy._isHttpsWhitelisted('*.valid.test'), true);
  assert.equal(proxy._isHttpsWhitelisted('::1'), true);
});

function requestThroughProxy(proxyPort, targetUrl) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: targetUrl,
      agent: false,
      headers: { connection: 'close' }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
  });
}

test('a rejected malformed update cannot break live whitelisted HTTPS traffic',
  { timeout: 20000 }, async t => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'http-freekit-https-whitelist-live-'));
    const ca = new CertificateAuthority(dataDir);
    await ca.initialize();
    const originCertificate = await ca.generateCertForHost('127.0.0.1');
    const origin = https.createServer({
      key: originCertificate.key,
      cert: originCertificate.cert
    }, (_request, response) => response.end('secure response'));
    origin.listen(0, '127.0.0.1');
    await once(origin, 'listening');

    const proxy = new ProxyServer(ca, { port: 0 });
    proxy.setHttpsWhitelist(['127.0.0.1']);
    const previous = proxy.httpsWhitelist;
    await proxy.start();
    t.after(async () => {
      await proxy.stop();
      await new Promise(resolve => origin.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    });

    const targetUrl = `https://127.0.0.1:${origin.address().port}/secure`;
    assert.equal((await requestThroughProxy(proxy.server.address().port, targetUrl)).statusCode, 200);

    assert.throws(
      () => proxy.setHttpsWhitelist('malformed-scalar.test'),
      error => error?.code === 'ERR_INVALID_HTTPS_WHITELIST'
    );
    assert.equal(proxy.httpsWhitelist, previous);
    assert.equal((await requestThroughProxy(proxy.server.address().port, targetUrl)).body,
      'secure response');

    proxy.httpsWhitelist = { some: 'corrupt direct state' };
    assert.equal((await requestThroughProxy(proxy.server.address().port, targetUrl)).body,
      'secure response');
  });
