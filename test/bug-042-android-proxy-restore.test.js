import assert from 'node:assert/strict';
import test from 'node:test';
import { AndroidAdbInterceptor } from '../src/interceptors/android-adb-interceptor.js';

test('Android fallback restores the proxy that existed before activation', async () => {
  const interceptor = new AndroidAdbInterceptor();
  const adbCalls = [];
  interceptor._getConnectedDevices = () => [{
    serial: 'device-1',
    status: 'device',
    model: 'Test Device',
    deviceName: 'test'
  }];
  interceptor._getHostIp = () => '192.0.2.10';
  interceptor._getQrMetadata = async () => ({});
  interceptor._pushCaCert = () => '/data/local/tmp/http-freekit-ca.pem';
  interceptor._removeCaCert = () => true;
  let deviceProxy = 'corporate.proxy:8888';
  interceptor._adb = (_deviceId, args) => {
    adbCalls.push(args);
    if (args[2] === 'get') return `${deviceProxy}\n`;
    if (args[2] === 'put') deviceProxy = args[5];
    if (args[2] === 'delete') deviceProxy = 'null';
    return '';
  };

  const activation = await interceptor.activate(8080, {
    deviceId: 'device-1',
    useHttpToolkitApp: false
  });

  assert.equal(activation.success, true);
  assert.equal(interceptor.activatedDevices.get('device-1').previousProxy, 'corporate.proxy:8888');
  assert.ok(adbCalls.some(args => args.join(' ') === 'shell settings put global http_proxy 192.0.2.10:8080'));

  await interceptor.deactivate({ deviceId: 'device-1' });
  assert.ok(adbCalls.some(args => args.join(' ') === 'shell settings put global http_proxy corporate.proxy:8888'));
});

test('Android fallback restores an originally unset proxy by deleting the setting', async () => {
  const interceptor = new AndroidAdbInterceptor();
  const calls = [];
  interceptor._getProxy = () => ({ success: true, value: '192.0.2.10:8080' });
  interceptor._adb = (_deviceId, args) => calls.push(args);

  assert.equal(await interceptor._restoreProxy('device-1', 'null', '192.0.2.10:8080'), true);
  assert.deepEqual(calls, [['shell', 'settings', 'delete', 'global', 'http_proxy']]);
});

test('Android fallback stops before mutation when the existing proxy cannot be read', async () => {
  const interceptor = new AndroidAdbInterceptor();
  interceptor._getConnectedDevices = () => [{
    serial: 'device-1',
    status: 'device',
    model: 'Test Device',
    deviceName: 'test'
  }];
  interceptor._getHostIp = () => '192.0.2.10';
  interceptor._getQrMetadata = async () => ({});
  interceptor._getProxy = () => ({ success: false, error: 'device offline' });
  interceptor._pushCaCert = () => assert.fail('CA should not be pushed');
  interceptor._setProxy = () => assert.fail('proxy should not be changed');

  const activation = await interceptor.activate(8080, {
    deviceId: 'device-1',
    useHttpToolkitApp: false
  });

  assert.equal(activation.success, false);
  assert.match(activation.error, /device offline/);
});
