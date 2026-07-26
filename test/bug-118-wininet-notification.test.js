import assert from 'node:assert/strict';
import test from 'node:test';
import { SystemProxyInterceptor } from '../src/interceptors/system-proxy-interceptor.js';

test('system proxy activation and restoration notify WinINet clients', async () => {
  const interceptor = new SystemProxyInterceptor({ ca: { systemTrustInstalled: true } });
  interceptor._isWindows = () => true;
  interceptor._usesPerMachineProxyPolicy = () => false;
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
