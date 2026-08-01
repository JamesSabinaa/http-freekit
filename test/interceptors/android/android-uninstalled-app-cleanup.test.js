import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AndroidAdbInterceptor } from '../../../src/interceptors/android-adb-interceptor.js';

const DEVICE_ID = 'device-1';
const PROXY_PORT = 8302;
const TUNNEL_KEY = `${DEVICE_ID}:${PROXY_PORT}`;
const PACKAGE_NAME = 'tech.httptoolkit.android.v1';

function createDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-302-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function configureActiveCompanion(interceptor, previousMapping = null) {
  interceptor.activatedDevices.set(DEVICE_ID, {
    mode: 'http-toolkit-app',
    proxyPort: PROXY_PORT,
    tunnelActive: true
  });
  interceptor.reverseTunnels.add(TUNNEL_KEY);
  interceptor.previousReverseMappings.set(TUNNEL_KEY, previousMapping);
  interceptor._getReverseMapping = async () => `tcp:${PROXY_PORT}`;
  interceptor.active = true;
}

test('installed companion app follows normal deactivation and restores the reverse mapping', async t => {
  t.mock.method(console, 'log', () => {});
  const interceptor = new AndroidAdbInterceptor();
  configureActiveCompanion(interceptor, 'tcp:9302');
  const commands = [];
  interceptor._adb = async (_deviceId, args) => {
    commands.push(args);
    if (args[0] === 'shell' && args[1] === 'pm') {
      return 'package:/data/app/tech.httptoolkit.android.v1/base.apk\n';
    }
    if (args[0] === 'shell' && args[1] === 'am') {
      return 'Starting: Intent { act=tech.httptoolkit.android.DEACTIVATE }\nStatus: ok\n';
    }
    return '';
  };

  await interceptor.deactivate({ deviceId: DEVICE_ID });

  assert.deepEqual(commands, [
    ['shell', 'pm', 'path', PACKAGE_NAME],
    ['shell', 'monkey', '-p', PACKAGE_NAME, '1'],
    ['shell', 'am', 'start', '-W', '-a', 'tech.httptoolkit.android.DEACTIVATE'],
    ['reverse', `tcp:${PROXY_PORT}`, 'tcp:9302']
  ]);
  assert.equal(interceptor.activatedDevices.has(DEVICE_ID), false);
  assert.equal(interceptor.reverseTunnels.has(TUNNEL_KEY), false);
  assert.equal(interceptor.previousReverseMappings.has(TUNNEL_KEY), false);
  assert.equal(interceptor.active, false);
});

test('confirmed uninstalled companion plus successful tunnel cleanup clears owned state', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = createDataDir(t);
  const interceptor = new AndroidAdbInterceptor({ dataDir });
  configureActiveCompanion(interceptor);
  const commands = [];
  interceptor._adb = async (_deviceId, args) => {
    commands.push(args);
    if (args[0] === 'shell' && args[1] === 'pm') return '';
    return '';
  };

  await interceptor.deactivate({ deviceId: DEVICE_ID });

  assert.deepEqual(commands, [
    ['shell', 'pm', 'path', PACKAGE_NAME],
    ['reverse', '--remove', `tcp:${PROXY_PORT}`]
  ]);
  assert.equal(interceptor.activatedDevices.size, 0);
  assert.equal(interceptor.reverseTunnels.size, 0);
  assert.equal(interceptor.previousReverseMappings.size, 0);
  assert.equal(interceptor.journaledGlobalDevices.size, 0);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
  assert.equal(interceptor.active, false);
});

test('confirmed absent package with failed tunnel cleanup retains all retryable ownership', async t => {
  t.mock.method(console, 'warn', () => {});
  const interceptor = new AndroidAdbInterceptor();
  configureActiveCompanion(interceptor, 'tcp:9302');
  const commands = [];
  interceptor._adb = async (_deviceId, args) => {
    commands.push(args);
    if (args[0] === 'shell' && args[1] === 'pm') return '';
    throw new Error('reverse mapping restore failed');
  };

  await assert.rejects(
    interceptor.deactivate({ deviceId: DEVICE_ID }),
    /reconnect it and retry Stop/
  );

  assert.deepEqual(commands, [
    ['shell', 'pm', 'path', PACKAGE_NAME],
    ['reverse', `tcp:${PROXY_PORT}`, 'tcp:9302']
  ]);
  assert.equal(interceptor.activatedDevices.has(DEVICE_ID), true);
  assert.equal(interceptor.reverseTunnels.has(TUNNEL_KEY), true);
  assert.equal(interceptor.previousReverseMappings.get(TUNNEL_KEY), 'tcp:9302');
  assert.equal(interceptor.active, true);
});

test('device and package-query failures remain real failures without touching the tunnel', async t => {
  t.mock.method(console, 'warn', () => {});
  const failures = [
    {
      name: 'device offline',
      query: async () => { throw new Error('adb: device offline'); }
    },
    {
      name: 'permission denied',
      query: async () => { throw new Error('package manager permission denied'); }
    },
    {
      name: 'unexpected package query response',
      query: async () => 'Error: package manager unavailable'
    }
  ];

  for (const failure of failures) {
    const interceptor = new AndroidAdbInterceptor();
    configureActiveCompanion(interceptor);
    const commands = [];
    interceptor._adb = async (_deviceId, args) => {
      commands.push(args);
      if (args[0] !== 'shell' || args[1] !== 'pm') {
        assert.fail(`${failure.name} must not touch the reverse tunnel`);
      }
      return await failure.query();
    };

    await assert.rejects(
      interceptor.deactivate({ deviceId: DEVICE_ID }),
      /reconnect it and retry Stop/,
      failure.name
    );
    assert.deepEqual(commands, [['shell', 'pm', 'path', PACKAGE_NAME]], failure.name);
    assert.equal(interceptor.activatedDevices.has(DEVICE_ID), true, failure.name);
    assert.equal(interceptor.reverseTunnels.has(TUNNEL_KEY), true, failure.name);
    assert.equal(interceptor.previousReverseMappings.has(TUNNEL_KEY), true, failure.name);
    assert.equal(interceptor.active, true, failure.name);
  }
});
