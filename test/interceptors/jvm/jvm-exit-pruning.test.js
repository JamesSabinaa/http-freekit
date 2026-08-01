import assert from 'node:assert/strict';
import test from 'node:test';
import { JvmInterceptor } from '../../../src/interceptors/jvm-interceptor.js';

test('JVM refresh prunes exited and reused process IDs', async () => {
  const interceptor = new JvmInterceptor();
  interceptor.active = true;
  interceptor.activatedProcesses.set('101', { name: 'Exited', mainClass: 'example.Exited' });
  interceptor.activatedProcesses.set('202', { name: 'Running', mainClass: 'example.Running' });
  interceptor.activatedProcesses.set('303', { name: 'Old', mainClass: 'example.Old' });
  interceptor._getRunningProcesses = async () => [
    { pid: '202', name: 'Running', mainClass: 'example.Running' },
    { pid: '303', name: 'Replacement', mainClass: 'example.Replacement' }
  ];

  assert.equal(await interceptor.isActive(), true);
  assert.deepEqual([...interceptor.activatedProcesses.keys()], ['202']);

  interceptor._getRunningProcesses = async () => [];
  assert.equal(await interceptor.isActive(), false);
  assert.equal(interceptor.activatedProcesses.size, 0);
});

test('JVM refresh preserves tracking when process discovery fails', async () => {
  const interceptor = new JvmInterceptor();
  interceptor.active = true;
  interceptor.activatedProcesses.set('101', { name: 'Unknown', mainClass: 'example.Unknown' });
  interceptor._getRunningProcesses = async () => {
    interceptor.processDiscoveryFailed = true;
    return [];
  };

  assert.equal(await interceptor.isActive(), true);
  assert.equal(interceptor.activatedProcesses.has('101'), true);
});
