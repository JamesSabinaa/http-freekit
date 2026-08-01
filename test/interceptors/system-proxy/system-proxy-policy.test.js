import assert from 'node:assert/strict';
import test from 'node:test';
import { SystemProxyInterceptor } from '../../../src/interceptors/system-proxy-interceptor.js';

test('system proxy activation rejects machine-wide proxy policy', async () => {
  const interceptor = new SystemProxyInterceptor({ ca: { systemTrustInstalled: true } });
  interceptor._isWindows = () => true;
  interceptor._usesPerMachineProxyPolicy = () => true;
  interceptor._readCurrentSettings = () => assert.fail('HKCU must not be read under machine policy');
  interceptor._setRegistryValue = () => assert.fail('HKCU must not be changed under machine policy');

  await assert.rejects(
    interceptor.activate(8080),
    /cannot change a machine-wide proxy policy/
  );
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.previousSettings, null);
});

test('per-machine policy detection reads ProxySettingsPerUser', async () => {
  const interceptor = new SystemProxyInterceptor();
  let script;
  interceptor._execPowerShell = value => {
    script = value;
    return '0';
  };

  assert.equal(await interceptor._usesPerMachineProxyPolicy(), true);
  assert.match(script, /ProxySettingsPerUser/);
  assert.match(script, /LocalMachine\.OpenSubKey/);
});
