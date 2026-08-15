import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AndroidAdbInterceptor } from '../../../src/interceptors/android-adb-interceptor.js';

const deviceId = 'device-1';
const proxyPort = 8080;
const tunnelKey = `${deviceId}:${proxyPort}`;

function appInterceptor(options = {}) {
  const interceptor = new AndroidAdbInterceptor(options);
  interceptor.ca = {
    getCertInfo: () => ({ certificateSpkiFingerprint: 'test-spki' })
  };
  interceptor._isHttpToolkitAppInstalled = async () => true;
  interceptor._bringHttpToolkitAppToFront = async () => {};
  interceptor._buildHttpToolkitConnectUrl = () => 'https://android.httptoolkit.tech/connect/?data=test';
  return interceptor;
}

function activeAppInterceptor(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-397-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const interceptor = appInterceptor({ dataDir });
  const activeInfo = {
    mode: 'http-toolkit-app',
    proxyPort,
    tunnelActive: true,
    vpnStatusConfirmed: true,
    previousReverseMapping: null
  };
  interceptor._rememberGlobalProxyOwnership(deviceId, activeInfo);
  interceptor.activatedDevices.set(deviceId, activeInfo);
  interceptor.reverseTunnels.add(tunnelKey);
  interceptor.previousReverseMappings.set(tunnelKey, null);
  interceptor.active = true;
  return interceptor;
}

test('zero-exit Android activation timeout fails and retains its reverse tunnel for transactional cleanup', async () => {
  const interceptor = appInterceptor();
  const commands = [];
  interceptor._adb = async (_deviceId, args) => {
    commands.push(args);
    if (args[0] === 'reverse' && args[1] === '--list') return '';
    if (args[0] === 'shell' && args[1] === 'am') {
      return 'Starting: Intent { act=tech.httptoolkit.android.ACTIVATE }\nStatus: timeout\nWaitTime: 10000\n';
    }
    return '';
  };

  const result = await interceptor._activateHttpToolkitApp(deviceId, proxyPort);

  assert.equal(result.success, false);
  assert.match(result.error, /Status: timeout/);
  assert.equal(result.tunnelActive, true);
  assert.equal(interceptor.reverseTunnels.has(tunnelKey), true);
  assert.equal(interceptor.previousReverseMappings.get(tunnelKey), null);
  assert.deepEqual(commands.filter(args => args[0] === 'reverse'), [
    ['reverse', '--list'],
    ['reverse', '--no-rebind', 'tcp:8080', 'tcp:8080']
  ]);
});

test('deactivation timeout and errors retain device and tunnel ownership for retry', async t => {
  t.mock.method(console, 'warn', () => {});
  const failures = [
    { name: 'timeout status', output: 'Status: timeout\nWaitTime: 10000\n' },
    { name: 'error status', output: 'Status: Error\nError: Activity not started\n' },
    { name: 'command error', error: new Error('device offline') }
  ];

  for (const failure of failures) {
    const interceptor = appInterceptor();
    interceptor.reverseTunnels.add(tunnelKey);
    interceptor.previousReverseMappings.set(tunnelKey, null);
    interceptor.activatedDevices.set(deviceId, {
      mode: 'http-toolkit-app',
      proxyPort,
      tunnelActive: true
    });
    interceptor.active = true;
    const commands = [];
    interceptor._adb = async (_deviceId, args) => {
      commands.push(args);
      if (args[0] === 'reverse') assert.fail(`${failure.name} must not remove the reverse tunnel`);
      if (failure.error) throw failure.error;
      return failure.output;
    };

    await assert.rejects(
      interceptor.deactivate({ deviceId }),
      /reconnect it and retry Stop/,
      failure.name
    );

    assert.equal(interceptor.activatedDevices.has(deviceId), true, failure.name);
    assert.equal(interceptor.reverseTunnels.has(tunnelKey), true, failure.name);
    assert.equal(interceptor.previousReverseMappings.has(tunnelKey), true, failure.name);
    assert.equal(interceptor.active, true, failure.name);
    assert.equal(commands.filter(args => args[0] === 'reverse').length, 0, failure.name);
  }
});

test('compatible successful am start status variants still activate and deactivate', async () => {
  const outputs = [
    'Starting: Intent { act=test }\nStatus: ok\nLaunchState: COLD\nComplete\n',
    'Starting: Intent { act=test }\r\n  Status : OK  \r\nActivity: test/.MainActivity\r\n'
  ];

  for (const output of outputs) {
    const activation = appInterceptor();
    activation._createReverseTunnel = async () => true;
    activation._removeReverseTunnel = async () => assert.fail('successful activation must retain the tunnel');
    activation._adb = async () => output;
    const activationResult = await activation._activateHttpToolkitApp(deviceId, proxyPort);
    assert.equal(activationResult.success, true, output);
    assert.equal(activationResult.tunnelActive, true, output);

    const deactivation = appInterceptor();
    deactivation.reverseTunnels.add(tunnelKey);
    let tunnelRemovalCalls = 0;
    deactivation._removeReverseTunnel = async () => {
      tunnelRemovalCalls++;
      return true;
    };
    deactivation._getHttpToolkitVpnStatus = async () => ({ success: true, value: false });
    deactivation._adb = async () => output;
    assert.equal(await deactivation._deactivateHttpToolkitApp(deviceId, proxyPort), true, output);
    assert.equal(tunnelRemovalCalls, 1, output);
  }
});

test('successful deactivation activity launch retains ownership while the VPN remains active', async t => {
  t.mock.method(console, 'warn', () => {});
  const interceptor = activeAppInterceptor(t);
  interceptor._adb = async () => 'Status: ok\n';
  interceptor._sleep = async () => {};
  let statusReads = 0;
  interceptor._getHttpToolkitVpnStatus = async () => {
    statusReads++;
    return { success: true, value: true };
  };
  interceptor._removeReverseTunnel = async () => {
    assert.fail('an active VPN must keep the reverse tunnel');
  };

  await assert.rejects(
    interceptor.deactivate({ deviceId }),
    /reconnect it and retry Stop/
  );

  assert.equal(statusReads, 5, 'VPN confirmation polling is bounded');
  assert.equal(interceptor.activatedDevices.has(deviceId), true);
  assert.equal(interceptor.reverseTunnels.has(tunnelKey), true);
  assert.equal(interceptor.previousReverseMappings.has(tunnelKey), true);
  assert.equal(interceptor.journaledGlobalDevices.has(deviceId), true);
  assert.equal(fs.existsSync(interceptor.recoveryFile), true);
  assert.equal(interceptor.active, true);
});

test('deactivation waits for eventual VPN inactivity before removing ownership', async t => {
  const interceptor = activeAppInterceptor(t);
  interceptor._adb = async () => 'Status: ok\n';
  let sleeps = 0;
  interceptor._sleep = async () => { sleeps++; };
  const vpnStates = [true, true, false];
  let statusReads = 0;
  interceptor._getHttpToolkitVpnStatus = async () => ({
    success: true,
    value: vpnStates[statusReads++]
  });
  let tunnelRemovalCalls = 0;
  interceptor._removeReverseTunnel = async () => {
    tunnelRemovalCalls++;
    interceptor.reverseTunnels.delete(tunnelKey);
    interceptor.previousReverseMappings.delete(tunnelKey);
    return true;
  };

  await interceptor.deactivate({ deviceId });

  assert.equal(statusReads, 3);
  assert.equal(sleeps, 2);
  assert.equal(tunnelRemovalCalls, 1);
  assert.equal(interceptor.activatedDevices.size, 0);
  assert.equal(interceptor.reverseTunnels.size, 0);
  assert.equal(interceptor.previousReverseMappings.size, 0);
  assert.equal(interceptor.journaledGlobalDevices.size, 0);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
  assert.equal(interceptor.active, false);
});

test('VPN status query failure retains retryable ownership without touching the tunnel', async t => {
  t.mock.method(console, 'warn', () => {});
  const interceptor = activeAppInterceptor(t);
  const statusQueries = [];
  interceptor._adb = async (_deviceId, args) => {
    if (args[0] === 'shell' && args[1] === 'am') return 'Status: ok\n';
    if (args[0] === 'shell' && args[1] === 'dumpsys') {
      statusQueries.push(args[2]);
      throw new Error('VPN status unavailable');
    }
    assert.fail(`unexpected ADB command: ${args.join(' ')}`);
  };
  interceptor._removeReverseTunnel = async () => {
    assert.fail('an unknown VPN state must keep the reverse tunnel');
  };

  await assert.rejects(
    interceptor.deactivate({ deviceId }),
    /reconnect it and retry Stop/
  );

  assert.deepEqual(statusQueries, ['vpn_management', 'connectivity']);
  assert.equal(interceptor.activatedDevices.has(deviceId), true);
  assert.equal(interceptor.reverseTunnels.has(tunnelKey), true);
  assert.equal(interceptor.previousReverseMappings.has(tunnelKey), true);
  assert.equal(interceptor.journaledGlobalDevices.has(deviceId), true);
  assert.equal(fs.existsSync(interceptor.recoveryFile), true);
  assert.equal(interceptor.active, true);
});
