import assert from 'node:assert/strict';
import test from 'node:test';
import { AndroidAdbInterceptor } from '../src/interceptors/android-adb-interceptor.js';

test('Android companion restores a reverse mapping replaced during activation', async () => {
  const interceptor = new AndroidAdbInterceptor();
  const calls = [];
  interceptor._adb = async (_deviceId, args) => {
    calls.push(args);
    if (args[1] === '--list') return 'device-1 tcp:8080 tcp:9000\n';
    return '';
  };

  assert.equal(await interceptor._createReverseTunnel('device-1', 8080), true);
  assert.deepEqual(calls, [
    ['reverse', '--list'],
    ['reverse', 'tcp:8080', 'tcp:8080']
  ]);

  assert.equal(await interceptor._removeReverseTunnel('device-1', 8080), true);
  assert.deepEqual(calls.at(-1), ['reverse', 'tcp:8080', 'tcp:9000']);
  assert.equal(interceptor.reverseTunnels.has('device-1:8080'), false);
});

test('Android companion uses no-rebind for a previously unused reverse port', async () => {
  const interceptor = new AndroidAdbInterceptor();
  const calls = [];
  interceptor._adb = async (_deviceId, args) => {
    calls.push(args);
    return '';
  };

  assert.equal(await interceptor._createReverseTunnel('device-1', 8080), true);
  assert.deepEqual(calls.at(-1), ['reverse', '--no-rebind', 'tcp:8080', 'tcp:8080']);

  assert.equal(await interceptor._removeReverseTunnel('device-1', 8080), true);
  assert.deepEqual(calls.at(-1), ['reverse', '--remove', 'tcp:8080']);
});

test('Android companion leaves an identical pre-existing reverse mapping untouched', async () => {
  const interceptor = new AndroidAdbInterceptor();
  const calls = [];
  interceptor._adb = async (_deviceId, args) => {
    calls.push(args);
    return 'device-1 tcp:8080 tcp:8080\n';
  };

  assert.equal(await interceptor._createReverseTunnel('device-1', 8080), true);
  assert.equal(await interceptor._removeReverseTunnel('device-1', 8080), true);
  assert.deepEqual(calls, [['reverse', '--list']]);
});

test('Android companion does not rebind when existing mappings cannot be read', async () => {
  const interceptor = new AndroidAdbInterceptor();
  const calls = [];
  interceptor._adb = async (_deviceId, args) => {
    calls.push(args);
    throw new Error('device offline');
  };

  assert.equal(await interceptor._createReverseTunnel('device-1', 8080), false);
  assert.deepEqual(calls, [['reverse', '--list']]);
  assert.equal(interceptor.reverseTunnels.has('device-1:8080'), false);
});
