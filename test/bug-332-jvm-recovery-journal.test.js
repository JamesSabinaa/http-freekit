import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JvmInterceptor } from '../src/interceptors/jvm-interceptor.js';

const PID = '332';
const EXECUTABLE = 'C:\\Java\\bin\\java.exe';
const PROCESS = {
  pid: PID,
  name: 'Example',
  mainClass: 'example.Main'
};

function createDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-jvm-recovery-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function identity(overrides = {}) {
  return {
    pid: Number(PID),
    startTime: '123456',
    executable: EXECUTABLE,
    ...overrides
  };
}

function recoveryFile(dataDir) {
  return path.join(dataDir, 'jvm-interceptor-recovery.json');
}

function readJournal(dataDir) {
  return JSON.parse(fs.readFileSync(recoveryFile(dataDir), 'utf8'));
}

function writeJournal(dataDir, overrides = {}) {
  fs.writeFileSync(recoveryFile(dataDir), JSON.stringify({
    version: 1,
    processes: [{
      pid: PID,
      name: PROCESS.name,
      mainClass: PROCESS.mainClass,
      state: 'active',
      identity: identity(),
      ...overrides
    }]
  }));
}

function createInterceptor(dataDir, processIdentityLookup = async () => identity()) {
  const interceptor = new JvmInterceptor({ dataDir, processIdentityLookup });
  interceptor._getRunningProcesses = async () => [PROCESS];
  return interceptor;
}

test('successful JVM attach is journaled before mutation and survives restart for Stop', async t => {
  const dataDir = createDataDir(t);
  const original = createInterceptor(dataDir);
  original._attachAgent = async (pid, proxyHost, proxyPort, action = 'activate') => {
    assert.equal(pid, PID);
    assert.equal(action, 'activate');
    assert.equal(proxyHost, '127.0.0.1');
    assert.equal(proxyPort, 8080);
    assert.equal(readJournal(dataDir).processes[0].state, 'pending');
    return { success: true };
  };

  const activation = await original.activate(8080, { pid: PID });
  assert.equal(activation.success, true);
  assert.equal(activation.metadata.activationUncertain, false);
  assert.equal(activation.metadata.activatedProcesses[0].targetIdentity, undefined);
  assert.deepEqual(readJournal(dataDir), {
    version: 1,
    processes: [{
      pid: PID,
      name: PROCESS.name,
      mainClass: PROCESS.mainClass,
      state: 'active',
      identity: identity({ executable: 'c:\\java\\bin\\java.exe' })
    }]
  });

  const restarted = createInterceptor(dataDir);
  assert.equal(restarted.active, true);
  assert.equal(await restarted.isActive(), true);
  const metadata = await restarted.getMetadata();
  assert.equal(metadata.activatedProcesses[0].recovered, true);

  const restoreActions = [];
  restarted._attachAgent = async (pid, proxyHost, proxyPort, action) => {
    restoreActions.push([pid, proxyHost, proxyPort, action]);
    return { success: true };
  };
  await restarted.deactivate({ pid: PID });

  assert.deepEqual(restoreActions, [[PID, null, null, 'deactivate']]);
  assert.equal(restarted.active, false);
  assert.equal(fs.existsSync(recoveryFile(dataDir)), false);
});

test('apply-then-timeout ownership remains recoverable after restart', async t => {
  const dataDir = createDataDir(t);
  const original = createInterceptor(dataDir);
  original._attachAgent = async () => ({
    success: false,
    error: 'attach helper timed out',
    targetMutationPossible: true
  });

  const activation = await original.activate(8080, { pid: PID });
  assert.equal(activation.success, false);
  assert.equal(activation.metadata.activationUncertain, true);
  assert.equal(readJournal(dataDir).processes[0].state, 'uncertain');

  const restarted = createInterceptor(dataDir);
  assert.equal(await restarted.isActive(), true);
  assert.equal(restarted.toJSON().activationUncertain, true);
  let restoreCount = 0;
  restarted._attachAgent = async (pid, proxyHost, proxyPort, action) => {
    assert.deepEqual([pid, proxyHost, proxyPort, action], [PID, null, null, 'deactivate']);
    restoreCount += 1;
    return { success: true };
  };

  await restarted.deactivate();
  assert.equal(restoreCount, 1);
  assert.equal(fs.existsSync(recoveryFile(dataDir)), false);
});

test('dead JVM recovery ownership is cleared without attaching', async t => {
  const dataDir = createDataDir(t);
  writeJournal(dataDir);
  const restarted = new JvmInterceptor({
    dataDir,
    processIdentityLookup: async () => null
  });
  restarted._getRunningProcesses = async () => [];
  let attachCount = 0;
  restarted._attachAgent = async () => { attachCount += 1; return { success: true }; };

  assert.equal(await restarted.isActive(), false);
  await restarted.deactivate();

  assert.equal(attachCount, 0);
  assert.equal(restarted.activatedProcesses.size, 0);
  assert.equal(fs.existsSync(recoveryFile(dataDir)), false);
});

test('a live matching OS process omitted by jps retains recovery without attaching', async t => {
  const dataDir = createDataDir(t);
  writeJournal(dataDir);
  const restarted = new JvmInterceptor({
    dataDir,
    processIdentityLookup: async () => identity()
  });
  let visibleToJps = false;
  restarted._getRunningProcesses = async () => visibleToJps ? [PROCESS] : [];
  let attachCount = 0;
  restarted._attachAgent = async () => { attachCount += 1; return { success: true }; };

  assert.equal(await restarted.isActive(), true);
  assert.equal(restarted.toJSON().recoveryUncertain, true);
  await assert.rejects(
    restarted.deactivate({ pid: PID }),
    /identity could not be verified; no restore was attempted and Stop can be retried/
  );
  assert.equal(attachCount, 0);
  assert.equal(restarted.activatedProcesses.has(PID), true);
  assert.equal(fs.existsSync(recoveryFile(dataDir)), true);

  visibleToJps = true;
  await restarted.deactivate({ pid: PID });
  assert.equal(attachCount, 1);
  assert.equal(restarted.active, false);
  assert.equal(fs.existsSync(recoveryFile(dataDir)), false);
});

test('Stop refuses a replacement PID that appears during attach-helper preparation', async t => {
  const dataDir = createDataDir(t);
  writeJournal(dataDir);
  let currentIdentity = identity();
  const restarted = createInterceptor(dataDir, async () => currentIdentity);
  restarted._getAgentJarPath = async () => 'proxy-agent.jar';
  let preparationCount = 0;
  restarted._ensureAttachHelper = async () => {
    preparationCount += 1;
    currentIdentity = identity({ startTime: '999999' });
    return 'attach-helper';
  };
  let helperRunCount = 0;
  restarted._runAttachHelper = async () => {
    helperRunCount += 1;
    return 'unexpected attach';
  };

  await restarted.deactivate({ pid: PID });

  assert.equal(preparationCount, 1);
  assert.equal(helperRunCount, 0, 'the replacement PID must never receive the agent');
  assert.equal(restarted.active, false);
  assert.equal(restarted.activatedProcesses.size, 0);
  assert.equal(fs.existsSync(recoveryFile(dataDir)), false);
});

test('activation refuses a replacement PID that appears during helper preparation', async t => {
  const dataDir = createDataDir(t);
  let currentIdentity = identity();
  const interceptor = createInterceptor(dataDir, async () => currentIdentity);
  interceptor._getAgentJarPath = async () => 'proxy-agent.jar';
  interceptor._ensureAttachHelper = async () => {
    currentIdentity = identity({ startTime: '999999' });
    return 'attach-helper';
  };
  let helperRunCount = 0;
  interceptor._runAttachHelper = async () => {
    helperRunCount += 1;
    return 'unexpected attach';
  };

  const activation = await interceptor.activate(8080, { pid: PID });

  assert.equal(activation.success, false);
  assert.equal(helperRunCount, 0, 'the replacement PID must never receive the agent');
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.activatedProcesses.size, 0);
  assert.equal(fs.existsSync(recoveryFile(dataDir)), false);
});

test('reused PIDs and mismatched JVM mains are cleared without restore attach', async t => {
  for (const mismatch of ['start-time', 'main-class']) {
    const dataDir = createDataDir(t);
    writeJournal(dataDir);
    const lookup = async () => mismatch === 'start-time'
      ? identity({ startTime: '999999' })
      : identity();
    const restarted = new JvmInterceptor({ dataDir, processIdentityLookup: lookup });
    restarted._getRunningProcesses = async () => [{
      ...PROCESS,
      mainClass: mismatch === 'main-class' ? 'unrelated.Main' : PROCESS.mainClass
    }];
    let attachCount = 0;
    restarted._attachAgent = async () => { attachCount += 1; return { success: true }; };

    assert.equal(await restarted.isActive(), false, mismatch);
    await restarted.deactivate();
    assert.equal(attachCount, 0, mismatch);
    assert.equal(fs.existsSync(recoveryFile(dataDir)), false, mismatch);
  }
});

test('ambiguous identity lookup blocks restore and retains recovery for retry', async t => {
  const dataDir = createDataDir(t);
  writeJournal(dataDir);
  let identityAvailable = false;
  const restarted = createInterceptor(dataDir, async () => {
    if (!identityAvailable) throw new Error('identity inspection denied');
    return identity();
  });
  const actions = [];
  restarted._attachAgent = async (pid, proxyHost, proxyPort, action) => {
    actions.push([pid, proxyHost, proxyPort, action]);
    return { success: true };
  };

  await assert.rejects(
    restarted.deactivate({ pid: PID }),
    /identity could not be verified; no restore was attempted and Stop can be retried/
  );
  assert.deepEqual(actions, []);
  assert.equal(restarted.active, true);
  assert.equal(restarted.activatedProcesses.has(PID), true);
  assert.equal(fs.existsSync(recoveryFile(dataDir)), true);

  identityAvailable = true;
  await restarted.deactivate({ pid: PID });
  assert.equal(actions.length, 1);
  assert.equal(restarted.active, false);
  assert.equal(fs.existsSync(recoveryFile(dataDir)), false);
});

test('corrupted and oversized JVM journals are ignored without target commands', async t => {
  t.mock.method(console, 'warn', () => {});
  for (const contents of ['{not-json', 'x'.repeat(129 * 1024)]) {
    const dataDir = createDataDir(t);
    fs.writeFileSync(recoveryFile(dataDir), contents);
    const restarted = new JvmInterceptor({
      dataDir,
      processIdentityLookup: async () => assert.fail('invalid journal must not authorize lookup')
    });
    restarted._getRunningProcesses = async () => [];
    let attachCount = 0;
    restarted._attachAgent = async () => { attachCount += 1; return { success: true }; };

    assert.equal(await restarted.isActive(), false);
    await restarted.deactivate();
    assert.equal(attachCount, 0);
    assert.equal(restarted.activatedProcesses.size, 0);
    assert.equal(fs.existsSync(recoveryFile(dataDir)), true);
  }
});

test('atomic journal failure aborts activation before the attach mutation boundary', async t => {
  const dataDir = createDataDir(t);
  const interceptor = createInterceptor(dataDir);
  fs.mkdirSync(interceptor.recoveryFile);
  let attachCount = 0;
  interceptor._attachAgent = async () => { attachCount += 1; return { success: true }; };

  const activation = await interceptor.activate(8080, { pid: PID });

  assert.equal(activation.success, false);
  assert.match(activation.error, /Could not persist JVM recovery ownership before attach/);
  assert.equal(attachCount, 0);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.activatedProcesses.size, 0);
  assert.deepEqual(
    fs.readdirSync(dataDir).filter(name => name.endsWith('.tmp')),
    []
  );
});

test('definite pre-mutation attach failure discards its pending journal', async t => {
  const dataDir = createDataDir(t);
  const interceptor = createInterceptor(dataDir);
  interceptor._attachAgent = async () => ({
    success: false,
    error: 'agent build failed',
    targetMutationPossible: false
  });

  const activation = await interceptor.activate(8080, { pid: PID });

  assert.equal(activation.success, false);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.activatedProcesses.size, 0);
  assert.equal(fs.existsSync(recoveryFile(dataDir)), false);
});
