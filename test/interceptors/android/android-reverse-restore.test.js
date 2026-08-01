import assert from 'node:assert/strict';
import test from 'node:test';
import { AndroidAdbInterceptor } from '../../../src/interceptors/android-adb-interceptor.js';

test('Android companion refuses to replace an occupied reverse port', async () => {
  const interceptor = new AndroidAdbInterceptor();
  const calls = [];
  let mapping = 'tcp:9000';
  interceptor._adb = async (_deviceId, args) => {
    calls.push(args);
    if (args[1] === '--list') {
      return mapping ? `device-1 tcp:8080 ${mapping}\n` : '';
    }
    if (args[0] === 'reverse') mapping = args[1] === '--remove' ? null : args[2];
    return '';
  };

  assert.equal(await interceptor._createReverseTunnel('device-1', 8080), false);
  assert.equal(await interceptor._removeReverseTunnel('device-1', 8080), true);
  assert.equal(mapping, 'tcp:9000');
  assert.deepEqual(calls, [['reverse', '--list']]);
  assert.equal(interceptor.reverseTunnels.has('device-1:8080'), false);
});

test('Android companion uses no-rebind for a previously unused reverse port', async () => {
  const interceptor = new AndroidAdbInterceptor();
  const calls = [];
  let mapping = null;
  interceptor._adb = async (_deviceId, args) => {
    calls.push(args);
    if (args[1] === '--list') {
      return mapping ? `device-1 tcp:8080 ${mapping}\n` : '';
    }
    if (args[0] === 'reverse') mapping = args[1] === '--remove' ? null : args[3];
    return '';
  };

  assert.equal(await interceptor._createReverseTunnel('device-1', 8080), true);
  assert.deepEqual(calls.at(-1), ['reverse', '--no-rebind', 'tcp:8080', 'tcp:8080']);

  assert.equal(await interceptor._removeReverseTunnel('device-1', 8080), true);
  assert.deepEqual(calls.slice(-2), [
    ['reverse', '--list'],
    ['reverse', '--remove', 'tcp:8080']
  ]);
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

test('Android companion removes its new mapping after an applied no-rebind command times out', async () => {
  const interceptor = new AndroidAdbInterceptor();
  const calls = [];
  let mapping = null;
  let replacementTimedOut = false;
  interceptor._adb = async (_deviceId, args) => {
    calls.push(args);
    if (args[1] === '--list') {
      return mapping ? `device-1 tcp:8080 ${mapping}\n` : '';
    }
    if (args[0] === 'reverse') {
      mapping = args[1] === '--remove' ? null : args.at(-1);
      if (!replacementTimedOut && mapping === 'tcp:8080') {
        replacementTimedOut = true;
        throw new Error('ADB reverse timed out after applying the mapping');
      }
    }
    return '';
  };

  assert.equal(await interceptor._createReverseTunnel('device-1', 8080), true);
  assert.equal(mapping, 'tcp:8080');
  assert.equal(interceptor.reverseTunnels.has('device-1:8080'), true);
  assert.equal(interceptor.previousReverseMappings.get('device-1:8080'), null);

  assert.equal(await interceptor._removeReverseTunnel('device-1', 8080), true);
  assert.equal(mapping, null);
  assert.deepEqual(calls, [
    ['reverse', '--list'],
    ['reverse', '--no-rebind', 'tcp:8080', 'tcp:8080'],
    ['reverse', '--list'],
    ['reverse', '--list'],
    ['reverse', '--remove', 'tcp:8080']
  ]);
  assert.equal(interceptor.reverseTunnels.has('device-1:8080'), false);
});

test('Android companion preserves a mapping changed after preparation', async () => {
  const interceptor = new AndroidAdbInterceptor();
  const calls = [];
  interceptor._adb = async (_deviceId, args) => {
    calls.push(args);
    return '';
  };

  // Preparation observed tcp:9000, but another workflow changed the mapping
  // before commit. Occupied ports are never rebound, so neither value can be
  // overwritten by this stale snapshot.
  assert.equal(
    await interceptor._createReverseTunnel('device-1', 8080, 'tcp:9000'),
    false
  );
  assert.deepEqual(calls, []);
  assert.equal(interceptor.reverseTunnels.has('device-1:8080'), false);
  assert.equal(interceptor.previousReverseMappings.has('device-1:8080'), false);
});
