import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AndroidAdbInterceptor } from '../src/interceptors/android-adb-interceptor.js';

const DEVICE_ID = 'device-1';
const PROXY_PORT = 8309;
const HOST_IP = '192.0.2.10';
const OWNED_PROXY = `${HOST_IP}:${PROXY_PORT}`;
const PREVIOUS_PROXY = 'corporate.proxy:8888';
const PREVIOUS_MAPPING = 'tcp:9309';
const STAGED_CA_PATH = '/data/local/tmp/http-freekit-ca.pem';
const TUNNEL_KEY = `${DEVICE_ID}:${PROXY_PORT}`;

function createDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-325-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function readJournal(dataDir) {
  return JSON.parse(fs.readFileSync(
    path.join(dataDir, 'android-adb-global-proxy-recovery.json'),
    'utf8'
  ));
}

function configureAmbiguousWrite(interceptor, postWriteReadback, options = {}) {
  const cleanup = { ca: 0, reverse: 0 };
  let proxyReads = 0;
  interceptor._getConnectedDevices = async () => [{
    serial: DEVICE_ID,
    status: 'device',
    model: 'Test Device',
    deviceName: 'test-device'
  }];
  interceptor._getQrMetadata = async () => ({});
  interceptor._getHostIp = async () => HOST_IP;
  interceptor._getProxy = async () => {
    proxyReads += 1;
    return proxyReads === 1
      ? { success: true, value: PREVIOUS_PROXY }
      : postWriteReadback;
  };
  interceptor._pushCaCert = async () => STAGED_CA_PATH;
  interceptor._setProxy = async () => false;
  interceptor._removeCaCert = async () => {
    cleanup.ca += 1;
    return options.caCleanup !== false;
  };

  if (options.companionReverse) {
    interceptor._prepareHttpToolkitAppActivation = async () => ({
      success: true,
      appInstalled: true,
      connectUrl: 'https://android.httptoolkit.tech/connect/?data=test',
      previousReverseMapping: PREVIOUS_MAPPING
    });
    interceptor._activateHttpToolkitApp = async () => {
      interceptor.reverseTunnels.add(TUNNEL_KEY);
      interceptor.previousReverseMappings.set(TUNNEL_KEY, PREVIOUS_MAPPING);
      return {
        success: false,
        error: 'companion activation and reverse cleanup timed out',
        appInstalled: true,
        tunnelActive: true,
        previousReverseMapping: PREVIOUS_MAPPING
      };
    };
    interceptor._deactivateHttpToolkitApp = async () => {
      cleanup.reverse += 1;
      if (options.reverseCleanup === false) return false;
      interceptor.reverseTunnels.delete(TUNNEL_KEY);
      interceptor.previousReverseMappings.delete(TUNNEL_KEY);
      return true;
    };
  }

  return { cleanup, proxyReads: () => proxyReads };
}

test('apply-then-timeout is promoted to a durable truthful activation and restored after restart', async t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const dataDir = createDataDir(t);
  const original = new AndroidAdbInterceptor({ dataDir });
  const observed = configureAmbiguousWrite(original, { success: true, value: OWNED_PROXY });

  const activation = await original.activate(PROXY_PORT, {
    deviceId: DEVICE_ID,
    useHttpToolkitApp: false
  });

  assert.equal(activation.success, true);
  assert.equal(activation.metadata.mode, 'global-proxy');
  assert.equal(observed.proxyReads(), 2);
  assert.deepEqual(observed.cleanup, { ca: 0, reverse: 0 });
  assert.equal(original.activatedDevices.get(DEVICE_ID).mode, 'global-proxy');
  assert.equal(original.activatedDevices.get(DEVICE_ID).previousProxy, PREVIOUS_PROXY);
  assert.equal(readJournal(dataDir).devices[0].mode, 'global-proxy');

  const restarted = new AndroidAdbInterceptor({ dataDir });
  assert.equal(restarted.activatedDevices.get(DEVICE_ID).recovered, true);
  const commands = [];
  restarted._getProxy = async () => ({ success: true, value: OWNED_PROXY });
  restarted._adb = async (_serial, args) => {
    commands.push(args);
    return '';
  };
  restarted._removeCaCert = async () => true;

  await restarted.deactivate({ deviceId: DEVICE_ID });

  assert.deepEqual(commands, [[
    'shell', 'settings', 'put', 'global', 'http_proxy', PREVIOUS_PROXY
  ]]);
  assert.equal(restarted.active, false);
  assert.equal(fs.existsSync(restarted.recoveryFile), false);
});

test('confirmed not-applied readback cleans only staged ownership and discards the pending journal', async t => {
  t.mock.method(console, 'error', () => {});
  const dataDir = createDataDir(t);
  const interceptor = new AndroidAdbInterceptor({ dataDir });
  const observed = configureAmbiguousWrite(interceptor, {
    success: true,
    value: 'application.proxy:7777'
  });

  const activation = await interceptor.activate(PROXY_PORT, {
    deviceId: DEVICE_ID,
    useHttpToolkitApp: false
  });

  assert.equal(activation.success, false);
  assert.match(activation.error, /Failed to set proxy/);
  assert.equal(observed.proxyReads(), 2);
  assert.deepEqual(observed.cleanup, { ca: 1, reverse: 0 });
  assert.equal(interceptor.activatedDevices.size, 0);
  assert.equal(interceptor.active, false);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});

test('failed readback remains uncertain across restart and later Stop preserves an external proxy', async t => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  const dataDir = createDataDir(t);
  const original = new AndroidAdbInterceptor({ dataDir });
  const observed = configureAmbiguousWrite(original, {
    success: false,
    error: 'device disconnected'
  });

  const activation = await original.activate(PROXY_PORT, {
    deviceId: DEVICE_ID,
    useHttpToolkitApp: false
  });

  assert.equal(activation.success, false);
  assert.match(activation.error, /could not verify whether it was applied/);
  assert.deepEqual(observed.cleanup, { ca: 0, reverse: 0 });
  assert.equal(original.active, true);
  assert.equal(original.activatedDevices.get(DEVICE_ID).mode, 'proxy-uncertain');
  assert.equal(original.activatedDevices.get(DEVICE_ID).previousProxy, PREVIOUS_PROXY);
  assert.equal(readJournal(dataDir).devices[0].mode, 'proxy-uncertain');

  const restarted = new AndroidAdbInterceptor({ dataDir });
  const proxyWrites = [];
  let caRemovals = 0;
  restarted._getProxy = async () => ({ success: true, value: 'application.proxy:9000' });
  restarted._adb = async (_serial, args) => {
    proxyWrites.push(args);
    return '';
  };
  restarted._removeCaCert = async () => {
    caRemovals += 1;
    return true;
  };

  await restarted.deactivate({ deviceId: DEVICE_ID });

  assert.deepEqual(proxyWrites, []);
  assert.equal(caRemovals, 1);
  assert.equal(restarted.active, false);
  assert.equal(fs.existsSync(restarted.recoveryFile), false);
});

test('ambiguous readback after confirmed companion cleanup retains only proxy ownership', async t => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  const dataDir = createDataDir(t);
  const original = new AndroidAdbInterceptor({ dataDir });
  const observed = configureAmbiguousWrite(original, {
    success: true,
    value: `${OWNED_PROXY}\napplication.proxy:9000`
  }, { companionReverse: true });

  const activation = await original.activate(PROXY_PORT, {
    deviceId: DEVICE_ID,
    useHttpToolkitApp: true
  });

  assert.equal(activation.success, false);
  assert.equal(original.activatedDevices.get(DEVICE_ID).mode, 'proxy-uncertain');
  assert.equal(
    Object.prototype.hasOwnProperty.call(original.activatedDevices.get(DEVICE_ID), 'previousReverseMapping'),
    false
  );
  assert.deepEqual(observed.cleanup, { ca: 0, reverse: 1 });
  assert.deepEqual(readJournal(dataDir).devices[0], {
    serial: DEVICE_ID,
    mode: 'proxy-uncertain',
    previousProxy: PREVIOUS_PROXY,
    hostIp: HOST_IP,
    proxyPort: PROXY_PORT,
    remoteCertPath: STAGED_CA_PATH,
    manualCaRemovalRequired: false,
    model: 'Test Device',
    deviceName: 'test-device'
  });

  const restarted = new AndroidAdbInterceptor({ dataDir });
  assert.equal(restarted.reverseTunnels.has(TUNNEL_KEY), false);
  const cleanupOrder = [];
  restarted._getProxy = async () => ({ success: true, value: OWNED_PROXY });
  restarted._adb = async (_serial, args) => {
    if (args[0] === 'shell' && args[1] === 'settings') cleanupOrder.push('proxy');
    if (args[0] === 'reverse') assert.fail('confirmed companion cleanup must not leak reverse ownership');
    return '';
  };
  restarted._removeCaCert = async () => {
    cleanupOrder.push('ca');
    return true;
  };

  await restarted.deactivate({ deviceId: DEVICE_ID });

  assert.deepEqual(cleanupOrder, ['proxy', 'ca']);
  assert.equal(restarted.reverseTunnels.size, 0);
  assert.equal(restarted.active, false);
  assert.equal(fs.existsSync(restarted.recoveryFile), false);
});
