import assert from 'node:assert/strict';
import test from 'node:test';
import { AndroidAdbInterceptor } from '../src/interceptors/android-adb-interceptor.js';

test('failed Android fallback cleanup stays tracked and can be retried', async () => {
  const interceptor = new AndroidAdbInterceptor();
  interceptor.activatedDevices.set('device-1', {
    mode: 'global-proxy',
    previousProxy: 'corporate.proxy:8888'
  });
  interceptor.active = true;
  let restoreSucceeds = false;
  let certificateRemovals = 0;
  interceptor._restoreProxy = () => restoreSucceeds;
  interceptor._removeCaCert = () => {
    certificateRemovals += 1;
    return true;
  };

  await assert.rejects(
    interceptor.deactivate({ deviceId: 'device-1' }),
    /reconnect it and retry Stop/
  );
  assert.equal(certificateRemovals, 1);
  assert.equal(interceptor.activatedDevices.has('device-1'), true);
  assert.equal(interceptor.active, true);

  restoreSucceeds = true;
  await interceptor.deactivate({ deviceId: 'device-1' });
  assert.equal(interceptor.activatedDevices.has('device-1'), false);
  assert.equal(interceptor.active, false);
});

test('bulk Android cleanup removes successes and retains failures', async () => {
  const interceptor = new AndroidAdbInterceptor();
  interceptor.activatedDevices.set('working', { mode: 'global-proxy', previousProxy: 'null' });
  interceptor.activatedDevices.set('offline', { mode: 'global-proxy', previousProxy: 'null' });
  interceptor.active = true;
  interceptor._restoreProxy = serial => serial === 'working';
  interceptor._removeCaCert = () => true;

  await assert.rejects(interceptor.deactivate(), /offline/);

  assert.equal(interceptor.activatedDevices.has('working'), false);
  assert.equal(interceptor.activatedDevices.has('offline'), true);
  assert.equal(interceptor.active, true);
});

test('failed reverse-tunnel removal remains tracked for retry', async () => {
  const interceptor = new AndroidAdbInterceptor();
  interceptor.reverseTunnels.add('device-1:8080');
  let succeeds = false;
  interceptor._adb = () => {
    if (!succeeds) throw new Error('device offline');
  };

  assert.equal(await interceptor._removeReverseTunnel('device-1', 8080), false);
  assert.equal(interceptor.reverseTunnels.has('device-1:8080'), true);

  succeeds = true;
  assert.equal(await interceptor._removeReverseTunnel('device-1', 8080), true);
  assert.equal(interceptor.reverseTunnels.has('device-1:8080'), false);
});
