import assert from 'node:assert/strict';
import test from 'node:test';
import { SystemProxyInterceptor } from '../src/interceptors/system-proxy-interceptor.js';

test('system-proxy deactivation reports restore failures and remains active', async () => {
  const interceptor = new SystemProxyInterceptor();
  interceptor._isWindows = () => true;
  interceptor.active = true;
  interceptor.previousSettings = { enabled: true, server: 'corporate.proxy:8888', override: '<local>' };
  interceptor.activeProxyServer = '127.0.0.1:8080';
  interceptor._readCurrentSettings = () => ({ enabled: true, server: '127.0.0.1:8080', override: '' });
  interceptor._restorePreviousSettings = () => {
    throw new Error('registry access denied');
  };

  await assert.rejects(
    interceptor.deactivate(),
    /Failed to restore system proxy settings: registry access denied/
  );
  assert.equal(interceptor.active, true);
  assert.deepEqual(interceptor.previousSettings, {
    enabled: true,
    server: 'corporate.proxy:8888',
    override: '<local>'
  });
});

test('partial registry restore retains the saved settings for retry', async () => {
  const interceptor = new SystemProxyInterceptor();
  interceptor.previousSettings = { enabled: true, server: 'corporate.proxy:8888' };
  let calls = 0;
  interceptor._setRegistryValue = () => {
    calls += 1;
    if (calls === 2) throw new Error('ProxyEnable write failed');
  };

  await assert.rejects(interceptor._restorePreviousSettings(), /ProxyEnable write failed/);
  assert.deepEqual(interceptor.previousSettings, {
    enabled: true,
    server: 'corporate.proxy:8888'
  });
});

test('failure to delete an originally absent proxy server remains retryable', async () => {
  const interceptor = new SystemProxyInterceptor();
  interceptor.previousSettings = { enabled: false, server: null, override: null };
  interceptor.activeProxyServer = '127.0.0.1:8080';
  interceptor.pendingRecovery = { previousSettings: interceptor.previousSettings };
  interceptor._execRegistry = () => { throw new Error('ProxyServer delete failed'); };
  interceptor._readCurrentSettings = () => ({
    enabled: true,
    server: '127.0.0.1:8080',
    override: ''
  });
  interceptor._setRegistryValue = () => assert.fail('restore must stop after deletion fails');

  await assert.rejects(
    interceptor._restorePreviousSettings(),
    /ProxyServer delete failed/
  );
  assert.deepEqual(interceptor.previousSettings, {
    enabled: false,
    server: null,
    override: null
  });
  assert.equal(interceptor.activeProxyServer, '127.0.0.1:8080');
  assert.ok(interceptor.pendingRecovery);
});

test('a second Stop completes a partially applied system-proxy restore', async () => {
  const previousSettings = { enabled: false, server: null, override: null };
  const settings = { enabled: true, server: '127.0.0.1:8080', override: '' };
  const interceptor = new SystemProxyInterceptor();
  interceptor._isWindows = () => true;
  interceptor.active = true;
  interceptor.previousSettings = previousSettings;
  interceptor.activeProxyServer = settings.server;
  interceptor.pendingRecovery = {
    proxyServer: settings.server,
    ownedSettings: { ...settings },
    previousSettings
  };
  interceptor._readCurrentSettings = () => ({ ...settings });
  interceptor._setRegistryValue = (name, type, value) => {
    if (name === 'ProxyEnable') settings.enabled = Boolean(value);
    else if (name === 'ProxyServer') settings.server = value;
    else if (name === 'ProxyOverride') settings.override = value;
  };
  let overrideDeleteFails = true;
  interceptor._deleteRegistryValue = name => {
    if (name === 'ProxyOverride' && overrideDeleteFails) {
      overrideDeleteFails = false;
      throw new Error('ProxyOverride delete failed');
    }
    if (name === 'ProxyServer') settings.server = null;
    if (name === 'ProxyOverride') settings.override = null;
  };
  interceptor._notifyWinInet = () => {};

  await assert.rejects(
    interceptor.deactivate(),
    /ProxyOverride delete failed/
  );
  assert.deepEqual(settings, {
    enabled: true,
    server: null,
    override: ''
  });
  assert.equal(interceptor.active, true);
  assert.equal(interceptor.restorePending, true);
  assert.ok(interceptor.pendingRecovery);

  await interceptor.deactivate();

  assert.deepEqual(settings, previousSettings);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.restorePending, false);
  assert.equal(interceptor.previousSettings, null);
  assert.equal(interceptor.pendingRecovery, null);
});

test('a Stop retry preserves a mixed external change that is not a restore prefix', async () => {
  const previousSettings = {
    enabled: false,
    server: 'corporate.proxy:8888',
    override: '<local>'
  };
  const settings = {
    enabled: true,
    server: '127.0.0.1:8080',
    override: ''
  };
  const interceptor = new SystemProxyInterceptor();
  interceptor._isWindows = () => true;
  interceptor.active = true;
  interceptor.previousSettings = previousSettings;
  interceptor.activeProxyServer = settings.server;
  interceptor.pendingRecovery = {
    proxyServer: settings.server,
    ownedSettings: { ...settings },
    previousSettings
  };
  interceptor._readCurrentSettings = () => ({ ...settings });
  let serverWriteFails = true;
  let writes = 0;
  interceptor._setRegistryValue = name => {
    writes++;
    if (name === 'ProxyServer' && serverWriteFails) {
      serverWriteFails = false;
      throw new Error('ProxyServer write failed');
    }
  };
  interceptor._removeRecoveryState = () => {};

  await assert.rejects(interceptor.deactivate(), /ProxyServer write failed/);
  assert.equal(interceptor.restorePending, true);

  settings.override = previousSettings.override;
  const writesBeforeRetry = writes;
  await interceptor.deactivate();

  assert.deepEqual(settings, {
    enabled: true,
    server: '127.0.0.1:8080',
    override: '<local>'
  });
  assert.equal(writes, writesBeforeRetry);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.previousSettings, null);
  assert.equal(interceptor.pendingRecovery, null);
  assert.equal(interceptor.restorePending, false);
});
