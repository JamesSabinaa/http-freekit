import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InterceptorManager } from '../src/interceptors/interceptor-manager.js';
import { SystemProxyInterceptor } from '../src/interceptors/system-proxy-interceptor.js';

function createDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-232-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function createManager(interceptor) {
  const manager = Object.create(InterceptorManager.prototype);
  manager.interceptors = new Map([[interceptor.id, interceptor]]);
  manager.operationsInProgress = new Map();
  manager.statusOperations = new Map();
  manager.onStatusChange = null;
  return manager;
}

function configureWindowsInterceptor(interceptor, settings, proxyServerFailures) {
  interceptor._isWindows = () => true;
  interceptor._usesPerMachineProxyPolicy = () => false;
  interceptor._readCurrentSettings = () => ({ ...settings });
  interceptor._notifyWinInet = () => {};
  interceptor._setRegistryValue = (name, type, value) => {
    if (name === 'ProxyServer' && proxyServerFailures.remaining > 0) {
      proxyServerFailures.remaining--;
      throw new Error('ProxyServer write failed');
    }
    if (name === 'ProxyEnable') settings.enabled = Boolean(value);
    if (name === 'ProxyServer') settings.server = value;
    if (name === 'ProxyOverride') settings.override = value;
  };
}

test('graceful shutdown retries partial System Proxy activation cleanup until it succeeds', async t => {
  const settings = {
    enabled: false,
    server: 'corporate.proxy:8888',
    override: 'intranet.example;<local>'
  };
  const failures = { remaining: 2 };
  const interceptor = new SystemProxyInterceptor({ dataDir: createDataDir(t) });
  configureWindowsInterceptor(interceptor, settings, failures);
  const setRegistryValue = interceptor._setRegistryValue;
  let enableWrites = 0;
  interceptor._setRegistryValue = (name, ...args) => {
    if (name === 'ProxyEnable' && ++enableWrites === 2) {
      throw new Error('ProxyEnable restore failed');
    }
    setRegistryValue(name, ...args);
  };

  await assert.rejects(interceptor.activate(8080), /ProxyServer write failed/);

  assert.equal(await interceptor.isActive(), false);
  assert.equal(interceptor.toJSON().active, false);
  assert.equal(await interceptor.needsDeactivation(), true);
  assert.deepEqual(settings, {
    enabled: true,
    server: 'corporate.proxy:8888',
    override: 'intranet.example;<local>'
  });
  assert.equal(fs.existsSync(interceptor.recoveryFile), true);

  const manager = createManager(interceptor);
  await manager.deactivateAll();

  assert.equal(await interceptor.needsDeactivation(), true);
  assert.equal(fs.existsSync(interceptor.recoveryFile), true);

  await manager.deactivateAll();

  assert.deepEqual(settings, {
    enabled: false,
    server: 'corporate.proxy:8888',
    override: 'intranet.example;<local>'
  });
  assert.equal(await interceptor.needsDeactivation(), false);
  assert.equal(interceptor.pendingRecovery, null);
  assert.equal(interceptor.previousSettings, null);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});

test('successful immediate rollback clears partial activation ownership', async t => {
  const settings = { enabled: false, server: 'old.proxy:8080', override: null };
  const failures = { remaining: 1 };
  const interceptor = new SystemProxyInterceptor({ dataDir: createDataDir(t) });
  configureWindowsInterceptor(interceptor, settings, failures);
  interceptor._deleteRegistryValue = name => {
    assert.equal(name, 'ProxyOverride');
    settings.override = null;
  };

  await assert.rejects(interceptor.activate(8080), /ProxyServer write failed/);

  assert.deepEqual(settings, { enabled: false, server: 'old.proxy:8080', override: null });
  assert.equal(await interceptor.needsDeactivation(), false);
  assert.equal(interceptor.pendingRecovery, null);
  assert.equal(interceptor.previousSettings, null);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});

test('graceful cleanup preserves an external change after partial activation', async t => {
  const settings = { enabled: false, server: 'old.proxy:8080', override: null };
  const failures = { remaining: 2 };
  let successfulWrites = 0;
  const interceptor = new SystemProxyInterceptor({ dataDir: createDataDir(t) });
  configureWindowsInterceptor(interceptor, settings, failures);
  const setRegistryValue = interceptor._setRegistryValue;
  interceptor._setRegistryValue = (...args) => {
    const failuresBefore = failures.remaining;
    try {
      setRegistryValue(...args);
    } finally {
      if (failures.remaining === failuresBefore) successfulWrites++;
    }
  };

  await assert.rejects(interceptor.activate(8080), /ProxyServer write failed/);
  assert.equal(await interceptor.needsDeactivation(), true);

  settings.server = 'vpn.proxy:3128';
  const writesBeforeCleanup = successfulWrites;
  await createManager(interceptor).deactivateAll();

  assert.deepEqual(settings, { enabled: true, server: 'vpn.proxy:3128', override: null });
  assert.equal(successfulWrites, writesBeforeCleanup);
  assert.equal(await interceptor.needsDeactivation(), false);
  assert.equal(interceptor.pendingRecovery, null);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});
