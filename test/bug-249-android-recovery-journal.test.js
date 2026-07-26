import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AndroidAdbInterceptor } from '../src/interceptors/android-adb-interceptor.js';
import { InterceptorManager } from '../src/interceptors/interceptor-manager.js';

const STAGED_CA_PATH = '/data/local/tmp/http-freekit-ca.pem';

function createDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-android-recovery-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function device(serial, model = serial) {
  return { serial, status: 'device', model, deviceName: `${serial}-device` };
}

function configureGlobalActivation(interceptor, devices, previousProxies = {}) {
  interceptor._getConnectedDevices = async () => devices;
  interceptor._getQrMetadata = async () => ({});
  interceptor._getHostIp = async serial => serial === 'device-2' ? '192.0.2.11' : '192.0.2.10';
  interceptor._getProxy = async serial => ({
    success: true,
    value: previousProxies[serial] ?? 'null'
  });
  interceptor._pushCaCert = async () => STAGED_CA_PATH;
  interceptor._setProxy = async () => true;
}

function readJournal(interceptor) {
  return JSON.parse(fs.readFileSync(interceptor.recoveryFile, 'utf8'));
}

function validJournalEntry(overrides = {}) {
  return {
    serial: 'device-1',
    mode: 'global-proxy',
    previousProxy: 'corporate.proxy:8888',
    hostIp: '192.0.2.10',
    proxyPort: 8080,
    remoteCertPath: STAGED_CA_PATH,
    model: 'Test Device',
    deviceName: 'test-device',
    ...overrides
  };
}

test('a restarted manager adopts global-proxy cleanup ownership and can Stop it', async t => {
  const dataDir = createDataDir(t);
  const original = new AndroidAdbInterceptor({ dataDir });
  configureGlobalActivation(original, [device('device-1', 'Test Device')], {
    'device-1': 'corporate.proxy:8888'
  });

  const activation = await original.activate(8080, {
    deviceId: 'device-1',
    useHttpToolkitApp: false
  });
  assert.equal(activation.success, true);
  assert.deepEqual(readJournal(original), {
    version: 1,
    devices: [validJournalEntry({ deviceName: 'device-1-device' })]
  });

  // Simulate a hard restart: construct a new manager without cleaning the old instance.
  const restartedManager = new InterceptorManager(null, { dataDir });
  const restarted = restartedManager.interceptors.get('android-adb');
  assert.equal(await restarted.isActive(), true);
  assert.equal(restarted.toJSON().active, true);
  restarted._getConnectedDevices = async () => [];
  const metadata = await restarted.getMetadata();
  assert.equal(metadata.activatedDevices.length, 1);
  assert.equal(metadata.activatedDevices[0].serial, 'device-1');
  assert.equal(metadata.activatedDevices[0].recovered, true);

  const cleanupCalls = [];
  restarted._restoreProxy = async (serial, previousProxy) => {
    cleanupCalls.push(['proxy', serial, previousProxy]);
    return true;
  };
  restarted._removeCaCert = async serial => {
    cleanupCalls.push(['ca', serial]);
    return true;
  };
  await restartedManager.deactivate('android-adb', { deviceId: 'device-1' });

  assert.deepEqual(cleanupCalls, [
    ['proxy', 'device-1', 'corporate.proxy:8888'],
    ['ca', 'device-1']
  ]);
  assert.equal(await restarted.isActive(), false);
  assert.equal(fs.existsSync(restarted.recoveryFile), false);
});

test('normal multi-device cleanup updates and then removes the journal', async t => {
  const interceptor = new AndroidAdbInterceptor({ dataDir: createDataDir(t) });
  configureGlobalActivation(interceptor, [device('device-1'), device('device-2')], {
    'device-1': 'first.proxy:8001',
    'device-2': 'second.proxy:8002'
  });

  await interceptor.activate(8080, { deviceId: 'device-1', useHttpToolkitApp: false });
  await interceptor.activate(9090, { deviceId: 'device-2', useHttpToolkitApp: false });
  assert.deepEqual(readJournal(interceptor).devices.map(entry => entry.serial), [
    'device-1',
    'device-2'
  ]);

  const restored = [];
  interceptor._restoreProxy = async (serial, previousProxy) => {
    restored.push([serial, previousProxy]);
    return true;
  };
  interceptor._removeCaCert = async () => true;

  await interceptor.deactivate({ deviceId: 'device-1' });
  assert.deepEqual(readJournal(interceptor).devices.map(entry => entry.serial), ['device-2']);
  assert.equal(interceptor.active, true);

  await interceptor.deactivate();
  assert.deepEqual(restored, [
    ['device-1', 'first.proxy:8001'],
    ['device-2', 'second.proxy:8002']
  ]);
  assert.equal(interceptor.active, false);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
  assert.deepEqual(
    fs.readdirSync(path.dirname(interceptor.recoveryFile)).filter(name => name.endsWith('.tmp')),
    []
  );
});

test('failed cleanup remains journaled and can be adopted for a later retry', async t => {
  const dataDir = createDataDir(t);
  const original = new AndroidAdbInterceptor({ dataDir });
  configureGlobalActivation(original, [device('device-1')], {
    'device-1': 'corporate.proxy:8888'
  });
  await original.activate(8080, { deviceId: 'device-1', useHttpToolkitApp: false });

  const firstRestart = new AndroidAdbInterceptor({ dataDir });
  firstRestart._restoreProxy = async () => false;
  firstRestart._removeCaCert = async () => true;
  await assert.rejects(
    firstRestart.deactivate({ deviceId: 'device-1' }),
    /reconnect it and retry Stop/
  );
  assert.equal(firstRestart.active, true);
  assert.equal(firstRestart.activatedDevices.has('device-1'), true);
  assert.equal(fs.existsSync(firstRestart.recoveryFile), true);

  const secondRestart = new AndroidAdbInterceptor({ dataDir });
  const restored = [];
  secondRestart._restoreProxy = async (serial, previousProxy) => {
    restored.push([serial, previousProxy]);
    return true;
  };
  secondRestart._removeCaCert = async () => true;
  await secondRestart.deactivate({ deviceId: 'device-1' });

  assert.deepEqual(restored, [['device-1', 'corporate.proxy:8888']]);
  assert.equal(secondRestart.active, false);
  assert.equal(fs.existsSync(secondRestart.recoveryFile), false);
});

test('malformed or untrusted journals are not adopted or used for device commands', async t => {
  t.mock.method(console, 'warn', () => {});
  const dataDir = createDataDir(t);
  const recoveryFile = path.join(dataDir, 'android-adb-global-proxy-recovery.json');
  const invalidJournals = [
    '{not-json',
    JSON.stringify({ version: 2, devices: [validJournalEntry()] }),
    JSON.stringify({
      version: 1,
      devices: [validJournalEntry(), validJournalEntry({ serial: '--all' })]
    }),
    JSON.stringify({
      version: 1,
      devices: [validJournalEntry({ previousProxy: { host: 'unsafe' } })]
    }),
    JSON.stringify({ version: 1, devices: [validJournalEntry()], unexpected: true })
  ];

  for (const journal of invalidJournals) {
    fs.writeFileSync(recoveryFile, journal, 'utf8');
    const interceptor = new AndroidAdbInterceptor({ dataDir });
    let commandCount = 0;
    interceptor._restoreProxy = async () => { commandCount += 1; return true; };
    interceptor._removeCaCert = async () => { commandCount += 1; return true; };

    assert.equal(await interceptor.isActive(), false);
    assert.equal(interceptor.activatedDevices.size, 0);
    await interceptor.deactivate();
    assert.equal(commandCount, 0);
    assert.equal(fs.existsSync(recoveryFile), true);
  }
});

test('journal persistence failure aborts before CA or proxy mutation', async t => {
  const interceptor = new AndroidAdbInterceptor({ dataDir: createDataDir(t) });
  configureGlobalActivation(interceptor, [device('device-1')]);
  fs.mkdirSync(interceptor.recoveryFile);
  let mutationCount = 0;
  interceptor._pushCaCert = async () => {
    mutationCount += 1;
    return STAGED_CA_PATH;
  };
  interceptor._setProxy = async () => {
    mutationCount += 1;
    return true;
  };

  await assert.rejects(
    interceptor.activate(8080, { deviceId: 'device-1', useHttpToolkitApp: false })
  );
  assert.equal(mutationCount, 0);
  assert.equal(interceptor.activatedDevices.size, 0);
  assert.equal(interceptor.active, false);
  assert.deepEqual(
    fs.readdirSync(path.dirname(interceptor.recoveryFile)).filter(name => name.endsWith('.tmp')),
    []
  );
});

test('HTTP Toolkit app activation remains in-memory and does not create the global journal', async t => {
  const interceptor = new AndroidAdbInterceptor({ dataDir: createDataDir(t) });
  interceptor._getConnectedDevices = async () => [device('device-1')];
  interceptor._getQrMetadata = async () => ({});
  interceptor._activateHttpToolkitApp = async () => ({
    success: true,
    appInstalled: true,
    tunnelActive: true
  });
  interceptor._getHostIp = async () => assert.fail('global fallback must not run');

  const result = await interceptor.activate(8080, {
    deviceId: 'device-1',
    useHttpToolkitApp: true
  });
  assert.equal(result.success, true);
  assert.equal(interceptor.activatedDevices.get('device-1').mode, 'http-toolkit-app');
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);

  interceptor._deactivateHttpToolkitApp = async () => true;
  await interceptor.deactivate({ deviceId: 'device-1' });
  assert.equal(interceptor.active, false);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});
