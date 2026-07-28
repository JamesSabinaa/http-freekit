import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JvmInterceptor } from '../src/interceptors/jvm-interceptor.js';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

async function commandAvailable(command, args) {
  try {
    await run(command, args);
    return true;
  } catch (error) {
    return error.code !== 'ENOENT';
  }
}

function readClassMajorVersion(classPath) {
  const bytecode = fs.readFileSync(classPath);
  assert.equal(bytecode.readUInt32BE(0), 0xcafebabe);
  return bytecode.readUInt16BE(6);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function writeTestAgentJar(jarPath, marker = 0) {
  const agentClass = Buffer.alloc(9);
  agentClass.writeUInt32BE(0xcafebabe, 0);
  agentClass.writeUInt16BE(52, 6);
  agentClass[8] = marker;
  fs.writeFileSync(jarPath, createStoredZip([
    ['META-INF/MANIFEST.MF', Buffer.from(
      'Manifest-Version: 1.0\nPremain-Class: ProxyAgent\nAgent-Class: ProxyAgent\n'
    )],
    ['ProxyAgent.class', agentClass]
  ]));
}

test('ProxyAgent compilation prefers the modern Java 8 release target', async () => {
  const interceptor = new JvmInterceptor();
  const calls = [];
  interceptor._runJavac = async (args, cwd) => calls.push({ args, cwd });

  await interceptor._compileAgentJava('/agent/ProxyAgent.java', '/agent');

  assert.deepEqual(calls, [{
    args: ['--release', '8', '/agent/ProxyAgent.java'],
    cwd: '/agent'
  }]);
  assert.match(interceptor._getAgentBytecodePolicy(), /"classMajorVersion":52/);
});

test('legacy javac fallback targets Java 8 while AttachProxy keeps host defaults', async () => {
  const interceptor = new JvmInterceptor();
  const calls = [];
  interceptor._runJavac = async (args, cwd) => {
    calls.push({ args, cwd });
    if (args.includes('--release')) {
      const error = new Error('javac: invalid flag: --release');
      error.stderr = 'javac: invalid flag: --release';
      throw error;
    }
  };

  await interceptor._compileAgentJava('/agent/ProxyAgent.java', '/agent');
  await interceptor._compileJava('/agent/AttachProxy.java', '/agent');

  assert.deepEqual(calls, [
    { args: ['--release', '8', '/agent/ProxyAgent.java'], cwd: '/agent' },
    { args: ['-source', '8', '-target', '8', '/agent/ProxyAgent.java'], cwd: '/agent' },
    { args: ['/agent/AttachProxy.java'], cwd: '/agent' }
  ]);
});

test('ordinary agent source errors do not trigger the legacy javac fallback', async () => {
  const interceptor = new JvmInterceptor();
  const calls = [];
  interceptor._runJavac = async (args) => {
    calls.push(args);
    const error = new Error('ProxyAgent.java:1: error: syntax error');
    error.code = 1;
    throw error;
  };

  await assert.rejects(
    interceptor._compileAgentJava('/agent/ProxyAgent.java', '/agent'),
    /syntax error/
  );
  assert.deepEqual(calls, [['--release', '8', '/agent/ProxyAgent.java']]);
});

test('agent cache invalidates when its bytecode policy changes', async t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-jvm-bytecode-cache-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  const interceptor = new JvmInterceptor({ agentDir });
  let compiles = 0;
  let packages = 0;
  interceptor._compileAgentJava = async () => {
    compiles += 1;
    fs.writeFileSync(path.join(agentDir, 'ProxyAgent.class'), 'compiled');
  };
  interceptor._packageAgentJar = async (jarPath) => {
    packages += 1;
    writeTestAgentJar(jarPath, packages);
  };

  assert.equal(await interceptor._getAgentJarPath(), path.join(agentDir, 'proxy-agent.jar'));
  const firstStamp = fs.readFileSync(path.join(agentDir, 'source.sha256'), 'utf8');
  await interceptor._getAgentJarPath();
  assert.equal(compiles, 1);
  assert.equal(packages, 1);

  interceptor._getAgentBytecodePolicy = () => 'java-8-major-52-policy-v2';
  await interceptor._getAgentJarPath();
  const secondStamp = fs.readFileSync(path.join(agentDir, 'source.sha256'), 'utf8');

  assert.equal(compiles, 2);
  assert.equal(packages, 2);
  assert.notEqual(secondStamp, firstStamp);
});

test('agent cache rebuilds a JAR whose contents no longer match its stamp', async t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-jvm-corrupt-cache-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const interceptor = new JvmInterceptor({ agentDir });
  let packages = 0;
  interceptor._compileAgentJava = async () => {};
  interceptor._packageAgentJar = async jarPath => {
    packages++;
    writeTestAgentJar(jarPath, packages);
  };

  const jarPath = await interceptor._getAgentJarPath();
  fs.writeFileSync(jarPath, 'corrupt');

  assert.equal(await interceptor._getAgentJarPath(), jarPath);
  assert.equal(packages, 2);
});

test('unreadable agent cache metadata degrades to an unavailable fallback', async t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-jvm-unreadable-cache-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  fs.writeFileSync(path.join(agentDir, 'proxy-agent.jar'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  fs.mkdirSync(path.join(agentDir, 'source.sha256'));
  const interceptor = new JvmInterceptor({ agentDir });
  interceptor._compileAgentJava = async () => {};
  interceptor._packageAgentJar = async () => {};

  assert.equal(await interceptor._getAgentJarPath(), null);
  assert.equal(interceptor._preparedAgentJarPath, null);
});

test('agent cache rejects a ZIP that lacks the manifest and ProxyAgent class', async t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-jvm-invalid-jar-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const interceptor = new JvmInterceptor({ agentDir });
  const jarPath = path.join(agentDir, 'invalid.jar');
  fs.writeFileSync(jarPath, createStoredZip([['unrelated.txt', Buffer.from('not an agent')]]));

  assert.throws(
    () => interceptor._getAgentJarCacheStamp(jarPath, 'a'.repeat(64)),
    /missing its manifest or ProxyAgent class/
  );

  fs.writeFileSync(jarPath, createStoredZip([
    ['META-INF/MANIFEST.MF', Buffer.from(
      'Manifest-Version: 1.0\nPremain-Class: ProxyAgent\nAgent-Class: ProxyAgent\n'
    )],
    ['ProxyAgent.class', Buffer.from('not Java bytecode')]
  ]));
  assert.throws(
    () => interceptor._getAgentJarCacheStamp(jarPath, 'a'.repeat(64)),
    /incompatible ProxyAgent bytecode/
  );
});

test('agent rebuild replaces cache symlinks without touching their targets', async t => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-jvm-symlink-cache-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-jvm-symlink-target-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  const jarTarget = path.join(outsideDir, 'jar-target.txt');
  const stampTarget = path.join(outsideDir, 'stamp-target.txt');
  fs.writeFileSync(jarTarget, 'jar sentinel');
  fs.writeFileSync(stampTarget, 'stamp sentinel');
  try {
    fs.symlinkSync(jarTarget, path.join(agentDir, 'proxy-agent.jar'), 'file');
    fs.symlinkSync(stampTarget, path.join(agentDir, 'source.sha256'), 'file');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip('file symlinks are not permitted');
      return;
    }
    throw error;
  }
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const interceptor = new JvmInterceptor({ agentDir });
  interceptor._compileAgentJava = async () => {};
  interceptor._packageAgentJar = async jarPath => writeTestAgentJar(jarPath, 7);

  assert.equal(await interceptor._getAgentJarPath(), path.join(agentDir, 'proxy-agent.jar'));
  assert.equal(fs.readFileSync(jarTarget, 'utf8'), 'jar sentinel');
  assert.equal(fs.readFileSync(stampTarget, 'utf8'), 'stamp sentinel');
  assert.equal(fs.lstatSync(path.join(agentDir, 'proxy-agent.jar')).isFile(), true);
  assert.equal(fs.lstatSync(path.join(agentDir, 'source.sha256')).isFile(), true);
});

test('available javac produces major-version-52 agent bytecode in the class and JAR', async t => {
  if (!await commandAvailable('javac', ['-version'])) {
    t.skip('javac is not available on PATH');
    return;
  }
  if (!await commandAvailable('jar', ['--help'])) {
    t.skip('jar is not available on PATH');
    return;
  }

  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-jvm-bytecode-real-'));
  const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-jvm-bytecode-jar-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(extractedDir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  const interceptor = new JvmInterceptor({ agentDir });

  const jarPath = await interceptor._getAgentJarPath();
  assert.ok(jarPath, 'agent JAR should compile when javac and jar are available');

  await run('jar', ['xf', jarPath, 'ProxyAgent.class'], { cwd: extractedDir });
  assert.equal(readClassMajorVersion(path.join(extractedDir, 'ProxyAgent.class')), 52);
});
