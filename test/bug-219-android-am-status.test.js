import assert from 'node:assert/strict';
import test from 'node:test';

import { AndroidAdbInterceptor } from '../src/interceptors/android-adb-interceptor.js';

const deviceId = 'device-1';
const proxyPort = 8080;
const tunnelKey = `${deviceId}:${proxyPort}`;

function appInterceptor() {
  const interceptor = new AndroidAdbInterceptor();
  interceptor.ca = {
    getCertInfo: () => ({ certificateSpkiFingerprint: 'test-spki' })
  };
  interceptor._isHttpToolkitAppInstalled = async () => true;
  interceptor._bringHttpToolkitAppToFront = async () => {};
  interceptor._buildHttpToolkitConnectUrl = () => 'https://android.httptoolkit.tech/connect/?data=test';
  return interceptor;
}

test('zero-exit Android activation timeout fails and removes its new reverse tunnel', async () => {
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
  assert.equal(result.tunnelActive, false);
  assert.equal(interceptor.reverseTunnels.has(tunnelKey), false);
  assert.equal(interceptor.previousReverseMappings.has(tunnelKey), false);
  assert.deepEqual(commands.filter(args => args[0] === 'reverse'), [
    ['reverse', '--list'],
    ['reverse', '--no-rebind', 'tcp:8080', 'tcp:8080'],
    ['reverse', '--remove', 'tcp:8080']
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
    deactivation._adb = async () => output;
    assert.equal(await deactivation._deactivateHttpToolkitApp(deviceId, proxyPort), true, output);
    assert.equal(tunnelRemovalCalls, 1, output);
  }
});
