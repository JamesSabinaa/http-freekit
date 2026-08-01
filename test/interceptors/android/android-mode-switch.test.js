import assert from 'node:assert/strict';
import test from 'node:test';
import { AndroidAdbInterceptor } from '../../../src/interceptors/android-adb-interceptor.js';

function configuredInterceptor() {
  const interceptor = new AndroidAdbInterceptor();
  interceptor.ca = {
    getCertInfo: () => ({ certificateSpkiFingerprint: 'test-fingerprint' })
  };
  interceptor._getConnectedDevices = async () => [{
    serial: 'device-1',
    status: 'device',
    model: 'Test Device',
    deviceName: 'test'
  }];
  interceptor._getQrMetadata = async () => ({});
  interceptor._prepareHttpToolkitAppActivation = async () => ({
    success: true,
    appInstalled: true,
    connectUrl: 'https://android.httptoolkit.tech/connect/?data=test',
    previousReverseMapping: null
  });
  return interceptor;
}

test('switching Android modes cleans the previous mode before replacement', async () => {
  const interceptor = configuredInterceptor();
  const previous = {
    mode: 'global-proxy',
    previousProxy: 'corporate.proxy:8888',
    proxyPort: 8080
  };
  interceptor.activatedDevices.set('device-1', previous);
  interceptor.active = true;
  const cleanups = [];
  interceptor._cleanupActivatedDevice = async (...args) => {
    cleanups.push(args);
    return true;
  };
  interceptor._activateHttpToolkitApp = async () => ({
    success: true,
    appInstalled: true,
    tunnelActive: true
  });

  const result = await interceptor.activate(9090, {
    deviceId: 'device-1',
    useHttpToolkitApp: true
  });

  assert.equal(result.success, true);
  assert.deepEqual(cleanups, [['device-1', previous]]);
  assert.equal(result.metadata.mode, 'app-uncertain');
  assert.equal(interceptor.activatedDevices.get('device-1').mode, 'app-uncertain');
  assert.equal(interceptor.activatedDevices.get('device-1').proxyPort, 9090);
});

test('failed Android mode cleanup preserves the old activation', async () => {
  const interceptor = configuredInterceptor();
  const previous = { mode: 'global-proxy', previousProxy: 'null', proxyPort: 8080 };
  interceptor.activatedDevices.set('device-1', previous);
  interceptor.active = true;
  interceptor._cleanupActivatedDevice = async () => false;
  interceptor._activateHttpToolkitApp = () => assert.fail('replacement must not start');

  await assert.rejects(
    interceptor.activate(9090, { deviceId: 'device-1', useHttpToolkitApp: true }),
    /Could not clean up the existing Android interception/
  );
  assert.equal(interceptor.activatedDevices.get('device-1'), previous);
  assert.equal(interceptor.active, true);
});
