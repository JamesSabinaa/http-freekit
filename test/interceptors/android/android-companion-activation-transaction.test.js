import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AndroidAdbInterceptor } from '../../../src/interceptors/android-adb-interceptor.js';

const DEVICE_ID = 'device-1';
const PROXY_PORT = 8337;
const PREVIOUS_MAPPING = 'tcp:9337';
const PREVIOUS_PROXY = 'corporate.proxy:8888';
const STAGED_CA_PATH = '/data/local/tmp/http-freekit-ca.pem';
const TUNNEL_KEY = `${DEVICE_ID}:${PROXY_PORT}`;

function createDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-337-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function configureCompanion(interceptor) {
  interceptor.ca = {
    getCertInfo: () => ({ certificateSpkiFingerprint: 'test-spki' })
  };
  interceptor._getConnectedDevices = async () => [{
    serial: DEVICE_ID,
    status: 'device',
    model: 'Test Device',
    deviceName: 'test-device'
  }];
  interceptor._getQrMetadata = async () => ({});
  interceptor._isHttpToolkitAppInstalled = async () => true;
  interceptor._bringHttpToolkitAppToFront = async () => {};
  interceptor._buildHttpToolkitConnectUrl = () =>
    'https://android.httptoolkit.tech/connect/?data=test';
}

function readJournal(interceptor) {
  return JSON.parse(fs.readFileSync(interceptor.recoveryFile, 'utf8'));
}

test('first ambiguous companion activation is journaled before mutation and recovered by Stop after restart', async t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const dataDir = createDataDir(t);
  const original = new AndroidAdbInterceptor({ dataDir });
  configureCompanion(original);

  let vpnActive = false;
  const originalCommands = [];
  original._adb = async (_serial, args) => {
    originalCommands.push(args);
    if (args[0] === 'reverse' && args[1] === '--list') {
      return '';
    }
    if (args[0] === 'reverse') {
      assert.equal(readJournal(original).devices[0].mode, 'app-uncertain');
      return '';
    }
    if (args.includes('tech.httptoolkit.android.ACTIVATE')) {
      vpnActive = true;
      throw new Error('device disconnected after activation');
    }
    if (args.includes('tech.httptoolkit.android.DEACTIVATE')) {
      return 'Status: timeout\n';
    }
    return '';
  };
  original._getHostIp = async () => assert.fail('uncertain app activation must block fallback');

  const activation = await original.activate(PROXY_PORT, {
    deviceId: DEVICE_ID,
    useHttpToolkitApp: true
  });

  assert.equal(activation.success, false);
  assert.match(activation.error, /retry Stop/);
  assert.equal(vpnActive, true);
  assert.equal(original.activatedDevices.get(DEVICE_ID).mode, 'app-uncertain');
  assert.equal(original.reverseTunnels.has(TUNNEL_KEY), true);
  assert.deepEqual(readJournal(original), {
    version: 6,
    devices: [{
      serial: DEVICE_ID,
      mode: 'app-uncertain',
      proxyPort: PROXY_PORT,
      previousReverseMapping: null,
      model: 'Test Device',
      deviceName: 'test-device',
      vpnStatusConfirmed: false
    }]
  });

  const restarted = new AndroidAdbInterceptor({ dataDir });
  configureCompanion(restarted);
  restarted._getReverseMapping = async () => `tcp:${PROXY_PORT}`;
  const cleanupCommands = [];
  restarted._adb = async (_serial, args) => {
    cleanupCommands.push(args);
    if (args.includes('tech.httptoolkit.android.DEACTIVATE')) {
      vpnActive = false;
      return 'Status: ok\n';
    }
    return '';
  };

  await restarted.deactivate({ deviceId: DEVICE_ID });

  assert.equal(vpnActive, false);
  assert.deepEqual(cleanupCommands, [
    [
      'shell', 'am', 'start', '-W', '-a',
      'tech.httptoolkit.android.DEACTIVATE'
    ],
    ['reverse', '--remove', `tcp:${PROXY_PORT}`]
  ]);
  assert.equal(restarted.active, false);
  assert.equal(fs.existsSync(restarted.recoveryFile), false);
});

test('confirmed companion deactivation and reverse removal precede global fallback', async t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const interceptor = new AndroidAdbInterceptor({ dataDir: createDataDir(t) });
  configureCompanion(interceptor);

  const events = [];
  let vpnActive = false;
  let reverseReads = 0;
  interceptor._getReverseMapping = async () => {
    if (reverseReads++ === 0) {
      events.push('snapshot reverse');
      return null;
    }
    return `tcp:${PROXY_PORT}`;
  };
  interceptor._adb = async (_serial, args) => {
    if (args[0] === 'reverse' && args[1] === '--no-rebind') {
      events.push('create reverse');
      assert.equal(readJournal(interceptor).devices[0].mode, 'app-uncertain');
      return '';
    }
    if (args.includes('tech.httptoolkit.android.ACTIVATE')) {
      events.push('activate app');
      vpnActive = true;
      return 'Status: timeout\n';
    }
    if (args.includes('tech.httptoolkit.android.DEACTIVATE')) {
      events.push('deactivate app');
      vpnActive = false;
      return 'Status: ok\n';
    }
    if (args[0] === 'reverse' && args[1] === '--remove') {
      events.push('remove reverse');
      return '';
    }
    return '';
  };
  interceptor._getHostIp = async () => {
    events.push('prepare fallback');
    assert.equal(vpnActive, false);
    assert.equal(interceptor.reverseTunnels.has(TUNNEL_KEY), false);
    return '192.0.2.10';
  };
  interceptor._getProxy = async () => ({ success: true, value: PREVIOUS_PROXY });
  interceptor._pushCaCert = async () => STAGED_CA_PATH;
  interceptor._setProxy = async () => true;

  const activation = await interceptor.activate(PROXY_PORT, {
    deviceId: DEVICE_ID,
    useHttpToolkitApp: true
  });

  assert.equal(activation.success, true);
  assert.equal(activation.metadata.mode, 'global-proxy');
  assert.equal(vpnActive, false);
  assert.deepEqual(events, [
    'snapshot reverse',
    'create reverse',
    'activate app',
    'deactivate app',
    'remove reverse',
    'prepare fallback'
  ]);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).mode, 'global-proxy');
  assert.equal(interceptor.reverseTunnels.has(TUNNEL_KEY), false);
  assert.equal(Object.prototype.hasOwnProperty.call(
    readJournal(interceptor).devices[0],
    'previousReverseMapping'
  ), false);
});

test('confirmed deactivation with failed reverse removal retains app uncertainty and blocks fallback', async t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const interceptor = new AndroidAdbInterceptor({ dataDir: createDataDir(t) });
  configureCompanion(interceptor);

  let reverseRemovals = 0;
  let deactivations = 0;
  let reverseReads = 0;
  interceptor._getReverseMapping = async () =>
    reverseReads++ === 0 ? null : `tcp:${PROXY_PORT}`;
  interceptor._adb = async (_serial, args) => {
    if (args.includes('tech.httptoolkit.android.ACTIVATE')) {
      return 'Status: timeout\n';
    }
    if (args.includes('tech.httptoolkit.android.DEACTIVATE')) {
      deactivations += 1;
      return 'Status: ok\n';
    }
    if (args[0] === 'reverse' && args[1] === '--remove') {
      reverseRemovals += 1;
      if (reverseRemovals === 1) throw new Error('device disconnected during reverse removal');
    }
    return '';
  };
  interceptor._getHostIp = async () => assert.fail('failed reverse cleanup must block fallback');

  const activation = await interceptor.activate(PROXY_PORT, {
    deviceId: DEVICE_ID,
    useHttpToolkitApp: true
  });

  assert.equal(activation.success, false);
  assert.match(activation.error, /retry Stop/);
  assert.equal(deactivations, 1);
  assert.equal(reverseRemovals, 1);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).mode, 'app-uncertain');
  assert.equal(interceptor.reverseTunnels.has(TUNNEL_KEY), true);
  assert.equal(readJournal(interceptor).devices[0].previousReverseMapping, null);

  await interceptor.deactivate({ deviceId: DEVICE_ID });

  assert.equal(deactivations, 2);
  assert.equal(reverseRemovals, 2);
  assert.equal(interceptor.active, false);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});
