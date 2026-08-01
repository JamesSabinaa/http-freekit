import assert from 'node:assert/strict';
import test from 'node:test';
import { AndroidAdbInterceptor } from '../../../src/interceptors/android-adb-interceptor.js';

function failedProxyInterceptor() {
  const interceptor = new AndroidAdbInterceptor();
  interceptor._getConnectedDevices = async () => [{
    serial: 'device-1',
    status: 'device',
    model: 'Test Device',
    deviceName: 'test'
  }];
  interceptor._getHostIp = async () => '192.0.2.10';
  interceptor._getProxy = async () => ({ success: true, value: 'null' });
  interceptor._pushCaCert = async () => '/data/local/tmp/http-freekit-ca.pem';
  interceptor._setProxy = async () => false;
  return interceptor;
}

test('failed Android proxy setup removes the staged CA immediately', async () => {
  const interceptor = failedProxyInterceptor();
  let removals = 0;
  interceptor._removeCaCert = async () => {
    removals += 1;
    return true;
  };

  const result = await interceptor.activate(8080, {
    deviceId: 'device-1',
    useHttpToolkitApp: false
  });

  assert.equal(result.success, false);
  assert.equal(removals, 1);
  assert.equal(interceptor.activatedDevices.size, 0);
  assert.equal(interceptor.active, false);
});

test('failed staged-CA rollback remains tracked for Stop retry', async () => {
  const interceptor = failedProxyInterceptor();
  let removalSucceeds = false;
  interceptor._removeCaCert = async () => removalSucceeds;

  const result = await interceptor.activate(8080, {
    deviceId: 'device-1',
    useHttpToolkitApp: false
  });

  assert.equal(result.success, false);
  assert.match(result.error, /retry Stop/);
  assert.equal(interceptor.activatedDevices.get('device-1').mode, 'staging-cleanup');
  assert.equal(interceptor.active, true);

  removalSucceeds = true;
  await interceptor.deactivate({ deviceId: 'device-1' });
  assert.equal(interceptor.activatedDevices.size, 0);
  assert.equal(interceptor.active, false);
});
