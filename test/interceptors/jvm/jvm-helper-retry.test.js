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
  interceptor._getAttachRuntimeClassVersion = async () => 61;
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
  interceptor._getAttachRuntimeClassVersion = async () => 61;
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
  interceptor._getAttachRuntimeClassVersion = async () => 61;
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
  interceptor._getAttachRuntimeClassVersion = async () => 61;
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

test('runtime downgrade rebuilds helper bytecode and compatible runtimes reuse it', async t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freekit-helper-runtime-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  let runtime = 61;
  const targets = [];
  const create = () => {
    const interceptor = new JvmInterceptor({ agentDir });
    interceptor._getAttachRuntimeClassVersion = async () => runtime;
    interceptor._compileJava = async (_source, buildDir, version) => {
      targets.push(version);
      const bytes = createTestAttachClass(); bytes.writeUInt16BE(version, 6);
      fs.writeFileSync(path.join(buildDir, 'AttachProxy.class'), bytes);
    };
    return interceptor;
  };
  await create()._ensureAttachHelper();
  runtime = 52;
  await create()._ensureAttachHelper();
  assert.deepEqual(targets, [61, 52]);
  assert.equal(fs.readFileSync(path.join(agentDir, 'AttachProxy.class')).readUInt16BE(6), 52);
  runtime = 55;
  await create()._ensureAttachHelper();
  assert.deepEqual(targets, [61, 52], 'Java 11 reuses compatible Java 8 bytecode');
});

test('incompatible rebuilds and failed runtime detection preserve the published cache', async t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freekit-helper-incompatible-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const interceptor = new JvmInterceptor({ agentDir });
  interceptor._getAttachRuntimeClassVersion = async () => 61;
  interceptor._compileJava = async (_source, buildDir) => writeTestAttachClass(buildDir);
  await interceptor._ensureAttachHelper();
  const classPath = path.join(agentDir, 'AttachProxy.class'), stampPath = path.join(agentDir, 'attach-source.sha256');
  const before = fs.readFileSync(classPath), stamp = fs.readFileSync(stampPath);
  interceptor._getAttachRuntimeClassVersion = async () => 52;
  await assert.rejects(interceptor._ensureAttachHelper(), /incompatible/);
  assert.deepEqual(fs.readFileSync(classPath), before);
  assert.deepEqual(fs.readFileSync(stampPath), stamp);
  interceptor._getAttachRuntimeClassVersion = async () => { throw new Error('runtime unavailable'); };
  interceptor._compileJava = async () => assert.fail('must not compile with unknown runtime');
  await assert.rejects(interceptor._ensureAttachHelper(), /runtime unavailable/);
  assert.deepEqual(fs.readFileSync(stampPath), stamp);
});

test('attach compilation targets the runtime without hiding the Attach API', async () => {
  const interceptor = new JvmInterceptor();
  const calls = [];
  interceptor._runJavac = async args => calls.push(args);
  await interceptor._compileJava('/AttachProxy.java', '/', 52);
  await interceptor._compileJava('/AttachProxy.java', '/', 61);
  assert.deepEqual(calls, [
    ['-source', '8', '-target', '8', '/AttachProxy.java'],
    ['-source', '17', '-target', '17', '/AttachProxy.java']
  ]);
});

test('runtime class version parsing accepts supported Java versions and rejects unknown output', async () => {
  const interceptor = new JvmInterceptor();
  for (const version of [52, 55, 61, 65]) {
    interceptor._readAttachRuntimeProperties = async () => `Property settings:\n    java.class.version = ${version}.0\n    java.home = /jdk\n`;
    assert.equal(await interceptor._getAttachRuntimeClassVersion(), version);
  }
  for (const output of ['', 'java.class.version = 51.0', 'java.class.version = 61.65535', 'java.class.version = invalid']) {
    interceptor._readAttachRuntimeProperties = async () => output;
    await assert.rejects(interceptor._getAttachRuntimeClassVersion(), /Could not determine/);
  }
});
