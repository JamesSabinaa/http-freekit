import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JvmInterceptor } from '../../../src/interceptors/jvm-interceptor.js';

function createTestAttachClass(marker = 0) {
  const bytecode = Buffer.alloc(9);
  bytecode.writeUInt32BE(0xcafebabe, 0);
  bytecode.writeUInt16BE(61, 6);
  bytecode[8] = marker;
  return bytecode;
}

function writeTestAttachClass(buildDir, marker = 0) {
  fs.writeFileSync(path.join(buildDir, 'AttachProxy.class'), createTestAttachClass(marker));
}

function attachSourceHash(interceptor) {
  return crypto.createHash('sha256').update(interceptor._getAttachSource()).digest('hex');
}

test('a zero-byte JVM attach-helper with a matching legacy source stamp is rebuilt', async t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-jvm-zero-helper-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const interceptor = new JvmInterceptor({ agentDir });
  fs.writeFileSync(path.join(agentDir, 'AttachProxy.class'), Buffer.alloc(0));
  fs.writeFileSync(path.join(agentDir, 'attach-source.sha256'), attachSourceHash(interceptor));
  let attempts = 0;
  interceptor._compileJava = async (_sourcePath, buildDir) => {
    attempts += 1;
    writeTestAttachClass(buildDir, attempts);
  };

  assert.equal(await interceptor._ensureAttachHelper(), agentDir);
  assert.equal(attempts, 1);
  assert.equal(fs.readFileSync(path.join(agentDir, 'AttachProxy.class')).readUInt32BE(0), 0xcafebabe);
  const stamp = JSON.parse(fs.readFileSync(path.join(agentDir, 'attach-source.sha256'), 'utf8'));
  assert.equal(stamp.sourceHash, attachSourceHash(interceptor));
  assert.match(stamp.classHash, /^[a-f0-9]{64}$/);
  assert.equal(stamp.classSize, 9);
});

test('a tampered JVM attach-helper is rebuilt even when its old stamp still matches the source', async t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-jvm-tampered-helper-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  t.mock.method(console, 'warn', () => {});
  const interceptor = new JvmInterceptor({ agentDir });
  let attempts = 0;
  interceptor._compileJava = async (_sourcePath, buildDir) => {
    attempts += 1;
    writeTestAttachClass(buildDir, attempts);
  };

  await interceptor._ensureAttachHelper();
  const stampPath = path.join(agentDir, 'attach-source.sha256');
  const oldStamp = fs.readFileSync(stampPath, 'utf8');
  fs.writeFileSync(path.join(agentDir, 'AttachProxy.class'), createTestAttachClass(99));

  assert.equal(await interceptor._ensureAttachHelper(), agentDir);
  assert.equal(attempts, 2);
  assert.notEqual(fs.readFileSync(stampPath, 'utf8'), oldStamp);
  assert.equal(fs.readFileSync(path.join(agentDir, 'AttachProxy.class'))[8], 2);
});

test('a valid JVM attach-helper cache is reused without compiling again', async t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-jvm-valid-helper-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const interceptor = new JvmInterceptor({ agentDir });
  let attempts = 0;
  interceptor._compileJava = async (_sourcePath, buildDir) => {
    attempts += 1;
    writeTestAttachClass(buildDir, attempts);
  };

  assert.equal(await interceptor._ensureAttachHelper(), agentDir);
  assert.equal(await interceptor._ensureAttachHelper(), agentDir);
  assert.equal(attempts, 1);
});

test('a failed JVM attach-helper rebuild leaves public cache metadata untouched and retries', async t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-jvm-retry-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const interceptor = new JvmInterceptor({ agentDir });
  const classPath = path.join(agentDir, 'AttachProxy.class');
  const stampPath = path.join(agentDir, 'attach-source.sha256');
  const corruptClass = Buffer.from('corrupt public helper');
  const legacyStamp = attachSourceHash(interceptor);
  fs.writeFileSync(classPath, corruptClass);
  fs.writeFileSync(stampPath, legacyStamp);
  let attempts = 0;
  interceptor._compileJava = async (_sourcePath, buildDir) => {
    attempts += 1;
    writeTestAttachClass(buildDir, attempts);
    if (attempts === 1) throw new Error('compiler interrupted');
  };

  await assert.rejects(interceptor._ensureAttachHelper(), /compiler interrupted/);
  assert.deepEqual(fs.readFileSync(classPath), corruptClass);
  assert.equal(fs.readFileSync(stampPath, 'utf8'), legacyStamp);
  assert.deepEqual(
    fs.readdirSync(agentDir).filter(name => name.startsWith('.jvm-attach-build-')),
    []
  );

  assert.equal(await interceptor._ensureAttachHelper(), agentDir);
  assert.equal(attempts, 2);
  assert.equal(fs.readFileSync(classPath)[8], 2);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(stampPath, 'utf8')));
});
