import assert from 'node:assert/strict';
import test from 'node:test';
import { SystemProxyInterceptor } from '../src/interceptors/system-proxy-interceptor.js';

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
