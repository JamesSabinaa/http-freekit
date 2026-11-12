import assert from 'node:assert/strict';
import test from 'node:test';
import { AndroidAdbInterceptor } from '../../../src/interceptors/android-adb-interceptor.js';

test('missing optional ADB stays quiet without deleting cleanup ownership', async t => {
  const interceptor = new AndroidAdbInterceptor();
  const errors = t.mock.method(console, 'error', () => {});
  const owned = { serial: 'device-1', mode: 'proxy-uncertain' };
  interceptor.activatedDevices.set('device-1', owned);
  interceptor._runDeviceListCommand = async () => {
    throw Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' });
  };
  assert.deepEqual(await interceptor._getConnectedDevices(), []);
  assert.deepEqual(await interceptor._getConnectedDevices(), []);
  assert.equal(interceptor.activatedDevices.get('device-1'), owned);
  assert.equal(errors.mock.callCount(), 0);
});

test('ADB failures remain visible once per failure and report again after recovery', async t => {
  const interceptor = new AndroidAdbInterceptor();
  const errors = t.mock.method(console, 'error', () => {});
  let failing = true;
  interceptor._runDeviceListCommand = async () => {
    if (failing) throw Object.assign(new Error('device discovery timeout'), { code: 'ETIMEDOUT' });
    return 'List of devices attached\ndevice-1 device model:Pixel_6 device:oriole\n';
  };
  await interceptor._getConnectedDevices();
  await interceptor._getConnectedDevices();
  assert.equal(errors.mock.callCount(), 1);
  failing = false;
  assert.deepEqual(await interceptor._getConnectedDevices(), [
    { serial: 'device-1', status: 'device', model: 'Pixel 6', deviceName: 'oriole' }
  ]);
  failing = true;
  await interceptor._getConnectedDevices();
  assert.equal(errors.mock.callCount(), 2);
});
