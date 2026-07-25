import assert from 'node:assert/strict';
import test from 'node:test';

import { JvmInterceptor } from '../src/interceptors/jvm-interceptor.js';

test('JVM activation accepts a numeric process ID from JSON', async () => {
  const interceptor = new JvmInterceptor();
  const processes = [{ pid: '1234', name: 'Example', mainClass: 'example.Main' }];
  let attachedPid;

  interceptor._getRunningProcesses = async () => processes;
  interceptor._attachAgent = async pid => {
    attachedPid = pid;
    return { success: true };
  };

  const result = await interceptor.activate(8080, { pid: 1234 });

  assert.equal(result.success, true);
  assert.equal(attachedPid, '1234');
  assert.equal(result.metadata.pid, '1234');
  assert.equal(interceptor.activatedProcesses.has('1234'), true);
});
