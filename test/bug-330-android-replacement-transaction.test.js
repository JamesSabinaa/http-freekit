import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AndroidAdbInterceptor } from '../src/interceptors/android-adb-interceptor.js';

const DEVICE_ID = 'device-1';
const OLD_HOST = '192.0.2.10';
const OLD_PORT = 8080;
const OLD_PROXY = `${OLD_HOST}:${OLD_PORT}`;
const PREVIOUS_PROXY = 'corporate.proxy:8888';
const PREVIOUS_MAPPING = 'tcp:9000';
const STAGED_CA_PATH = '/data/local/tmp/http-freekit-ca.pem';
const REVERSE_KEY = `${DEVICE_ID}:${OLD_PORT}`;
const CONNECT_URL = 'https://android.httptoolkit.tech/connect/?data=test';

function createDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-330-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function configureDevice(interceptor) {
  interceptor._getConnectedDevices = async () => [{
    serial: DEVICE_ID,
    status: 'device',
    model: 'Test Device',
    deviceName: 'test-device'
  }];
  interceptor._getQrMetadata = async () => ({});
}

function globalActivation(overrides = {}) {
  return {
    mode: 'global-proxy',
    previousProxy: PREVIOUS_PROXY,
    hostIp: OLD_HOST,
    proxyPort: OLD_PORT,
    remoteCertPath: STAGED_CA_PATH,
    model: 'Test Device',
    deviceName: 'test-device',
    ...overrides
  };
}

function rememberGlobalActivation(interceptor, info = globalActivation()) {
  interceptor._rememberGlobalProxyOwnership(DEVICE_ID, info);
  interceptor.activatedDevices.set(DEVICE_ID, info);
  interceptor.active = true;
  if (Object.prototype.hasOwnProperty.call(info, 'previousReverseMapping')) {
    interceptor.reverseTunnels.add(REVERSE_KEY);
    interceptor.previousReverseMappings.set(REVERSE_KEY, info.previousReverseMapping);
  }
  return info;
}

function journalText(interceptor) {
  return fs.readFileSync(interceptor.recoveryFile, 'utf8');
}

function preparedCompanion() {
  return {
    success: true,
    appInstalled: true,
    connectUrl: CONNECT_URL,
    previousReverseMapping: null
  };
}

test('invalid explicit host leaves the working companion activation untouched', async () => {
  const interceptor = new AndroidAdbInterceptor();
  configureDevice(interceptor);
  const previous = {
    mode: 'http-toolkit-app',
    proxyPort: OLD_PORT,
    model: 'Test Device',
    deviceName: 'test-device',
    tunnelActive: true
  };
  interceptor.activatedDevices.set(DEVICE_ID, previous);
  interceptor.reverseTunnels.add(REVERSE_KEY);
  interceptor.previousReverseMappings.set(REVERSE_KEY, PREVIOUS_MAPPING);
  interceptor.active = true;
  interceptor._getHostInterfaces = () => [{
    name: 'Ethernet',
    address: OLD_HOST,
    netmask: '255.255.255.0',
    prefixLength: 24
  }];
  interceptor._cleanupActivatedDevice = async () => assert.fail('old mode must not be cleaned');
  interceptor._getProxy = async () => assert.fail('invalid host must fail before proxy preparation');
  interceptor._pushCaCert = async () => assert.fail('replacement must not mutate the device');

  await assert.rejects(
    interceptor.activate(9090, {
      deviceId: DEVICE_ID,
      useHttpToolkitApp: false,
      hostIp: '203.0.113.99'
    }),
    /is not a local IPv4 address/
  );

  assert.equal(interceptor.activatedDevices.get(DEVICE_ID), previous);
  assert.equal(interceptor.reverseTunnels.has(REVERSE_KEY), true);
  assert.equal(interceptor.previousReverseMappings.get(REVERSE_KEY), PREVIOUS_MAPPING);
  assert.equal(interceptor.active, true);
});

test('ambiguous adapter selection returns choices without changing durable ownership', async t => {
  const interceptor = new AndroidAdbInterceptor({ dataDir: createDataDir(t) });
  configureDevice(interceptor);
  const previous = rememberGlobalActivation(interceptor);
  const originalJournal = journalText(interceptor);
  const candidates = [
    { name: 'Ethernet', address: '192.168.50.5', prefixLength: 24 },
    { name: 'Wi-Fi', address: '192.168.50.6', prefixLength: 24 }
  ];
  interceptor._getHostIp = async () => {
    const error = new Error('Multiple host adapters can reach the Android device');
    error.code = 'ANDROID_HOST_IP_SELECTION_REQUIRED';
    error.hostIpCandidates = candidates;
    throw error;
  };
  interceptor._cleanupActivatedDevice = async () => assert.fail('old mode must not be cleaned');

  const result = await interceptor.activate(9090, {
    deviceId: DEVICE_ID,
    useHttpToolkitApp: false
  });

  assert.equal(result.success, false);
  assert.equal(result.metadata.requiresHostIpSelection, true);
  assert.deepEqual(result.metadata.hostIpCandidates, candidates);
  assert.equal(result.metadata.activatedDevices[0].mode, 'global-proxy');
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID), previous);
  assert.equal(journalText(interceptor), originalJournal);
  assert.equal(interceptor.active, true);
});

test('failed companion prerequisite and fallback preparation preserve the prior mode', async t => {
  const interceptor = new AndroidAdbInterceptor({ dataDir: createDataDir(t) });
  configureDevice(interceptor);
  const previous = rememberGlobalActivation(interceptor);
  const originalJournal = journalText(interceptor);
  let cleanupCalls = 0;
  let activationCalls = 0;
  interceptor._prepareHttpToolkitAppActivation = async () => ({
    success: false,
    appInstalled: false,
    error: 'companion app is unavailable'
  });
  interceptor._getHostIp = async () => '192.0.2.20';
  interceptor._getProxy = async () => ({ success: false, error: 'device read timed out' });
  interceptor._cleanupActivatedDevice = async () => { cleanupCalls += 1; return true; };
  interceptor._activateHttpToolkitApp = async () => { activationCalls += 1; return preparedCompanion(); };

  const result = await interceptor.activate(9090, {
    deviceId: DEVICE_ID,
    useHttpToolkitApp: true
  });

  assert.equal(result.success, false);
  assert.match(result.error, /Failed to read existing proxy.*device read timed out/);
  assert.equal(cleanupCalls, 0);
  assert.equal(activationCalls, 0);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID), previous);
  assert.equal(journalText(interceptor), originalJournal);
  assert.equal(interceptor.active, true);
});

test('thrown replacement preparation errors leave the prior mode intact', async t => {
  const interceptor = new AndroidAdbInterceptor({ dataDir: createDataDir(t) });
  configureDevice(interceptor);
  const previous = rememberGlobalActivation(interceptor);
  const originalJournal = journalText(interceptor);
  interceptor._prepareHttpToolkitAppActivation = async () => {
    throw new Error('package query unavailable');
  };
  interceptor._cleanupActivatedDevice = async () => assert.fail('old mode must not be cleaned');

  await assert.rejects(
    interceptor.activate(9090, { deviceId: DEVICE_ID, useHttpToolkitApp: true }),
    /package query unavailable/
  );

  assert.equal(interceptor.activatedDevices.get(DEVICE_ID), previous);
  assert.equal(journalText(interceptor), originalJournal);
  assert.equal(interceptor.active, true);
});

test('successful replacement prepares, cleans, then commits without overlapping modes', async t => {
  const interceptor = new AndroidAdbInterceptor({ dataDir: createDataDir(t) });
  configureDevice(interceptor);
  const previous = rememberGlobalActivation(interceptor);
  const events = [];
  interceptor._prepareHttpToolkitAppActivation = async () => {
    events.push('prepare');
    assert.equal(interceptor.activatedDevices.get(DEVICE_ID), previous);
    return preparedCompanion();
  };
  interceptor._cleanupActivatedDevice = async (_serial, info) => {
    events.push('cleanup');
    assert.equal(info, previous);
    return true;
  };
  interceptor._activateHttpToolkitApp = async (_serial, _port, preparation) => {
    events.push('commit');
    assert.equal(preparation.connectUrl, CONNECT_URL);
    assert.equal(interceptor.activatedDevices.get(DEVICE_ID).mode, 'app-uncertain');
    assert.equal(JSON.parse(journalText(interceptor)).devices[0].mode, 'app-uncertain');
    return { success: true, appInstalled: true, tunnelActive: true };
  };

  const result = await interceptor.activate(9090, {
    deviceId: DEVICE_ID,
    useHttpToolkitApp: true
  });

  assert.equal(result.success, true);
  assert.equal(result.metadata.mode, 'http-toolkit-app');
  assert.deepEqual(events, ['prepare', 'cleanup', 'commit']);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).mode, 'http-toolkit-app');
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).proxyPort, 9090);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});

test('same-port companion replacement prepares against the mapping restored by old cleanup', async t => {
  const interceptor = new AndroidAdbInterceptor({ dataDir: createDataDir(t) });
  configureDevice(interceptor);
  const previous = {
    mode: 'http-toolkit-app',
    proxyPort: OLD_PORT,
    model: 'Test Device',
    deviceName: 'test-device',
    tunnelActive: true,
    previousReverseMapping: PREVIOUS_MAPPING
  };
  interceptor.activatedDevices.set(DEVICE_ID, previous);
  interceptor.reverseTunnels.add(REVERSE_KEY);
  interceptor.previousReverseMappings.set(REVERSE_KEY, PREVIOUS_MAPPING);
  interceptor.active = true;
  interceptor._prepareHttpToolkitAppActivation = async () => ({
    ...preparedCompanion(),
    previousReverseMapping: `tcp:${OLD_PORT}`
  });
  interceptor._cleanupActivatedDevice = async () => {
    interceptor.reverseTunnels.delete(REVERSE_KEY);
    interceptor.previousReverseMappings.delete(REVERSE_KEY);
    return true;
  };
  interceptor._activateHttpToolkitApp = async (_serial, _port, preparation) => {
    assert.equal(preparation.previousReverseMapping, PREVIOUS_MAPPING);
    interceptor.reverseTunnels.add(REVERSE_KEY);
    interceptor.previousReverseMappings.set(REVERSE_KEY, preparation.previousReverseMapping);
    return { success: true, appInstalled: true, tunnelActive: true };
  };

  const result = await interceptor.activate(OLD_PORT, {
    deviceId: DEVICE_ID,
    useHttpToolkitApp: true
  });

  assert.equal(result.success, true);
  assert.equal(interceptor.previousReverseMappings.get(REVERSE_KEY), PREVIOUS_MAPPING);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).previousReverseMapping, PREVIOUS_MAPPING);
});

test('partial old-mode cleanup remains journaled and a replacement retry finishes it safely', async t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const interceptor = new AndroidAdbInterceptor({ dataDir: createDataDir(t) });
  configureDevice(interceptor);
  const previous = rememberGlobalActivation(interceptor, globalActivation({
    previousReverseMapping: PREVIOUS_MAPPING
  }));
  const originalJournal = journalText(interceptor);
  interceptor._prepareHttpToolkitAppActivation = async () => preparedCompanion();
  let currentProxy = OLD_PROXY;
  let proxyWrites = 0;
  let caAttempts = 0;
  let reverseRestores = 0;
  let replacementCommits = 0;
  interceptor._getProxy = async () => ({ success: true, value: currentProxy });
  interceptor._adb = async (_serial, args) => {
    if (args[0] === 'shell' && args[1] === 'settings' && args[2] === 'put') {
      proxyWrites += 1;
      currentProxy = args.at(-1);
    }
    if (args[0] === 'reverse') {
      reverseRestores += 1;
      assert.deepEqual(args, ['reverse', `tcp:${OLD_PORT}`, PREVIOUS_MAPPING]);
    }
    return '';
  };
  interceptor._removeCaCert = async () => {
    caAttempts += 1;
    return caAttempts > 1;
  };
  interceptor._activateHttpToolkitApp = async () => {
    replacementCommits += 1;
    return { success: true, appInstalled: true, tunnelActive: true };
  };

  await assert.rejects(
    interceptor.activate(9090, { deviceId: DEVICE_ID, useHttpToolkitApp: true }),
    /Could not clean up the existing Android interception/
  );

  assert.equal(currentProxy, PREVIOUS_PROXY);
  assert.equal(proxyWrites, 1);
  assert.equal(caAttempts, 1);
  assert.equal(reverseRestores, 0);
  assert.equal(replacementCommits, 0);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID), previous);
  assert.equal(journalText(interceptor), originalJournal);
  assert.equal(interceptor.reverseTunnels.has(REVERSE_KEY), true);

  const result = await interceptor.activate(9090, {
    deviceId: DEVICE_ID,
    useHttpToolkitApp: true
  });

  assert.equal(result.success, true);
  assert.equal(proxyWrites, 1, 'retry must not overwrite the already-restored proxy');
  assert.equal(caAttempts, 2);
  assert.equal(reverseRestores, 1);
  assert.equal(replacementCommits, 1);
  assert.equal(interceptor.reverseTunnels.has(REVERSE_KEY), false);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).mode, 'http-toolkit-app');
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});

test('ambiguous proxy commit replaces old ownership with retryable new ownership', async t => {
  t.mock.method(console, 'warn', () => {});
  const interceptor = new AndroidAdbInterceptor({ dataDir: createDataDir(t) });
  configureDevice(interceptor);
  rememberGlobalActivation(interceptor);
  const newHost = '192.0.2.20';
  let proxyReads = 0;
  interceptor._getHostIp = async () => newHost;
  interceptor._getProxy = async () => {
    proxyReads += 1;
    if (proxyReads === 1) return { success: true, value: OLD_PROXY };
    if (proxyReads === 2) return { success: true, value: PREVIOUS_PROXY };
    return { success: false, error: 'device disconnected after proxy write' };
  };
  interceptor._cleanupActivatedDevice = async () => true;
  interceptor._pushCaCert = async () => STAGED_CA_PATH;
  interceptor._setProxy = async () => false;

  const result = await interceptor.activate(9090, {
    deviceId: DEVICE_ID,
    useHttpToolkitApp: false,
    hostIp: newHost
  });

  assert.equal(result.success, false);
  assert.match(result.error, /could not verify whether it was applied/);
  assert.equal(proxyReads, 3);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).mode, 'proxy-uncertain');
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).hostIp, newHost);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).proxyPort, 9090);
  assert.deepEqual(JSON.parse(journalText(interceptor)).devices, [{
    serial: DEVICE_ID,
    mode: 'proxy-uncertain',
    previousProxy: PREVIOUS_PROXY,
    hostIp: newHost,
    proxyPort: 9090,
    remoteCertPath: STAGED_CA_PATH,
    model: 'Test Device',
    deviceName: 'test-device'
  }]);
});

test('ambiguous companion commit after old cleanup remains durable and blocks fallback', async t => {
  t.mock.method(console, 'warn', () => {});
  const dataDir = createDataDir(t);
  const interceptor = new AndroidAdbInterceptor({ dataDir });
  configureDevice(interceptor);
  rememberGlobalActivation(interceptor);
  interceptor._prepareHttpToolkitAppActivation = async () => preparedCompanion();
  interceptor._cleanupActivatedDevice = async () => true;
  const replacementKey = `${DEVICE_ID}:9090`;
  interceptor._activateHttpToolkitApp = async () => {
    interceptor.reverseTunnels.add(replacementKey);
    interceptor.previousReverseMappings.set(replacementKey, null);
    return {
      success: false,
      error: 'activation intent timed out',
      appInstalled: true,
      tunnelActive: true,
      previousReverseMapping: null
    };
  };
  interceptor._deactivateHttpToolkitApp = async () => false;
  interceptor._getHostIp = async () => assert.fail('uncertain companion state must block fallback');

  const result = await interceptor.activate(9090, {
    deviceId: DEVICE_ID,
    useHttpToolkitApp: true
  });

  assert.equal(result.success, false);
  assert.match(result.error, /retry Stop/);
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).mode, 'app-uncertain');
  assert.equal(interceptor.activatedDevices.get(DEVICE_ID).proxyPort, 9090);
  assert.deepEqual(JSON.parse(journalText(interceptor)).devices, [{
    serial: DEVICE_ID,
    mode: 'app-uncertain',
    proxyPort: 9090,
    previousReverseMapping: null,
    model: 'Test Device',
    deviceName: 'test-device'
  }]);

  const restarted = new AndroidAdbInterceptor({ dataDir });
  assert.equal(restarted.activatedDevices.get(DEVICE_ID).mode, 'app-uncertain');
  assert.equal(restarted.reverseTunnels.has(replacementKey), true);
  restarted._isHttpToolkitAppInstalled = async () => true;
  restarted._bringHttpToolkitAppToFront = async () => {};
  const commands = [];
  restarted._adb = async (_serial, args) => {
    commands.push(args);
    if (args[0] === 'shell' && args[1] === 'am') return 'Status: ok\n';
    return '';
  };

  await restarted.deactivate({ deviceId: DEVICE_ID });

  assert.deepEqual(commands.at(-1), ['reverse', '--remove', 'tcp:9090']);
  assert.equal(restarted.active, false);
  assert.equal(fs.existsSync(restarted.recoveryFile), false);
});

test('app-uncertain recovery rejects a missing prior reverse mapping', async t => {
  t.mock.method(console, 'warn', () => {});
  const dataDir = createDataDir(t);
  const recoveryFile = path.join(dataDir, 'android-adb-global-proxy-recovery.json');
  const malformedJournal = JSON.stringify({
    version: 3,
    devices: [{
      serial: DEVICE_ID,
      mode: 'app-uncertain',
      proxyPort: 9090,
      model: 'Test Device',
      deviceName: 'test-device'
    }]
  });
  fs.writeFileSync(recoveryFile, malformedJournal, 'utf8');

  const interceptor = new AndroidAdbInterceptor({ dataDir });

  assert.equal(interceptor.active, false);
  assert.equal(interceptor.activatedDevices.size, 0);
  assert.equal(interceptor.reverseTunnels.size, 0);
  assert.equal(fs.readFileSync(recoveryFile, 'utf8'), malformedJournal);
});

test('ambiguous prepared reverse creation retains its prior mapping for cleanup', async t => {
  t.mock.method(console, 'warn', () => {});
  const interceptor = new AndroidAdbInterceptor();
  let calls = 0;
  interceptor._adb = async () => {
    calls += 1;
    throw new Error(calls === 1 ? 'reverse write timed out' : 'device disconnected');
  };

  assert.equal(await interceptor._createReverseTunnel(DEVICE_ID, OLD_PORT, PREVIOUS_MAPPING), true);
  assert.equal(calls, 2);
  assert.equal(interceptor.reverseTunnels.has(REVERSE_KEY), true);
  assert.equal(interceptor.previousReverseMappings.get(REVERSE_KEY), PREVIOUS_MAPPING);
});
