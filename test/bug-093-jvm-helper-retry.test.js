import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JvmInterceptor } from '../src/interceptors/jvm-interceptor.js';

test('a failed JVM attach-helper compile is retried on the next attempt', async (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-jvm-retry-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const interceptor = new JvmInterceptor({ agentDir });
  let attempts = 0;
  interceptor._compileJava = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('compiler interrupted');
    fs.writeFileSync(path.join(agentDir, 'AttachProxy.class'), 'compiled');
  };

  await assert.rejects(interceptor._ensureAttachHelper(), /compiler interrupted/);
  assert.equal(fs.existsSync(path.join(agentDir, 'AttachProxy.java')), true);
  assert.equal(fs.existsSync(path.join(agentDir, 'AttachProxy.class')), false);
  assert.equal(fs.existsSync(path.join(agentDir, 'attach-source.sha256')), false);

  assert.equal(await interceptor._ensureAttachHelper(), agentDir);
  assert.equal(attempts, 2);

  assert.equal(await interceptor._ensureAttachHelper(), agentDir);
  assert.equal(attempts, 2, 'a complete matching helper should be reused');
});
