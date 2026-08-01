import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AndroidAdbInterceptor } from '../../../src/interceptors/android-adb-interceptor.js';

const DEVICE_ID = 'device-1';
const OWNED_PROXY = '192.0.2.10:8080';
const STAGED_CA_PATH = '/data/local/tmp/http-freekit-ca.pem';

function ownedInterceptor(t, previousProxy = 'old.proxy:8001') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-301-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const interceptor = new AndroidAdbInterceptor({ dataDir });
  const activeInfo = {
    mode: 'global-proxy',
    previousProxy,
    hostIp: '192.0.2.10',
    proxyPort: 8080,
    remoteCertPath: STAGED_CA_PATH,
    model: 'Test Device',
    deviceName: 'test-device'
  };
  interceptor._rememberGlobalProxyOwnership(DEVICE_ID, activeInfo);
  interceptor.activatedDevices.set(DEVICE_ID, activeInfo);
  interceptor.active = true;
  return { activeInfo, interceptor };
}

function captureCleanup(interceptor, currentProxy) {
  const proxyWrites = [];
  let certificateRemovals = 0;
  interceptor._getProxy = async () => currentProxy;
  interceptor._adb = async (_serial, args) => {
    proxyWrites.push(args);
    return '';
  };
  interceptor._removeCaCert = async () => {
    certificateRemovals += 1;
    return true;
  };
  return { proxyWrites, certificateRemovals: () => certificateRemovals };
}

test('Android Stop preserves an externally changed proxy and relinquishes cleanup ownership', async t => {
  const { interceptor } = ownedInterceptor(t);
  const cleanup = captureCleanup(interceptor, { success: true, value: 'new.proxy:8002' });

  await interceptor.deactivate({ deviceId: DEVICE_ID });

  assert.deepEqual(cleanup.proxyWrites, []);
  assert.equal(cleanup.certificateRemovals(), 1);
  assert.equal(interceptor.activatedDevices.has(DEVICE_ID), false);
  assert.equal(interceptor.journaledGlobalDevices.has(DEVICE_ID), false);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
  assert.equal(interceptor.active, false);
});

test('Android Stop restores the prior proxy while the FreeKit-owned value is unchanged', async t => {
  const { interceptor } = ownedInterceptor(t, 'old.proxy:8001');
  const cleanup = captureCleanup(interceptor, { success: true, value: OWNED_PROXY });

  await interceptor.deactivate({ deviceId: DEVICE_ID });

  assert.deepEqual(cleanup.proxyWrites, [[
    'shell', 'settings', 'put', 'global', 'http_proxy', 'old.proxy:8001'
  ]]);
  assert.equal(cleanup.certificateRemovals(), 1);
  assert.equal(interceptor.active, false);
});

test('Android Stop restores an originally unset proxy while its owned value is unchanged', async t => {
  const { interceptor } = ownedInterceptor(t, 'null');
  const cleanup = captureCleanup(interceptor, { success: true, value: OWNED_PROXY });

  await interceptor.deactivate({ deviceId: DEVICE_ID });

  assert.deepEqual(cleanup.proxyWrites, [[
    'shell', 'settings', 'delete', 'global', 'http_proxy'
  ]]);
  assert.equal(cleanup.certificateRemovals(), 1);
  assert.equal(interceptor.active, false);
});

test('a current-proxy read failure performs no write and retains recovery ownership', async t => {
  const { activeInfo, interceptor } = ownedInterceptor(t);
  const cleanup = captureCleanup(interceptor, { success: false, error: 'device offline' });

  await assert.rejects(
    interceptor.deactivate({ deviceId: DEVICE_ID }),
    /reconnect it and retry Stop/
  );

  assert.deepEqual(cleanup.proxyWrites, []);
  assert.equal(cleanup.certificateRemovals(), 1);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID), activeInfo);
  assert.equal(interceptor.journaledGlobalDevices.has(DEVICE_ID), true);
  assert.equal(fs.existsSync(interceptor.recoveryFile), true);
  assert.equal(interceptor.active, true);
});

test('an ambiguous current-proxy read performs no write and remains retryable', async t => {
  const { activeInfo, interceptor } = ownedInterceptor(t);
  const cleanup = captureCleanup(interceptor, { success: true, value: 'first.proxy:1\nsecond.proxy:2' });

  await assert.rejects(
    interceptor.deactivate({ deviceId: DEVICE_ID }),
    /reconnect it and retry Stop/
  );

  assert.deepEqual(cleanup.proxyWrites, []);
  assert.equal(cleanup.certificateRemovals(), 1);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID), activeInfo);
  assert.equal(interceptor.journaledGlobalDevices.has(DEVICE_ID), true);
  assert.equal(interceptor.active, true);
});
