import assert from 'node:assert/strict';
import test from 'node:test';
import { SystemProxyInterceptor } from '../../../src/interceptors/system-proxy-interceptor.js';

test('system proxy Stop preserves settings changed by another application', async () => {
  const interceptor = new SystemProxyInterceptor();
  interceptor._isWindows = () => true;
  interceptor.active = true;
  interceptor.previousSettings = { enabled: true, server: 'old.proxy:8080' };
  interceptor.activeProxyServer = '127.0.0.1:45457';
  interceptor._readCurrentSettings = () => ({ enabled: true, server: 'vpn.proxy:3128', override: '' });
  interceptor._setRegistryValue = () => assert.fail('newer proxy settings must not be overwritten');

  await interceptor.deactivate();

  assert.equal(interceptor.active, false);
  assert.equal(interceptor.previousSettings, null);
  assert.equal(interceptor.activeProxyServer, null);
});

test('system proxy Stop restores saved settings while FreeKit still owns them', async () => {
  const interceptor = new SystemProxyInterceptor();
  interceptor._isWindows = () => true;
  interceptor.active = true;
  interceptor.previousSettings = { enabled: true, server: 'old.proxy:8080' };
  interceptor.activeProxyServer = '127.0.0.1:45457';
  interceptor._readCurrentSettings = () => ({ enabled: true, server: '127.0.0.1:45457', override: '' });
  const writes = [];
  interceptor._setRegistryValue = (...args) => writes.push(args);
  interceptor._notifyWinInet = () => {};

  await interceptor.deactivate();

  assert.deepEqual(writes, [
    ['ProxyServer', 'REG_SZ', 'old.proxy:8080'],
    ['ProxyEnable', 'REG_DWORD', 1]
  ]);
  assert.equal(interceptor.active, false);
});
