import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AndroidAdbInterceptor } from '../src/interceptors/android-adb-interceptor.js';

const DEVICE_ID = 'device-1';
const PROXY_PORT = 8309;
const TUNNEL_KEY = `${DEVICE_ID}:${PROXY_PORT}`;
const OWNED_PROXY = `192.0.2.10:${PROXY_PORT}`;
const PREVIOUS_PROXY = 'corporate.proxy:8888';
const PREVIOUS_MAPPING = 'tcp:9309';
const STAGED_CA_PATH = '/data/local/tmp/http-freekit-ca.pem';

function createDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-309-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function activeInfo(overrides = {}) {
  return {
    mode: 'global-proxy',
    previousProxy: PREVIOUS_PROXY,
    hostIp: '192.0.2.10',
    proxyPort: PROXY_PORT,
    remoteCertPath: STAGED_CA_PATH,
    model: 'Test Device',
    deviceName: 'test-device',
    previousReverseMapping: PREVIOUS_MAPPING,
    ...overrides
  };
}

function rememberOwnedFallback(interceptor, info = activeInfo()) {
  interceptor._rememberGlobalProxyOwnership(DEVICE_ID, info);
  interceptor.activatedDevices.set(DEVICE_ID, info);
  interceptor.reverseTunnels.add(TUNNEL_KEY);
  interceptor.previousReverseMappings.set(TUNNEL_KEY, info.previousReverseMapping);
  interceptor.active = true;
}

function readJournal(interceptor) {
  return JSON.parse(fs.readFileSync(interceptor.recoveryFile, 'utf8'));
}

function configureFailedCompanion(interceptor) {
  interceptor._getConnectedDevices = async () => [{
    serial: DEVICE_ID,
    status: 'device',
    model: 'Test Device',
    deviceName: 'test-device'
  }];
  interceptor._getQrMetadata = async () => ({});
  interceptor._activateHttpToolkitApp = async () => {
    interceptor.reverseTunnels.add(TUNNEL_KEY);
    interceptor.previousReverseMappings.set(TUNNEL_KEY, PREVIOUS_MAPPING);
    return {
      success: false,
      error: 'activation intent timed out and reverse restore failed',
      appInstalled: true,
      tunnelActive: true,
      previousReverseMapping: PREVIOUS_MAPPING
    };
  };
}

function expectedReverseOnlyJournal() {
  return {
    version: 2,
    devices: [{
      serial: DEVICE_ID,
      mode: 'reverse-cleanup',
      proxyPort: PROXY_PORT,
      previousReverseMapping: PREVIOUS_MAPPING,
      model: 'Test Device',
      deviceName: 'test-device'
    }]
  };
}

test('failed companion cleanup transfers reverse ownership to fallback and Stop restores it last', async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const interceptor = new AndroidAdbInterceptor({ dataDir: createDataDir(t) });
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
  interceptor._getHostIp = async () => '192.0.2.10';
  interceptor._isHttpToolkitAppInstalled = async () => true;
  interceptor._bringHttpToolkitAppToFront = async () => {};
  interceptor._buildHttpToolkitConnectUrl = () => 'https://android.httptoolkit.tech/connect/?data=test';
  interceptor._pushCaCert = async () => STAGED_CA_PATH;

  const commands = [];
  let proxyReads = 0;
  let reverseRestores = 0;
  interceptor._adb = async (_serial, args) => {
    commands.push(args);
    if (args[0] === 'reverse' && args[1] === '--list') {
      return `${DEVICE_ID} tcp:${PROXY_PORT} ${PREVIOUS_MAPPING}\n`;
    }
    if (args[0] === 'shell' && args[1] === 'am') {
      return 'Starting: Intent { act=tech.httptoolkit.android.ACTIVATE }\nStatus: timeout\n';
    }
    if (args[0] === 'reverse' && args[1] === `tcp:${PROXY_PORT}` &&
        args[2] === PREVIOUS_MAPPING) {
      reverseRestores += 1;
      if (reverseRestores === 1) throw new Error('device temporarily offline');
    }
    if (args.join(' ') === 'shell settings get global http_proxy') {
      proxyReads += 1;
      return proxyReads === 1 ? `${PREVIOUS_PROXY}\n` : `${OWNED_PROXY}\n`;
    }
    return '';
  };

  const activation = await interceptor.activate(PROXY_PORT, {
    deviceId: DEVICE_ID,
    useHttpToolkitApp: true
  });

  assert.equal(activation.success, true);
  assert.equal(activation.metadata.mode, 'global-proxy');
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).previousReverseMapping, PREVIOUS_MAPPING);
  assert.deepEqual(readJournal(interceptor), {
    version: 2,
    devices: [{
      serial: DEVICE_ID,
      mode: 'global-proxy',
      previousProxy: PREVIOUS_PROXY,
      hostIp: '192.0.2.10',
      proxyPort: PROXY_PORT,
      remoteCertPath: STAGED_CA_PATH,
      model: 'Test Device',
      deviceName: 'test-device',
      previousReverseMapping: PREVIOUS_MAPPING
    }]
  });

  await interceptor.deactivate({ deviceId: DEVICE_ID });

  assert.equal(reverseRestores, 2);
  const stopProxyWrite = commands.findIndex(args => args.join(' ') ===
    `shell settings put global http_proxy ${PREVIOUS_PROXY}`);
  const stopCertRemoval = commands.findIndex(args => args.join(' ') ===
    `shell rm -f ${STAGED_CA_PATH}`);
  const finalReverseRestore = commands.findLastIndex(args =>
    args[0] === 'reverse' && args[2] === PREVIOUS_MAPPING);
  assert.ok(stopProxyWrite >= 0);
  assert.ok(stopCertRemoval > stopProxyWrite);
  assert.ok(finalReverseRestore > stopCertRemoval);
  assert.equal(interceptor.activatedDevices.size, 0);
  assert.equal(interceptor.reverseTunnels.size, 0);
  assert.equal(interceptor.previousReverseMappings.size, 0);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});

test('failed reverse restoration stays journaled and Stop retries without overwriting the restored proxy', async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const interceptor = new AndroidAdbInterceptor({ dataDir: createDataDir(t) });
  const info = activeInfo();
  rememberOwnedFallback(interceptor, info);

  const commands = [];
  let currentProxy = OWNED_PROXY;
  let reverseAttempts = 0;
  interceptor._adb = async (_serial, args) => {
    commands.push(args);
    if (args.join(' ') === 'shell settings get global http_proxy') return `${currentProxy}\n`;
    if (args[0] === 'shell' && args[1] === 'settings' && args[2] === 'put') {
      currentProxy = args.at(-1);
    }
    if (args[0] === 'reverse') {
      reverseAttempts += 1;
      if (reverseAttempts === 1) throw new Error('reverse restore failed');
    }
    return '';
  };

  await assert.rejects(
    interceptor.deactivate({ deviceId: DEVICE_ID }),
    /reconnect it and retry Stop/
  );
  assert.equal(currentProxy, PREVIOUS_PROXY);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID), info);
  assert.equal(interceptor.reverseTunnels.has(TUNNEL_KEY), true);
  assert.equal(interceptor.previousReverseMappings.get(TUNNEL_KEY), PREVIOUS_MAPPING);
  assert.equal(fs.existsSync(interceptor.recoveryFile), true);

  await interceptor.deactivate({ deviceId: DEVICE_ID });

  assert.equal(reverseAttempts, 2);
  assert.equal(commands.filter(args => args[0] === 'shell' && args[1] === 'settings' &&
    args[2] === 'put').length, 1);
  assert.equal(commands.filter(args => args[0] === 'shell' && args[1] === 'rm').length, 2);
  assert.equal(interceptor.active, false);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});

test('external proxy ownership and CA failure preserve reverse cleanup for a later Stop', async t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const interceptor = new AndroidAdbInterceptor({ dataDir: createDataDir(t) });
  rememberOwnedFallback(interceptor);

  const commands = [];
  let caAttempts = 0;
  interceptor._adb = async (_serial, args) => {
    commands.push(args);
    if (args.join(' ') === 'shell settings get global http_proxy') return 'new.proxy:7777\n';
    if (args[0] === 'shell' && args[1] === 'rm') {
      caAttempts += 1;
      if (caAttempts === 1) throw new Error('device temporarily offline');
    }
    return '';
  };

  await assert.rejects(
    interceptor.deactivate({ deviceId: DEVICE_ID }),
    /reconnect it and retry Stop/
  );
  assert.equal(commands.some(args => args[0] === 'reverse'), false);
  assert.equal(interceptor.reverseTunnels.has(TUNNEL_KEY), true);
  assert.equal(fs.existsSync(interceptor.recoveryFile), true);

  await interceptor.deactivate({ deviceId: DEVICE_ID });

  assert.equal(caAttempts, 2);
  assert.deepEqual(commands.filter(args => args[0] === 'reverse'), [
    ['reverse', `tcp:${PROXY_PORT}`, PREVIOUS_MAPPING]
  ]);
  assert.equal(commands.some(args => args[0] === 'shell' && args[1] === 'settings' &&
    ['put', 'delete'].includes(args[2])), false);
  assert.equal(interceptor.active, false);
});

test('proxy setup failure retains reverse ownership in staging cleanup until Stop succeeds', async t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const interceptor = new AndroidAdbInterceptor({ dataDir: createDataDir(t) });
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
  interceptor._getHostIp = async () => '192.0.2.10';
  interceptor._isHttpToolkitAppInstalled = async () => true;
  interceptor._bringHttpToolkitAppToFront = async () => {};
  interceptor._buildHttpToolkitConnectUrl = () => 'https://android.httptoolkit.tech/connect/?data=test';
  interceptor._pushCaCert = async () => STAGED_CA_PATH;

  let reverseAttempts = 0;
  let stopPhase = false;
  interceptor._adb = async (_serial, args) => {
    if (args[0] === 'reverse' && args[1] === '--list') {
      return `${DEVICE_ID} tcp:${PROXY_PORT} ${PREVIOUS_MAPPING}\n`;
    }
    if (args[0] === 'shell' && args[1] === 'am') return 'Status: timeout\n';
    if (args[0] === 'reverse' && args[1] === `tcp:${PROXY_PORT}` &&
        args[2] === PREVIOUS_MAPPING) {
      reverseAttempts += 1;
      if (!stopPhase) throw new Error('reverse restore failed');
    }
    if (args.join(' ') === 'shell settings get global http_proxy') return `${PREVIOUS_PROXY}\n`;
    if (args.join(' ') === `shell settings put global http_proxy ${OWNED_PROXY}`) {
      throw new Error('proxy write failed');
    }
    return '';
  };

  const activation = await interceptor.activate(PROXY_PORT, {
    deviceId: DEVICE_ID,
    useHttpToolkitApp: true
  });

  assert.equal(activation.success, false);
  assert.match(activation.error, /retry Stop/);
  assert.equal(reverseAttempts, 2);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).mode, 'staging-cleanup');
  assert.equal(readJournal(interceptor).devices[0].previousReverseMapping, PREVIOUS_MAPPING);

  stopPhase = true;
  await interceptor.deactivate({ deviceId: DEVICE_ID });

  assert.equal(reverseAttempts, 3);
  assert.equal(interceptor.active, false);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});

test('host-IP discovery failure leaves restart-safe reverse-only ownership', async t => {
  t.mock.method(console, 'warn', () => {});
  const dataDir = createDataDir(t);
  const interceptor = new AndroidAdbInterceptor({ dataDir });
  configureFailedCompanion(interceptor);
  interceptor._getHostIp = async () => {
    throw new Error('no reachable host adapter');
  };
  interceptor._getProxy = async () => assert.fail('proxy discovery must follow host discovery');

  await assert.rejects(
    interceptor.activate(PROXY_PORT, { deviceId: DEVICE_ID, useHttpToolkitApp: true }),
    /no reachable host adapter/
  );

  assert.equal(interceptor.active, true);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).mode, 'reverse-cleanup');
  assert.deepEqual(readJournal(interceptor), expectedReverseOnlyJournal());

  const restarted = new AndroidAdbInterceptor({ dataDir });
  assert.equal(restarted.activatedDevices.get(DEVICE_ID).mode, 'reverse-cleanup');
  assert.equal(restarted.reverseTunnels.has(TUNNEL_KEY), true);
  const commands = [];
  restarted._adb = async (_serial, args) => {
    commands.push(args);
    return '';
  };
  restarted._restoreProxy = async () => assert.fail('reverse-only cleanup must not claim proxy ownership');
  restarted._removeCaCert = async () => assert.fail('reverse-only cleanup must not claim CA ownership');

  await restarted.deactivate({ deviceId: DEVICE_ID });

  assert.deepEqual(commands, [['reverse', `tcp:${PROXY_PORT}`, PREVIOUS_MAPPING]]);
  assert.equal(restarted.active, false);
  assert.equal(fs.existsSync(restarted.recoveryFile), false);
});

test('current-proxy read failure leaves retryable reverse-only ownership', async t => {
  t.mock.method(console, 'warn', () => {});
  const dataDir = createDataDir(t);
  const interceptor = new AndroidAdbInterceptor({ dataDir });
  configureFailedCompanion(interceptor);
  interceptor._getHostIp = async () => '192.0.2.10';
  interceptor._getProxy = async () => ({ success: false, error: 'device offline' });
  interceptor._pushCaCert = async () => assert.fail('CA mutation must not follow a failed proxy read');
  interceptor._setProxy = async () => assert.fail('proxy mutation must not follow a failed proxy read');

  const activation = await interceptor.activate(PROXY_PORT, {
    deviceId: DEVICE_ID,
    useHttpToolkitApp: true
  });

  assert.equal(activation.success, false);
  assert.match(activation.error, /Failed to read existing proxy/);
  assert.equal(interceptor.active, true);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).mode, 'reverse-cleanup');
  assert.deepEqual(readJournal(interceptor), expectedReverseOnlyJournal());

  const commands = [];
  interceptor._adb = async (_serial, args) => {
    commands.push(args);
    return '';
  };
  interceptor._restoreProxy = async () => assert.fail('reverse-only cleanup must not claim proxy ownership');
  interceptor._removeCaCert = async () => assert.fail('reverse-only cleanup must not claim CA ownership');

  await interceptor.deactivate({ deviceId: DEVICE_ID });

  assert.deepEqual(commands, [['reverse', `tcp:${PROXY_PORT}`, PREVIOUS_MAPPING]]);
  assert.equal(interceptor.active, false);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});

test('restart rebuilds retained reverse ownership and removes the durable journal only after cleanup', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = createDataDir(t);
  const original = new AndroidAdbInterceptor({ dataDir });
  rememberOwnedFallback(original, activeInfo({ previousReverseMapping: null }));

  const restarted = new AndroidAdbInterceptor({ dataDir });
  assert.equal(restarted.reverseTunnels.has(TUNNEL_KEY), true);
  assert.equal(restarted.previousReverseMappings.get(TUNNEL_KEY), null);
  assert.equal(restarted.activatedDevices.get(DEVICE_ID).recovered, true);
  restarted._restoreProxy = async () => true;
  restarted._removeCaCert = async () => true;
  const commands = [];
  restarted._adb = async (_serial, args) => {
    commands.push(args);
    return '';
  };

  await restarted.deactivate({ deviceId: DEVICE_ID });

  assert.deepEqual(commands, [['reverse', '--remove', `tcp:${PROXY_PORT}`]]);
  assert.equal(restarted.reverseTunnels.size, 0);
  assert.equal(restarted.previousReverseMappings.size, 0);
  assert.equal(fs.existsSync(restarted.recoveryFile), false);
});

test('malformed v2 reverse ownership is rejected without replacing the journal', async t => {
  t.mock.method(console, 'warn', () => {});
  const dataDir = createDataDir(t);
  const recoveryFile = path.join(dataDir, 'android-adb-global-proxy-recovery.json');
  const malformedJournal = JSON.stringify({
    version: 2,
    devices: [{
      serial: DEVICE_ID,
      ...activeInfo({ previousReverseMapping: 'tcp:0' })
    }]
  });
  fs.writeFileSync(recoveryFile, malformedJournal, 'utf8');

  const interceptor = new AndroidAdbInterceptor({ dataDir });

  assert.equal(interceptor.active, false);
  assert.equal(interceptor.activatedDevices.size, 0);
  assert.equal(interceptor.reverseTunnels.size, 0);
  assert.equal(fs.readFileSync(recoveryFile, 'utf8'), malformedJournal);
});

test('reverse-only recovery requires an explicit valid prior mapping field', async t => {
  t.mock.method(console, 'warn', () => {});
  const dataDir = createDataDir(t);
  const recoveryFile = path.join(dataDir, 'android-adb-global-proxy-recovery.json');
  const malformedJournal = JSON.stringify({
    version: 2,
    devices: [{
      serial: DEVICE_ID,
      mode: 'reverse-cleanup',
      proxyPort: PROXY_PORT
    }]
  });
  fs.writeFileSync(recoveryFile, malformedJournal, 'utf8');

  const interceptor = new AndroidAdbInterceptor({ dataDir });

  assert.equal(interceptor.active, false);
  assert.equal(interceptor.reverseTunnels.size, 0);
  assert.equal(fs.readFileSync(recoveryFile, 'utf8'), malformedJournal);
});

test('legacy v1 proxy journals remain valid and do not invent reverse ownership', async t => {
  const dataDir = createDataDir(t);
  const recoveryFile = path.join(dataDir, 'android-adb-global-proxy-recovery.json');
  fs.writeFileSync(recoveryFile, JSON.stringify({
    version: 1,
    devices: [{
      serial: DEVICE_ID,
      mode: 'global-proxy',
      previousProxy: PREVIOUS_PROXY,
      hostIp: '192.0.2.10',
      proxyPort: PROXY_PORT,
      remoteCertPath: STAGED_CA_PATH
    }]
  }), 'utf8');

  const interceptor = new AndroidAdbInterceptor({ dataDir });
  assert.equal(interceptor.active, true);
  assert.equal(interceptor.reverseTunnels.size, 0);
  assert.equal(interceptor.previousReverseMappings.size, 0);
  interceptor._restoreProxy = async () => true;
  interceptor._removeCaCert = async () => true;
  interceptor._removeReverseTunnel = async () => assert.fail('v1 must not invent reverse ownership');

  await interceptor.deactivate({ deviceId: DEVICE_ID });

  assert.equal(interceptor.active, false);
  assert.equal(fs.existsSync(recoveryFile), false);
});
