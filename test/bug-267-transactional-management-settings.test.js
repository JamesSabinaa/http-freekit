import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';
import { Settings } from '../src/settings.js';

function requestJson(port, method, pathname, body = {}) {
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

async function createHarness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-267-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const settings = new Settings(dataDir);
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  api.settings = settings;
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { api, proxy, settings, port: server.address().port };
}

function readSettingsFile(settings) {
  return JSON.parse(fs.readFileSync(settings.filePath, 'utf8'));
}

function failPersistence(settings) {
  const save = settings._save.bind(settings);
  settings._save = () => { throw new Error('disk full'); };
  return () => { settings._save = save; };
}

test('scalar mutations roll back failed persistence and never persist failed applies', async t => {
  const { proxy, settings, port } = await createHarness(t);
  proxy.setHttp2Config('disabled');
  settings.set('http2Enabled', 'disabled');
  const beforeFile = readSettingsFile(settings);

  const restorePersistence = failPersistence(settings);
  const failedSave = await requestJson(port, 'POST', '/api/http2', { mode: 'all' });
  assert.equal(failedSave.statusCode, 500);
  assert.equal(proxy.http2Enabled, 'disabled');
  assert.equal(settings.get('http2Enabled'), 'disabled');
  assert.deepEqual(readSettingsFile(settings), beforeFile);
  restorePersistence();

  const setHttp2Config = proxy.setHttp2Config.bind(proxy);
  proxy.setHttp2Config = mode => {
    if (mode === 'h2-only') {
      proxy.http2Enabled = mode;
      throw new Error('apply failed');
    }
    return setHttp2Config(mode);
  };
  let saves = 0;
  const save = settings._save.bind(settings);
  settings._save = () => { saves++; save(); };
  const failedApply = await requestJson(port, 'POST', '/api/http2', { mode: 'h2-only' });
  assert.equal(failedApply.statusCode, 500);
  assert.equal(proxy.http2Enabled, 'disabled');
  assert.equal(settings.get('http2Enabled'), 'disabled');
  assert.deepEqual(readSettingsFile(settings), beforeFile);
  assert.equal(saves, 0);

  proxy.setHttp2Config = setHttp2Config;
  const success = await requestJson(port, 'POST', '/api/http2', { mode: 'all' });
  assert.equal(success.statusCode, 200);
  assert.equal(proxy.http2Enabled, 'all');
  assert.equal(settings.get('http2Enabled'), 'all');
  assert.equal(readSettingsFile(settings).http2Enabled, 'all');
});

test('list mutations preserve the exact prior collection when persistence fails', async t => {
  const { proxy, settings, port } = await createHarness(t);
  proxy.setTlsPassthrough(['before.test']);
  settings.set('tlsPassthrough', proxy.tlsPassthrough);
  const previousHosts = proxy.tlsPassthrough;
  const beforeFile = readSettingsFile(settings);

  const restorePersistence = failPersistence(settings);
  const failed = await requestJson(port, 'POST', '/api/tls-passthrough/items', {
    host: 'after.test'
  });
  assert.equal(failed.statusCode, 500);
  assert.equal(proxy.tlsPassthrough, previousHosts);
  assert.deepEqual(proxy.tlsPassthrough, ['before.test']);
  assert.deepEqual(settings.get('tlsPassthrough'), ['before.test']);
  assert.deepEqual(readSettingsFile(settings), beforeFile);

  restorePersistence();
  const success = await requestJson(port, 'POST', '/api/tls-passthrough/items', {
    host: 'after.test'
  });
  assert.equal(success.statusCode, 200);
  assert.deepEqual(proxy.tlsPassthrough, ['before.test', 'after.test']);
  assert.deepEqual(settings.get('tlsPassthrough'), proxy.tlsPassthrough);
  assert.deepEqual(readSettingsFile(settings).tlsPassthrough, proxy.tlsPassthrough);
  assert.notEqual(settings.get('tlsPassthrough'), proxy.tlsPassthrough);
});

test('mock mutations restore runtime and settings trees after a failed save', async t => {
  const { proxy, settings, port } = await createHarness(t);
  settings.set('mockRules', [{
    id: 'existing',
    enabled: true,
    priority: 'normal',
    matchers: [{ type: 'method', value: 'GET' }],
    action: { type: 'response', status: 200, body: 'before' }
  }]);
  proxy.loadMockRules(settings.get('mockRules'));
  const previousRules = proxy.mockRules;
  assert.notEqual(settings.get('mockRules'), previousRules);
  assert.notEqual(settings.get('mockRules')[0], previousRules[0]);
  const beforeRules = structuredClone(previousRules);
  const beforeFile = readSettingsFile(settings);

  const restorePersistence = failPersistence(settings);
  const failed = await requestJson(port, 'PATCH', '/api/mock-rules/existing/toggle');
  assert.equal(failed.statusCode, 500);
  assert.equal(proxy.mockRules, previousRules);
  assert.deepEqual(proxy.mockRules, beforeRules);
  assert.deepEqual(settings.get('mockRules'), beforeRules);
  assert.deepEqual(readSettingsFile(settings), beforeFile);

  restorePersistence();
  const success = await requestJson(port, 'PATCH', '/api/mock-rules/existing/toggle');
  assert.equal(success.statusCode, 200);
  assert.equal(proxy.mockRules.length, 1);
  assert.equal(proxy.mockRules[0].enabled, false);
  assert.deepEqual(settings.get('mockRules'), proxy.mockRules);
  assert.deepEqual(readSettingsFile(settings).mockRules, proxy.mockRules);
  assert.notEqual(settings.get('mockRules'), proxy.mockRules);
});

test('multi-setting UI saves and proxy rotation commit in one persistence operation', async t => {
  const { api, proxy, settings, port } = await createHarness(t);
  proxy.filterSafeFonts = false;
  settings.setAll({ hideTunnelRequests: true, filterSafeFonts: false });
  const beforeUiFile = readSettingsFile(settings);

  let restorePersistence = failPersistence(settings);
  const failedUi = await requestJson(port, 'POST', '/api/ui-settings', {
    hideTunnelRequests: false,
    filterSafeFonts: true
  });
  assert.equal(failedUi.statusCode, 500);
  assert.equal(proxy.filterSafeFonts, false);
  assert.equal(settings.get('hideTunnelRequests'), true);
  assert.equal(settings.get('filterSafeFonts'), false);
  assert.deepEqual(readSettingsFile(settings), beforeUiFile);
  restorePersistence();

  proxy.setUpstreamProxy({ host: 'before.test', port: 8080 });
  api.autoRotateProxy = { enabled: true, provider: 'before-provider' };
  settings.setAll({
    upstreamProxy: proxy.upstreamProxy,
    autoRotateProxyOnError: api.autoRotateProxy
  });
  const previousProxy = proxy.upstreamProxy;
  const previousAutoRotate = api.autoRotateProxy;
  const previousGeneration = proxy.getUpstreamProxyGeneration();
  const beforeRotationFile = readSettingsFile(settings);
  api._getBottingToolsProxy = async () => ({
    provider: 'after-provider',
    host: 'after.test',
    port: 9090,
    auth: null,
    type: 'http'
  });

  restorePersistence = failPersistence(settings);
  await assert.rejects(
    api._rotateBottingToolsProxy('after-provider', true, { persistProvider: true }),
    /disk full/
  );
  assert.equal(proxy.upstreamProxy, previousProxy);
  assert.equal(api.autoRotateProxy, previousAutoRotate);
  assert.equal(proxy.getUpstreamProxyGeneration(), previousGeneration);
  assert.deepEqual(settings.get('upstreamProxy'), previousProxy);
  assert.deepEqual(settings.get('autoRotateProxyOnError'), previousAutoRotate);
  assert.deepEqual(readSettingsFile(settings), beforeRotationFile);

  restorePersistence();
  const result = await api._rotateBottingToolsProxy(
    'after-provider',
    true,
    { persistProvider: true }
  );
  assert.equal(result.applied, true);
  assert.equal(proxy.upstreamProxy.host, 'after.test');
  assert.equal(api.autoRotateProxy.provider, 'after-provider');
  assert.equal(settings.get('upstreamProxy').host, 'after.test');
  assert.equal(settings.get('autoRotateProxyOnError').provider, 'after-provider');
  assert.equal(readSettingsFile(settings).upstreamProxy.host, 'after.test');
  assert.equal(readSettingsFile(settings).autoRotateProxyOnError.provider, 'after-provider');
});
