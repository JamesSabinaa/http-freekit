import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';
import { Settings } from '../../src/settings.js';

function requestJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: payload === null ? undefined : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: response.statusCode,
          body: text ? JSON.parse(text) : null
        });
      });
    });
    request.once('error', reject);
    request.end(payload || undefined);
  });
}

async function createHarness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-input-validation-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const proxy = new ProxyServer(null);
  const settings = new Settings(dataDir);
  const api = new ApiServer(proxy);
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

test('required management request bodies reject missing and non-object JSON', async t => {
  const { api, proxy, settings, port } = await createHarness(t);
  proxy.mockRules = [{
    id: 'existing',
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }],
    action: { type: 'fixed-response', status: 200, body: 'unchanged' }
  }];
  proxy.setHttp2Config('h2-only');
  proxy.minPort = 18000;
  proxy.maxPort = 18010;
  settings.setAll({
    mockRules: proxy.mockRules,
    http2Enabled: proxy.http2Enabled,
    proxyPortRange: { minPort: proxy.minPort, maxPort: proxy.maxPort }
  });
  const before = {
    rules: structuredClone(proxy.mockRules),
    http2: proxy.http2Enabled,
    minPort: proxy.minPort,
    maxPort: proxy.maxPort,
    settings: settings.getAll()
  };
  const routes = [
    '/api/mock-rules/reorder',
    '/api/mock-rules/group',
    '/api/mock-rules/move-to-group',
    '/api/mock-rules/ungroup',
    '/api/http2',
    '/api/port-config'
  ];

  for (const route of routes) {
    for (const body of [undefined, []]) {
      const response = await requestJson(port, route, body);
      assert.deepEqual(response, {
        statusCode: 400,
        body: { error: 'request body must be a JSON object' }
      }, `${route} with ${body === undefined ? 'no body' : 'an array body'}`);
    }
  }

  assert.deepEqual(proxy.mockRules, before.rules);
  assert.equal(proxy.http2Enabled, before.http2);
  assert.equal(proxy.minPort, before.minPort);
  assert.equal(proxy.maxPort, before.maxPort);
  assert.deepEqual(settings.getAll(), before.settings);
  assert.equal(api.autoRotateProxy.enabled, false);
});

test('management boolean fields reject coercible values without mutation', async t => {
  const { api, proxy, settings, port } = await createHarness(t);
  settings.setAll({ hideTunnelRequests: false, filterSafeFonts: true });
  proxy.filterSafeFonts = true;
  api.autoRotateProxy = { enabled: true, provider: 'before-provider' };
  settings.set('autoRotateProxyOnError', api.autoRotateProxy);
  const beforeSettings = settings.getAll();
  const beforeAutoRotate = api.autoRotateProxy;
  let rotateCalls = 0;
  api._rotateBottingToolsProxy = async () => { rotateCalls++; };

  for (const [field, value] of [
    ['hideTunnelRequests', 'false'],
    ['filterSafeFonts', 1]
  ]) {
    const invalidUi = await requestJson(port, '/api/ui-settings', { [field]: value });
    assert.equal(invalidUi.statusCode, 400, field);
    assert.match(invalidUi.body.error, new RegExp(`${field} must be a boolean`), field);
  }

  const invalidAutoRotate = await requestJson(port, '/api/bottingtools/auto-rotate-proxy', {
    enabled: 'false',
    provider: 'after-provider'
  });
  assert.equal(invalidAutoRotate.statusCode, 400);
  assert.match(invalidAutoRotate.body.error, /enabled must be a boolean/);

  const invalidManualRotate = await requestJson(port, '/api/bottingtools/rotate-proxy', {
    refill: 'false'
  });
  assert.equal(invalidManualRotate.statusCode, 400);
  assert.match(invalidManualRotate.body.error, /refill must be a boolean/);

  assert.equal(proxy.filterSafeFonts, true);
  assert.equal(api.autoRotateProxy, beforeAutoRotate);
  assert.equal(rotateCalls, 0);
  assert.deepEqual(settings.getAll(), beforeSettings);
});
