import assert from 'node:assert/strict';
import test from 'node:test';
import { JvmInterceptor } from '../../../src/interceptors/jvm-interceptor.js';

test('missing optional jps stays quiet and preserves tracked JVM ownership', async t => {
  const interceptor = new JvmInterceptor();
  const errors = t.mock.method(console, 'error', () => {});
  interceptor.active = true;
  interceptor.activatedProcesses.set('101', { name: 'Unknown', mainClass: 'example.Unknown' });
  interceptor._runProcessListCommand = async () => {
    throw Object.assign(new Error('spawn jps ENOENT'), { code: 'ENOENT' });
  };

  assert.equal(await interceptor.isActive(), true);
  assert.deepEqual((await interceptor.getMetadata()).processes, []);
  assert.equal(interceptor.processDiscoveryFailed, true);
  assert.equal(interceptor.activatedProcesses.has('101'), true);
  assert.equal(errors.mock.callCount(), 0);
});

test('JPS failures are reported once until recovery, and new failures remain visible', async t => {
  const interceptor = new JvmInterceptor();
  const errors = t.mock.method(console, 'error', () => {});
  let failure = Object.assign(new Error('query timed out'), { code: 'ETIMEDOUT' });
  interceptor._runProcessListCommand = async () => {
    if (failure) throw failure;
    return '101 example.Main\n102 sun.tools.jps.Jps\n';
  };
  await interceptor._getRunningProcesses();
  await interceptor._getRunningProcesses();
  assert.equal(errors.mock.callCount(), 1);
  failure = Object.assign(new Error('access denied'), { code: 'EACCES' });
  await interceptor._getRunningProcesses();
  assert.equal(errors.mock.callCount(), 2);
  failure = null;
  assert.equal((await interceptor._getRunningProcesses())[0].mainClass, 'example.Main');
  assert.equal(interceptor.processDiscoveryFailed, false);
  failure = Object.assign(new Error('access denied'), { code: 'EACCES' });
  await interceptor._getRunningProcesses();
  assert.equal(errors.mock.callCount(), 3);
});
