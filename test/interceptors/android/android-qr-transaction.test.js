import assert from 'node:assert/strict';
import test from 'node:test';

import { AndroidAdbInterceptor } from '../../../src/interceptors/android-adb-interceptor.js';

const device = {
  serial: 'device-1',
  status: 'device',
  model: 'Test Device',
  deviceName: 'test-device'
};

function interceptorWithDevice() {
  const interceptor = new AndroidAdbInterceptor();
  interceptor._getConnectedDevices = async () => [device];
  return interceptor;
}

test('QR failure leaves a new Android activation entirely unmodified', async () => {
  const interceptor = interceptorWithDevice();
  let deviceProxy = 'corporate.proxy:8888';
  let mutationCalls = 0;
  interceptor._getQrMetadata = async () => { throw new Error('QR generation failed'); };
  interceptor._getHostIp = async () => {
    mutationCalls++;
    return '192.0.2.10';
  };
  interceptor._getProxy = async () => ({ success: true, value: deviceProxy });
  interceptor._pushCaCert = async () => {
    mutationCalls++;
    return '/data/local/tmp/http-freekit-ca.pem';
  };
  interceptor._setProxy = async () => {
    mutationCalls++;
    deviceProxy = '192.0.2.10:8080';
    return true;
  };

  await assert.rejects(
    interceptor.activate(8080, { deviceId: 'device-1', useHttpToolkitApp: false }),
    /QR generation failed/
  );

  assert.equal(mutationCalls, 0);
  assert.equal(deviceProxy, 'corporate.proxy:8888');
  assert.equal(interceptor.activatedDevices.size, 0);
  assert.equal(interceptor.active, false);
});

test('QR failure preserves an existing Android activation and its cleanup ownership', async () => {
  const interceptor = interceptorWithDevice();
  const previousActivation = {
    mode: 'global-proxy',
    previousProxy: 'corporate.proxy:8888',
    proxyPort: 8080,
    hostIp: '192.0.2.10'
  };
  interceptor.activatedDevices.set('device-1', previousActivation);
  interceptor.active = true;
  let deviceProxy = '192.0.2.10:8080';
  let cleanupCalls = 0;
  interceptor._getQrMetadata = async () => { throw new Error('QR generation failed'); };
  interceptor._cleanupActivatedDevice = async () => {
    cleanupCalls++;
    deviceProxy = previousActivation.previousProxy;
    return true;
  };
  interceptor._activateHttpToolkitApp = async () => {
    assert.fail('replacement activation must not start after QR failure');
  };

  await assert.rejects(
    interceptor.activate(9090, { deviceId: 'device-1', useHttpToolkitApp: true }),
    /QR generation failed/
  );

  assert.equal(cleanupCalls, 0);
  assert.equal(deviceProxy, '192.0.2.10:8080');
  assert.equal(interceptor.activatedDevices.get('device-1'), previousActivation);
  assert.equal(interceptor.active, true);
});

test('successful activation performs no response-only device discovery after commit', async () => {
  const interceptor = new AndroidAdbInterceptor();
  let deviceDiscoveryCalls = 0;
  interceptor._getConnectedDevices = async () => {
    deviceDiscoveryCalls++;
    if (deviceDiscoveryCalls > 1) throw new Error('late response metadata failed');
    return [device];
  };
  interceptor._getQrMetadata = async () => ({
    qrAvailable: true,
    qrImageDataUrl: 'data:image/png;base64,test'
  });
  interceptor._getHostIp = async () => '192.0.2.10';
  interceptor._getProxy = async () => ({ success: true, value: 'null' });
  interceptor._pushCaCert = async () => null;
  interceptor._setProxy = async () => true;

  const result = await interceptor.activate(8080, {
    deviceId: 'device-1',
    useHttpToolkitApp: false
  });

  assert.equal(result.success, true);
  assert.equal(deviceDiscoveryCalls, 1);
  assert.deepEqual(result.metadata.devices, [device]);
  assert.equal(result.metadata.qrImageDataUrl, 'data:image/png;base64,test');
  assert.equal(interceptor.activatedDevices.has('device-1'), true);
  assert.equal(interceptor.active, true);
});
