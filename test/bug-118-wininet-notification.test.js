import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SystemProxyInterceptor } from '../src/interceptors/system-proxy-interceptor.js';

function createDurableNotificationRetry(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-wininet-retry-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
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
  const recovery = {
    owner: {
      pid: 9876,
      startedAt: '2026-01-02T03:04:05.000Z',
      executablePath: 'c:\\program files\\http freekit\\freekit.exe'
    },
    proxyServer: settings.server,
    ownedSettings: { ...settings },
    previousSettings
  };
  const interceptor = new SystemProxyInterceptor({ dataDir });
  interceptor.previousSettings = previousSettings;
  interceptor.pendingRecovery = recovery;
  interceptor._persistRecoveryState(recovery);
  interceptor._setRegistryValue = (name, type, value) => {
    if (name === 'ProxyEnable') settings.enabled = Boolean(value);
    if (name === 'ProxyServer') settings.server = value;
    if (name === 'ProxyOverride') settings.override = value;
  };
  interceptor._notifyWinInet = () => { throw new Error('WinINet refresh failed'); };

  assert.throws(() => interceptor._restorePreviousSettings(), /WinINet refresh failed/);
  assert.deepEqual(settings, previousSettings);
  assert.equal(interceptor.restoreNotificationPending, true);
  assert.equal(
    JSON.parse(fs.readFileSync(interceptor.recoveryFile, 'utf8')).restorePhase,
    'notification-pending'
  );
  return { dataDir, previousSettings, settings };
}

test('system proxy activation and restoration notify WinINet clients', async () => {
  const interceptor = new SystemProxyInterceptor({ ca: { systemTrustInstalled: true } });
  interceptor._isWindows = () => true;
  interceptor._usesPerMachineProxyPolicy = () => false;
  interceptor._processIdentityLookup = () => ({
    pid: process.pid,
    startedAt: '2026-01-02T03:04:05.000Z',
    executablePath: 'C:\\Program Files\\HTTP FreeKit\\freekit.exe'
  });
  interceptor._readCurrentSettings = () => ({ enabled: false, server: null, override: null });
  interceptor._persistRecoveryState = () => {};
  interceptor._removeRecoveryState = () => {};
  interceptor._setRegistryValue = () => {};
  let notifications = 0;
  interceptor._notifyWinInet = () => { notifications += 1; };

  await interceptor.activate(8080);
  assert.equal(notifications, 1);

  interceptor._readCurrentSettings = () => ({ enabled: true, server: '127.0.0.1:8080', override: '' });
  interceptor._execRegistry = () => '';
  await interceptor.deactivate();
  assert.equal(notifications, 2);
});

test('WinINet notification sends settings-changed and refresh flags', () => {
  const interceptor = new SystemProxyInterceptor();
  let script;
  interceptor._execPowerShell = value => { script = value; };

  interceptor._notifyWinInet();

  assert.match(script, /InternetSetOption\(\[IntPtr\]::Zero, 39,/);
  assert.match(script, /InternetSetOption\(\[IntPtr\]::Zero, 37,/);
});

test('a failed restoration notification remains retryable on the next Stop', async () => {
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
  interceptor._setRegistryValue = (name, type, value) => {
    if (name === 'ProxyEnable') settings.enabled = Boolean(value);
    if (name === 'ProxyServer') settings.server = value;
    if (name === 'ProxyOverride') settings.override = value;
  };
  let notificationAttempts = 0;
  interceptor._notifyWinInet = () => {
    notificationAttempts++;
    if (notificationAttempts === 1) throw new Error('WinINet refresh failed');
  };
  interceptor._removeRecoveryState = () => {};

  await assert.rejects(
    interceptor.deactivate(),
    /Failed to restore system proxy settings: WinINet refresh failed/
  );
  assert.deepEqual(settings, previousSettings);
  assert.equal(interceptor.restorePending, true);
  assert.equal(interceptor.restoreNotificationPending, true);
  assert.equal(interceptor.active, true);
  assert.equal(await interceptor.needsDeactivation(), true);

  await interceptor.deactivate();

  assert.equal(notificationAttempts, 2);
  assert.deepEqual(settings, previousSettings);
  assert.equal(interceptor.restorePending, false);
  assert.equal(interceptor.restoreNotificationPending, false);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.previousSettings, null);
  assert.equal(interceptor.pendingRecovery, null);
});

test('a notification retry preserves an external change made after registry restoration', async () => {
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
  let registryWrites = 0;
  interceptor._setRegistryValue = (name, type, value) => {
    registryWrites++;
    if (name === 'ProxyEnable') settings.enabled = Boolean(value);
    if (name === 'ProxyServer') settings.server = value;
    if (name === 'ProxyOverride') settings.override = value;
  };
  let notificationAttempts = 0;
  interceptor._notifyWinInet = () => {
    notificationAttempts++;
    throw new Error('WinINet refresh failed');
  };
  interceptor._removeRecoveryState = () => {};

  await assert.rejects(interceptor.deactivate(), /WinINet refresh failed/);
  assert.equal(interceptor.restoreNotificationPending, true);

  // The user deliberately re-enables the restored corporate proxy before
  // retrying Stop. This is newer external state, not a partial FreeKit write.
  settings.enabled = true;
  const writesBeforeRetry = registryWrites;
  await interceptor.deactivate();

  assert.deepEqual(settings, {
    enabled: true,
    server: 'corporate.proxy:8888',
    override: '<local>'
  });
  assert.equal(registryWrites, writesBeforeRetry);
  assert.equal(notificationAttempts, 1);
  assert.equal(interceptor.restoreNotificationPending, false);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.previousSettings, null);
  assert.equal(interceptor.pendingRecovery, null);
});

test('Start is rejected while a prior notification retry still owns cleanup', async () => {
  const interceptor = new SystemProxyInterceptor({ ca: { systemTrustInstalled: true } });
  interceptor._isWindows = () => true;
  interceptor.previousSettings = { enabled: false, server: null, override: null };
  interceptor.pendingRecovery = {
    proxyServer: '127.0.0.1:8080',
    previousSettings: interceptor.previousSettings
  };
  interceptor.restorePending = true;
  interceptor.restoreNotificationPending = true;
  interceptor._usesPerMachineProxyPolicy = () => assert.fail('activation must stop before policy access');

  await assert.rejects(interceptor.activate(8080), /retry Stop before starting it again/);
  assert.equal(interceptor.restoreNotificationPending, true);
  assert.deepEqual(interceptor.previousSettings, {
    enabled: false,
    server: null,
    override: null
  });
});

test('notification-pending recovery survives restart and republishes exact restored settings', t => {
  const { dataDir, previousSettings, settings } = createDurableNotificationRetry(t);
  const restarted = new SystemProxyInterceptor({ dataDir });
  restarted._isWindows = () => true;
  restarted._recoveryOwnerIsActive = () => false;
  restarted._readCurrentSettings = () => ({ ...settings });
  restarted._setRegistryValue = (name, type, value) => {
    if (name === 'ProxyEnable') settings.enabled = Boolean(value);
    if (name === 'ProxyServer') settings.server = value;
    if (name === 'ProxyOverride') settings.override = value;
  };
  let notifications = 0;
  restarted._notifyWinInet = () => { notifications += 1; };

  assert.equal(restarted.recoverStaleSettings(), true);
  assert.equal(notifications, 1);
  assert.deepEqual(settings, previousSettings);
  assert.equal(fs.existsSync(restarted.recoveryFile), false);
  assert.equal(restarted.restoreNotificationPending, false);
});

test('notification-pending recovery preserves an external change across restart', t => {
  const { dataDir, settings } = createDurableNotificationRetry(t);
  settings.enabled = true;
  const restarted = new SystemProxyInterceptor({ dataDir });
  restarted._isWindows = () => true;
  restarted._recoveryOwnerIsActive = () => false;
  restarted._readCurrentSettings = () => ({ ...settings });
  let registryWrites = 0;
  restarted._setRegistryValue = () => { registryWrites += 1; };
  let notifications = 0;
  restarted._notifyWinInet = () => { notifications += 1; };

  assert.equal(restarted.recoverStaleSettings(), false);
  assert.deepEqual(settings, {
    enabled: true,
    server: 'corporate.proxy:8888',
    override: '<local>'
  });
  assert.equal(registryWrites, 0);
  assert.equal(notifications, 0);
  assert.equal(fs.existsSync(restarted.recoveryFile), false);
});
