import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JvmInterceptor } from '../src/interceptors/jvm-interceptor.js';

test('JVM helper artifacts use the writable application data directory', () => {
  const dataDir = path.join(os.tmpdir(), 'http-freekit-test-data');
  const interceptor = new JvmInterceptor({ dataDir });

  assert.equal(interceptor.agentDir, path.join(dataDir, 'jvm-agent'));
  assert.equal(interceptor.agentDir.startsWith(process.cwd()), false);
});

test('standalone JVM interceptors fall back to a process-owned temp directory', () => {
  const interceptor = new JvmInterceptor();

  assert.equal(
    interceptor.agentDir,
    path.join(os.tmpdir(), `http-freekit-jvm-agent-${process.pid}`)
  );
});
