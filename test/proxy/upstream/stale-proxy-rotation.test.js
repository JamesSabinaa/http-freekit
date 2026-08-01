import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiServer } from '../../../src/api/api-server.js';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

test('a delayed rotation cannot overwrite a newer manual proxy', async () => {
  const proxy = new ProxyServer(null);
  proxy.setUpstreamProxy({ host: 'old.test', port: 8080 });
  const api = new ApiServer(proxy, null, null);
  const persisted = [];
  api.settings = { set: (...args) => persisted.push(args) };

  let finishLookup;
  api._getBottingToolsProxy = () => new Promise(resolve => { finishLookup = resolve; });
  const rotation = api._rotateBottingToolsProxy('provider', true);

  proxy.setUpstreamProxy({ host: 'manual.test', port: 9090, noProxy: ['local.test'] });
  const manualGeneration = proxy.getUpstreamProxyGeneration();
  finishLookup({
    provider: 'provider',
    host: 'rotated.test',
    port: 8181,
    auth: null,
    type: 'http'
  });

  const result = await rotation;
  assert.equal(result.applied, false);
  assert.equal(proxy.upstreamProxy.host, 'manual.test');
  assert.equal(proxy.upstreamProxy.port, 9090);
  assert.deepEqual(proxy.upstreamProxy.noProxy, ['local.test']);
  assert.equal(proxy.getUpstreamProxyGeneration(), manualGeneration);
  assert.deepEqual(persisted, []);
});

test('an uncontested rotation is still applied and persisted', async () => {
  const proxy = new ProxyServer(null);
  proxy.setUpstreamProxy({ host: 'old.test', port: 8080, noProxy: ['local.test'] });
  const api = new ApiServer(proxy, null, null);
  const persisted = [];
  api.settings = { set: (...args) => persisted.push(args) };
  api._getBottingToolsProxy = async () => ({
    provider: 'provider',
    host: 'rotated.test',
    port: 8181,
    auth: 'user:pass',
    type: 'http'
  });

  const result = await api._rotateBottingToolsProxy('provider', true);

  assert.equal(result.applied, true);
  assert.equal(proxy.upstreamProxy.host, 'rotated.test');
  assert.deepEqual(proxy.upstreamProxy.noProxy, ['local.test']);
  assert.deepEqual(persisted, [['upstreamProxy', proxy.upstreamProxy]]);
});
