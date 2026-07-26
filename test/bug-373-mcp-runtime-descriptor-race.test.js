import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  removeMcpRuntimeDescriptor,
  writeMcpRuntimeDescriptor
} from '../src/mcp/launch-config.js';

const workerPath = fileURLToPath(new URL('./fixtures/mcp-runtime-descriptor-worker.js', import.meta.url));

async function createHarness(t, label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `http-freekit-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    descriptorPath: path.join(root, 'nested', 'runtime.json'),
    controlPath(name) {
      return path.join(root, name);
    }
  };
}

function descriptor(instanceId, descriptorPath, suffix = instanceId) {
  return {
    descriptorPath,
    sseUrl: `http://127.0.0.1:49152/mcp/sse`,
    authToken: `secret-${suffix}`,
    instanceId
  };
}

function readDescriptor(descriptorPath) {
  return JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
}

function descriptorArtifacts(descriptorPath) {
  const directory = path.dirname(descriptorPath);
  if (!fs.existsSync(directory)) return [];
  const basename = path.basename(descriptorPath);
  return fs.readdirSync(directory).filter(name =>
    name === `${basename}.lock` ||
    name.startsWith(`${basename}.lock.`) ||
    (name.startsWith(`.${basename}.`) && name.endsWith('.tmp'))
  );
}

function assertPrivateMode(filePath) {
  if (process.platform === 'win32') return;
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
}

function startWorker(config) {
  const encoded = Buffer.from(JSON.stringify(config)).toString('base64url');
  const child = spawn(process.execPath, [workerPath, encoded], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completed };
}

async function finishWorker(worker) {
  const result = await worker.completed;
  assert.equal(result.code, 0, result.stderr || `worker exited via ${result.signal}`);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length > 0, 'worker must report its result');
  const message = JSON.parse(lines.at(-1));
  assert.equal(message.ok, true);
  return message.result;
}

async function killWorker(worker) {
  if (worker.child.exitCode === null) worker.child.kill();
  const result = await worker.completed;
  assert.ok(result.code !== 0 || result.signal, 'killed worker must not report success');
  return result;
}

function injectedError(message, code = 'EBUSY') {
  return Object.assign(new Error(message), { code });
}

function errorContainsCode(error, code) {
  if (error?.code === code) return true;
  return error instanceof AggregateError && error.errors.some(item => errorContainsCode(item, code));
}

function leaveVerifiedAbandonedLock(descriptorPath) {
  const lockPath = `${descriptorPath}.lock`;
  const originalRename = fs.renameSync;
  const originalUnlink = fs.unlinkSync;
  fs.renameSync = function (source, destination) {
    if (source === lockPath && destination.startsWith(`${lockPath}.release-`)) {
      throw injectedError('release move failed');
    }
    return originalRename.apply(this, arguments);
  };
  fs.unlinkSync = function (filePath) {
    if (filePath === lockPath) throw injectedError('release unlink failed');
    return originalUnlink.apply(this, arguments);
  };
  try {
    assert.throws(() => {
      writeMcpRuntimeDescriptor(descriptor('published-with-failed-release', descriptorPath));
    }, error => error?.code === 'MCP_DESCRIPTOR_LOCK_LOST');
  } finally {
    fs.renameSync = originalRename;
    fs.unlinkSync = originalUnlink;
  }
  return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
}

async function waitForFile(filePath, worker, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (worker.child.exitCode !== null) {
      const result = await worker.completed;
      assert.fail(result.stderr || `worker exited before creating ${path.basename(filePath)}`);
    }
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${path.basename(filePath)}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function releaseWorker(filePath) {
  fs.writeFileSync(filePath, 'release', { flag: 'wx' });
}

test('readers see the complete old descriptor until atomic publication exposes the complete new one', async t => {
  const harness = await createHarness(t, 'mcp-descriptor-reader-race');
  const oldDescriptor = descriptor('old-instance', harness.descriptorPath, 'old');
  const newDescriptor = descriptor('new-instance', harness.descriptorPath, 'new');
  writeMcpRuntimeDescriptor(oldDescriptor);

  const readyPath = harness.controlPath('writer-ready');
  const releasePath = harness.controlPath('writer-release');
  const worker = startWorker({
    operation: 'write',
    descriptor: newDescriptor,
    pauseStage: 'beforeDescriptorRename',
    readyPath,
    releasePath
  });
  t.after(() => { if (worker.child.exitCode === null) worker.child.kill(); });
  await waitForFile(readyPath, worker);

  for (let index = 0; index < 50; index++) {
    assert.deepEqual(readDescriptor(harness.descriptorPath), {
      sseUrl: oldDescriptor.sseUrl,
      instanceId: oldDescriptor.instanceId,
      authToken: oldDescriptor.authToken
    });
  }
  const publishingArtifacts = descriptorArtifacts(harness.descriptorPath);
  assert.ok(publishingArtifacts.some(name => name.endsWith('.tmp')));
  assert.ok(publishingArtifacts.includes('runtime.json.lock'));
  assertPrivateMode(harness.descriptorPath);
  assertPrivateMode(path.join(path.dirname(harness.descriptorPath), 'runtime.json.lock'));
  const tempName = publishingArtifacts.find(name => name.endsWith('.tmp'));
  assertPrivateMode(path.join(path.dirname(harness.descriptorPath), tempName));

  releaseWorker(releasePath);
  await finishWorker(worker);

  assert.deepEqual(readDescriptor(harness.descriptorPath), {
    sseUrl: newDescriptor.sseUrl,
    instanceId: newDescriptor.instanceId,
    authToken: newDescriptor.authToken
  });
  assertPrivateMode(harness.descriptorPath);
  assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
});

test('old cleanup holding the lock completes before a contending new publication', async t => {
  const harness = await createHarness(t, 'mcp-descriptor-cleanup-first');
  const oldDescriptor = descriptor('old-instance', harness.descriptorPath, 'old');
  const newDescriptor = descriptor('new-instance', harness.descriptorPath, 'new');
  writeMcpRuntimeDescriptor(oldDescriptor);

  const cleanupReady = harness.controlPath('cleanup-ready');
  const cleanupRelease = harness.controlPath('cleanup-release');
  const cleanup = startWorker({
    operation: 'remove',
    descriptorPath: harness.descriptorPath,
    instanceId: oldDescriptor.instanceId,
    pauseStage: 'afterOwnershipRead',
    readyPath: cleanupReady,
    releasePath: cleanupRelease
  });
  t.after(() => { if (cleanup.child.exitCode === null) cleanup.child.kill(); });
  await waitForFile(cleanupReady, cleanup);

  const contentionPath = harness.controlPath('writer-contended');
  const writer = startWorker({
    operation: 'write',
    descriptor: newDescriptor,
    contentionPath
  });
  t.after(() => { if (writer.child.exitCode === null) writer.child.kill(); });
  await waitForFile(contentionPath, writer);

  releaseWorker(cleanupRelease);
  assert.equal(await finishWorker(cleanup), true);
  await finishWorker(writer);

  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'new-instance');
  assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
});

test('new publication holding the lock survives a contending old cleanup', async t => {
  const harness = await createHarness(t, 'mcp-descriptor-writer-first');
  const oldDescriptor = descriptor('old-instance', harness.descriptorPath, 'old');
  const newDescriptor = descriptor('new-instance', harness.descriptorPath, 'new');
  writeMcpRuntimeDescriptor(oldDescriptor);

  const writerReady = harness.controlPath('writer-ready');
  const writerRelease = harness.controlPath('writer-release');
  const writer = startWorker({
    operation: 'write',
    descriptor: newDescriptor,
    pauseStage: 'beforeDescriptorRename',
    readyPath: writerReady,
    releasePath: writerRelease
  });
  t.after(() => { if (writer.child.exitCode === null) writer.child.kill(); });
  await waitForFile(writerReady, writer);

  const contentionPath = harness.controlPath('cleanup-contended');
  const cleanup = startWorker({
    operation: 'remove',
    descriptorPath: harness.descriptorPath,
    instanceId: oldDescriptor.instanceId,
    contentionPath
  });
  t.after(() => { if (cleanup.child.exitCode === null) cleanup.child.kill(); });
  await waitForFile(contentionPath, cleanup);
  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'old-instance');

  releaseWorker(writerRelease);
  await finishWorker(writer);
  assert.equal(await finishWorker(cleanup), false);

  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'new-instance');
  assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
});

test('failed publication preserves the prior descriptor and removes temp and lock files', async t => {
  const harness = await createHarness(t, 'mcp-descriptor-publish-failure');
  const oldDescriptor = descriptor('old-instance', harness.descriptorPath, 'old');
  writeMcpRuntimeDescriptor(oldDescriptor);

  assert.throws(() => {
    writeMcpRuntimeDescriptor(
      descriptor('new-instance', harness.descriptorPath, 'new'),
      {
        beforeDescriptorRename() {
          assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'old-instance');
          throw new Error('simulated rename boundary failure');
        }
      }
    );
  }, /simulated rename boundary failure/);

  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'old-instance');
  assertPrivateMode(harness.descriptorPath);
  assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
});

test('failed lock owner writes and flushes remove only the newly created partial lock', async t => {
  const harness = await createHarness(t, 'mcp-descriptor-lock-io-failure');
  writeMcpRuntimeDescriptor(descriptor('old-instance', harness.descriptorPath, 'old'));

  for (const method of ['writeFileSync', 'fsyncSync']) {
    const original = fs[method];
    let injected = false;
    fs[method] = function (...args) {
      if (!injected && typeof args[0] === 'number') {
        injected = true;
        throw new Error(`injected lock ${method} failure`);
      }
      return original.apply(this, args);
    };
    try {
      assert.throws(() => {
        writeMcpRuntimeDescriptor(
          descriptor(`new-${method}`, harness.descriptorPath, method),
          { lockTimeoutMs: 25, lockRetryMs: 5 }
        );
      }, new RegExp(`injected lock ${method} failure`));
    } finally {
      fs[method] = original;
    }

    assert.equal(injected, true);
    assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'old-instance');
    assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
  }
});

test('crashes before and after canonical lock publication leave only recoverable complete metadata', async t => {
  for (const pauseStage of ['beforeLockLink', 'afterLockLink']) {
    await t.test(pauseStage, async t => {
      const harness = await createHarness(t, `mcp-descriptor-${pauseStage}`);
      const oldDescriptor = descriptor('old-instance', harness.descriptorPath, 'old');
      writeMcpRuntimeDescriptor(oldDescriptor);

      const readyPath = harness.controlPath('writer-ready');
      const releasePath = harness.controlPath('writer-release');
      const worker = startWorker({
        operation: 'write',
        descriptor: descriptor('crashed-instance', harness.descriptorPath, 'crashed'),
        pauseStage,
        readyPath,
        releasePath
      });
      t.after(() => { if (worker.child.exitCode === null) worker.child.kill(); });
      await waitForFile(readyPath, worker);

      const lockPath = `${harness.descriptorPath}.lock`;
      const artifacts = descriptorArtifacts(harness.descriptorPath);
      const pendingName = artifacts.find(name => name.startsWith('runtime.json.lock.pending-'));
      assert.ok(pendingName, 'fully written pending owner metadata must exist at the crash point');
      const pendingPath = path.join(path.dirname(harness.descriptorPath), pendingName);
      const pendingOwner = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
      assert.equal(pendingOwner.version, 1);
      assert.equal(pendingOwner.pid, worker.child.pid);
      assertPrivateMode(pendingPath);
      assert.equal(fs.existsSync(lockPath), pauseStage === 'afterLockLink');
      if (pauseStage === 'afterLockLink') {
        assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), pendingOwner);
      }

      await killWorker(worker);
      writeMcpRuntimeDescriptor(
        descriptor('recovered-instance', harness.descriptorPath, 'recovered'),
        { lockTimeoutMs: 1000, lockRetryMs: 5 }
      );

      assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'recovered-instance');
      assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
    });
  }
});

test('a killed writer descriptor temp is removed only after the dead lock is recovered', async t => {
  const harness = await createHarness(t, 'mcp-descriptor-temp-crash');
  writeMcpRuntimeDescriptor(descriptor('old-instance', harness.descriptorPath, 'old'));

  const readyPath = harness.controlPath('writer-ready');
  const releasePath = harness.controlPath('writer-release');
  const worker = startWorker({
    operation: 'write',
    descriptor: descriptor('crashed-instance', harness.descriptorPath, 'credential-bearing'),
    pauseStage: 'beforeDescriptorRename',
    readyPath,
    releasePath
  });
  t.after(() => { if (worker.child.exitCode === null) worker.child.kill(); });
  await waitForFile(readyPath, worker);

  const tempName = descriptorArtifacts(harness.descriptorPath).find(name => name.endsWith('.tmp'));
  assert.ok(tempName);
  const tempPath = path.join(path.dirname(harness.descriptorPath), tempName);
  assert.match(fs.readFileSync(tempPath, 'utf8'), /secret-credential-bearing/);
  await killWorker(worker);

  assert.equal(fs.existsSync(tempPath), true, 'the orphan remains until a process owns the lock');
  writeMcpRuntimeDescriptor(descriptor('recovered-instance', harness.descriptorPath, 'recovered'));
  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'recovered-instance');
  assert.equal(fs.existsSync(tempPath), false);
  assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
});

test('lock publication failures and failed verification clean only the lock being created', async t => {
  const harness = await createHarness(t, 'mcp-descriptor-lock-publish-failure');
  writeMcpRuntimeDescriptor(descriptor('old-instance', harness.descriptorPath, 'old'));
  const originalLink = fs.linkSync;
  fs.linkSync = function (source, destination) {
    if (destination === `${harness.descriptorPath}.lock`) {
      throw injectedError('hard links unavailable', 'EPERM');
    }
    return originalLink.apply(this, arguments);
  };
  try {
    assert.throws(() => {
      writeMcpRuntimeDescriptor(descriptor('blocked-instance', harness.descriptorPath, 'blocked'));
    }, error => error?.code === 'EPERM');
  } finally {
    fs.linkSync = originalLink;
  }
  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'old-instance');
  assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);

  assert.throws(() => {
    writeMcpRuntimeDescriptor(descriptor('invalid-instance', harness.descriptorPath, 'invalid'), {
      afterLockLink({ lockPath }) {
        fs.writeFileSync(lockPath, '{invalid owner metadata');
      }
    });
  }, error => error?.code === 'MCP_DESCRIPTOR_LOCK_LOST');
  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'old-instance');
  assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
});

test('a demonstrably live lock holder is not stolen and contention is bounded', async t => {
  const harness = await createHarness(t, 'mcp-descriptor-live-contention');
  const oldDescriptor = descriptor('old-instance', harness.descriptorPath, 'old');
  writeMcpRuntimeDescriptor(oldDescriptor);

  const holderReady = harness.controlPath('holder-ready');
  const holderRelease = harness.controlPath('holder-release');
  const holder = startWorker({
    operation: 'write',
    descriptor: descriptor('holder-instance', harness.descriptorPath, 'holder'),
    pauseStage: 'beforeDescriptorRename',
    readyPath: holderReady,
    releasePath: holderRelease
  });
  t.after(() => { if (holder.child.exitCode === null) holder.child.kill(); });
  await waitForFile(holderReady, holder);
  const holderStartedAt = JSON.parse(
    fs.readFileSync(`${harness.descriptorPath}.lock`, 'utf8')
  ).processStartedAt;
  const liveHolderOptions = {
    lockTimeoutMs: 60,
    lockRetryMs: 5,
    processStartTimeProbe: () => holderStartedAt
  };

  const startedAt = Date.now();
  assert.throws(() => {
    writeMcpRuntimeDescriptor(
      descriptor('contender-instance', harness.descriptorPath, 'contender'),
      liveHolderOptions
    );
  }, error => error?.code === 'MCP_DESCRIPTOR_LOCK_TIMEOUT');
  assert.equal(
    removeMcpRuntimeDescriptor(harness.descriptorPath, 'old-instance', liveHolderOptions),
    false
  );
  assert.ok(Date.now() - startedAt < 1500, 'both contending operations must return within a bound');
  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'old-instance');

  releaseWorker(holderRelease);
  await finishWorker(holder);
  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'holder-instance');
  assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
});

test('ambiguous lock ownership fails closed while a valid dead owner lock is recoverable', async t => {
  const harness = await createHarness(t, 'mcp-descriptor-lock-recovery');
  writeMcpRuntimeDescriptor(descriptor('old-instance', harness.descriptorPath, 'old'));
  const lockPath = `${harness.descriptorPath}.lock`;

  fs.writeFileSync(lockPath, '{not valid lock JSON', { mode: 0o600 });
  assert.equal(removeMcpRuntimeDescriptor(harness.descriptorPath, 'old-instance', {
    lockTimeoutMs: 25,
    lockRetryMs: 5
  }), false);
  assert.throws(() => {
    writeMcpRuntimeDescriptor(descriptor('blocked-instance', harness.descriptorPath, 'blocked'), {
      lockTimeoutMs: 25,
      lockRetryMs: 5
    });
  }, error => error?.code === 'MCP_DESCRIPTOR_LOCK_TIMEOUT');
  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'old-instance');
  assert.equal(fs.existsSync(lockPath), true, 'ambiguous ownership must not be removed');
  fs.unlinkSync(lockPath);

  fs.writeFileSync(lockPath, JSON.stringify({
    version: 1,
    token: 'dead-owner-token',
    pid: 2147483647,
    processStartedAt: 1,
    createdAt: Date.now()
  }), { mode: 0o600 });
  writeMcpRuntimeDescriptor(descriptor('recovered-instance', harness.descriptorPath, 'recovered'), {
    lockTimeoutMs: 250,
    lockRetryMs: 5
  });

  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'recovered-instance');
  assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
});

test('stale recovery never falls back to a racy canonical unlink', async t => {
  const harness = await createHarness(t, 'mcp-descriptor-stale-quarantine-failure');
  writeMcpRuntimeDescriptor(descriptor('old-instance', harness.descriptorPath, 'old'));
  const lockPath = `${harness.descriptorPath}.lock`;
  const deadOwner = {
    version: 1,
    token: 'dead-owner-quarantine-token',
    pid: 2147483647,
    processStartedAt: 1,
    createdAt: Date.now()
  };
  fs.writeFileSync(lockPath, JSON.stringify(deadOwner), { mode: 0o600 });

  const originalRename = fs.renameSync;
  const originalUnlink = fs.unlinkSync;
  let staleMoveAttempts = 0;
  let canonicalUnlinks = 0;
  fs.renameSync = function (source, destination) {
    if (source === lockPath && destination.startsWith(`${lockPath}.stale-`)) {
      staleMoveAttempts++;
      throw injectedError('stale quarantine move failed');
    }
    return originalRename.apply(this, arguments);
  };
  fs.unlinkSync = function (filePath) {
    if (filePath === lockPath) canonicalUnlinks++;
    return originalUnlink.apply(this, arguments);
  };
  try {
    assert.throws(() => {
      writeMcpRuntimeDescriptor(descriptor('blocked-instance', harness.descriptorPath, 'blocked'), {
        lockTimeoutMs: 25,
        lockRetryMs: 5
      });
    }, error => error?.code === 'MCP_DESCRIPTOR_LOCK_TIMEOUT');
  } finally {
    fs.renameSync = originalRename;
    fs.unlinkSync = originalUnlink;
  }

  assert.ok(staleMoveAttempts >= 3);
  assert.equal(canonicalUnlinks, 0, 'a stale owner may be removed only by atomic quarantine rename');
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), deadOwner);
  writeMcpRuntimeDescriptor(descriptor('recovered-instance', harness.descriptorPath, 'recovered'));
  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'recovered-instance');
  assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
});

test('process start identity distinguishes a recycled PID from the recorded lock owner', async t => {
  const harness = await createHarness(t, 'mcp-descriptor-pid-reuse');
  writeMcpRuntimeDescriptor(descriptor('old-instance', harness.descriptorPath, 'old'));
  const lockPath = `${harness.descriptorPath}.lock`;
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore'
  });
  const unrelatedExited = new Promise(resolve => unrelated.once('exit', resolve));
  t.after(async () => {
    if (unrelated.exitCode === null) unrelated.kill();
    await unrelatedExited;
  });
  await new Promise((resolve, reject) => {
    unrelated.once('spawn', resolve);
    unrelated.once('error', reject);
  });

  const recordedStartedAt = 10000;
  fs.writeFileSync(lockPath, JSON.stringify({
    version: 1,
    token: 'recycled-pid-owner',
    pid: unrelated.pid,
    processStartedAt: recordedStartedAt,
    createdAt: Date.now()
  }), { mode: 0o600 });
  writeMcpRuntimeDescriptor(descriptor('recovered-instance', harness.descriptorPath, 'recovered'), {
    lockTimeoutMs: 250,
    lockRetryMs: 5,
    processStartTimeProbe: () => recordedStartedAt + 10000
  });
  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'recovered-instance');
  assert.equal(unrelated.exitCode, null, 'unrelated process with the recycled PID remains alive');

  fs.writeFileSync(lockPath, JSON.stringify({
    version: 1,
    token: 'matching-live-owner',
    pid: unrelated.pid,
    processStartedAt: recordedStartedAt,
    createdAt: Date.now()
  }), { mode: 0o600 });
  assert.throws(() => {
    writeMcpRuntimeDescriptor(descriptor('blocked-instance', harness.descriptorPath, 'blocked'), {
      lockTimeoutMs: 25,
      lockRetryMs: 5,
      processStartTimeProbe: () => recordedStartedAt
    });
  }, error => error?.code === 'MCP_DESCRIPTOR_LOCK_TIMEOUT');
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'matching-live-owner');
  fs.unlinkSync(lockPath);
  assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
});

test('lock release retries transient moves and falls back to an identity-checked unlink', async t => {
  const harness = await createHarness(t, 'mcp-descriptor-release-retry');
  writeMcpRuntimeDescriptor(descriptor('old-instance', harness.descriptorPath, 'old'));
  const lockPath = `${harness.descriptorPath}.lock`;
  const originalRename = fs.renameSync;
  let releaseMoveAttempts = 0;
  fs.renameSync = function (source, destination) {
    if (source === lockPath && destination.startsWith(`${lockPath}.release-`)) {
      releaseMoveAttempts++;
      if (releaseMoveAttempts <= 2) throw injectedError('transient release move failure');
    }
    return originalRename.apply(this, arguments);
  };
  try {
    writeMcpRuntimeDescriptor(descriptor('retried-instance', harness.descriptorPath, 'retried'));
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(releaseMoveAttempts, 3);
  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'retried-instance');
  assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);

  releaseMoveAttempts = 0;
  fs.renameSync = function (source, destination) {
    if (source === lockPath && destination.startsWith(`${lockPath}.release-`)) {
      releaseMoveAttempts++;
      throw injectedError('persistent release move failure');
    }
    return originalRename.apply(this, arguments);
  };
  try {
    writeMcpRuntimeDescriptor(descriptor('fallback-instance', harness.descriptorPath, 'fallback'));
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(releaseMoveAttempts, 3);
  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'fallback-instance');
  assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
});

test('a moved release artifact is best-effort and is cleaned by the next lock owner', async t => {
  const harness = await createHarness(t, 'mcp-descriptor-release-artifact');
  writeMcpRuntimeDescriptor(descriptor('old-instance', harness.descriptorPath, 'old'));
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = function (filePath) {
    if (String(filePath).includes('runtime.json.lock.release-')) {
      throw injectedError('release quarantine is temporarily busy');
    }
    return originalUnlink.apply(this, arguments);
  };
  try {
    writeMcpRuntimeDescriptor(descriptor('published-instance', harness.descriptorPath, 'published'));
  } finally {
    fs.unlinkSync = originalUnlink;
  }

  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'published-instance');
  assert.equal(fs.existsSync(`${harness.descriptorPath}.lock`), false);
  assert.ok(descriptorArtifacts(harness.descriptorPath).some(name => name.includes('.lock.release-')));
  writeMcpRuntimeDescriptor(descriptor('cleaner-instance', harness.descriptorPath, 'cleaner'));
  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'cleaner-instance');
  assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
});

test('operation and lock-release failures are both reported', async t => {
  const harness = await createHarness(t, 'mcp-descriptor-dual-failure');
  writeMcpRuntimeDescriptor(descriptor('old-instance', harness.descriptorPath, 'old'));
  const lockPath = `${harness.descriptorPath}.lock`;
  const originalRename = fs.renameSync;
  const originalUnlink = fs.unlinkSync;
  fs.renameSync = function (source, destination) {
    if (source === lockPath && destination.startsWith(`${lockPath}.release-`)) {
      throw injectedError('release move failed');
    }
    return originalRename.apply(this, arguments);
  };
  fs.unlinkSync = function (filePath) {
    if (filePath === lockPath) throw injectedError('release unlink failed');
    return originalUnlink.apply(this, arguments);
  };
  try {
    assert.throws(() => {
      writeMcpRuntimeDescriptor(descriptor('failed-instance', harness.descriptorPath, 'failed'), {
        beforeDescriptorRename() {
          throw new Error('descriptor operation failed');
        }
      });
    }, error => {
      assert.equal(error?.code, 'MCP_DESCRIPTOR_OPERATION_AND_RELEASE_FAILED');
      assert.match(error.errors[0].message, /descriptor operation failed/);
      assert.equal(error.errors[1].code, 'MCP_DESCRIPTOR_LOCK_LOST');
      return true;
    });
  } finally {
    fs.renameSync = originalRename;
    fs.unlinkSync = originalUnlink;
  }

  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'old-instance');
  assert.equal(fs.existsSync(lockPath), true, 'failed release leaves its verified canonical lock intact');
  writeMcpRuntimeDescriptor(descriptor('recovered-instance', harness.descriptorPath, 'recovered'));
  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'recovered-instance');
  assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
});

test('abandoned-release recovery is scoped to the exact path, owner, and file identity', async t => {
  await t.test('identical owner metadata copied to another descriptor is not recoverable', async t => {
    const harness = await createHarness(t, 'mcp-descriptor-abandoned-other-path');
    const otherDescriptorPath = path.join(path.dirname(harness.descriptorPath), 'other-runtime.json');
    writeMcpRuntimeDescriptor(descriptor('old-instance', harness.descriptorPath, 'old'));
    writeMcpRuntimeDescriptor(descriptor('other-old-instance', otherDescriptorPath, 'other-old'));
    const abandonedOwner = leaveVerifiedAbandonedLock(harness.descriptorPath);
    const otherLockPath = `${otherDescriptorPath}.lock`;
    fs.writeFileSync(otherLockPath, JSON.stringify(abandonedOwner), { mode: 0o600 });

    assert.throws(() => {
      writeMcpRuntimeDescriptor(descriptor('other-blocked-instance', otherDescriptorPath), {
        lockTimeoutMs: 25,
        lockRetryMs: 5
      });
    }, error => error?.code === 'MCP_DESCRIPTOR_LOCK_TIMEOUT');
    assert.deepEqual(JSON.parse(fs.readFileSync(otherLockPath, 'utf8')), abandonedOwner);
    fs.unlinkSync(otherLockPath);

    writeMcpRuntimeDescriptor(descriptor('recovered-instance', harness.descriptorPath, 'recovered'));
    assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'recovered-instance');
    assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
    assert.deepEqual(descriptorArtifacts(otherDescriptorPath), []);
  });

  await t.test('replacement ownership clears obsolete abandoned state', async t => {
    const harness = await createHarness(t, 'mcp-descriptor-abandoned-replaced');
    writeMcpRuntimeDescriptor(descriptor('old-instance', harness.descriptorPath, 'old'));
    const abandonedOwner = leaveVerifiedAbandonedLock(harness.descriptorPath);
    const lockPath = `${harness.descriptorPath}.lock`;
    const replacementOwner = { ...abandonedOwner, token: 'replacement-owner-token' };
    fs.writeFileSync(lockPath, JSON.stringify(replacementOwner));

    assert.throws(() => {
      writeMcpRuntimeDescriptor(descriptor('replacement-blocked-instance', harness.descriptorPath), {
        lockTimeoutMs: 25,
        lockRetryMs: 5
      });
    }, error => error?.code === 'MCP_DESCRIPTOR_LOCK_TIMEOUT');
    assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), replacementOwner);

    fs.writeFileSync(lockPath, JSON.stringify(abandonedOwner));
    assert.throws(() => {
      writeMcpRuntimeDescriptor(descriptor('obsolete-state-blocked-instance', harness.descriptorPath), {
        lockTimeoutMs: 25,
        lockRetryMs: 5
      });
    }, error => error?.code === 'MCP_DESCRIPTOR_LOCK_TIMEOUT');
    assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), abandonedOwner);
    fs.unlinkSync(lockPath);
    assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
  });

  await t.test('a missing canonical lock clears obsolete abandoned state', async t => {
    const harness = await createHarness(t, 'mcp-descriptor-abandoned-missing');
    writeMcpRuntimeDescriptor(descriptor('old-instance', harness.descriptorPath, 'old'));
    const abandonedOwner = leaveVerifiedAbandonedLock(harness.descriptorPath);
    const lockPath = `${harness.descriptorPath}.lock`;
    const retainedInodePath = `${lockPath}.test-retained-inode`;
    fs.linkSync(lockPath, retainedInodePath);
    fs.unlinkSync(lockPath);

    writeMcpRuntimeDescriptor(descriptor('after-missing-instance', harness.descriptorPath, 'after-missing'));
    fs.linkSync(retainedInodePath, lockPath);
    fs.unlinkSync(retainedInodePath);
    assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), abandonedOwner);

    assert.throws(() => {
      writeMcpRuntimeDescriptor(descriptor('missing-state-blocked-instance', harness.descriptorPath), {
        lockTimeoutMs: 25,
        lockRetryMs: 5
      });
    }, error => error?.code === 'MCP_DESCRIPTOR_LOCK_TIMEOUT');
    assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), abandonedOwner);
    fs.unlinkSync(lockPath);
    assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
  });
});

test('lock release refuses to unlink ownership replaced after acquisition', async t => {
  const harness = await createHarness(t, 'mcp-descriptor-release-owner');
  writeMcpRuntimeDescriptor(descriptor('old-instance', harness.descriptorPath, 'old'));
  const lockPath = `${harness.descriptorPath}.lock`;

  assert.throws(() => {
    writeMcpRuntimeDescriptor(
      descriptor('new-instance', harness.descriptorPath, 'new'),
      {
        onLockAcquired({ lockPath: acquiredPath, owner }) {
          fs.writeFileSync(acquiredPath, JSON.stringify({
            ...owner,
            token: 'replacement-owner-token'
          }));
        }
      }
    );
  }, error => error?.code === 'MCP_DESCRIPTOR_OPERATION_AND_RELEASE_FAILED' &&
    errorContainsCode(error, 'MCP_DESCRIPTOR_LOCK_LOST'));

  assert.equal(readDescriptor(harness.descriptorPath).instanceId, 'old-instance');
  assert.equal(fs.existsSync(lockPath), true, 'release must preserve a lock with different ownership');
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'replacement-owner-token');
  fs.unlinkSync(lockPath);
  assert.deepEqual(descriptorArtifacts(harness.descriptorPath), []);
});
