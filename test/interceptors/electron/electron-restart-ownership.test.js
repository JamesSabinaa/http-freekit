import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ElectronInterceptor } from '../../../src/interceptors/electron-interceptor.js';
import { InterceptorManager } from '../../../src/interceptors/interceptor-manager.js';

const JOURNAL_NAME = 'electron-child-ownership.json';

function createDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-333-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function executableIdentity() {
  return process.platform === 'win32'
    ? 'C:\\Program Files\\Electron Test\\electron.exe'
    : '/opt/electron-test/electron';
}

function identity(pid = 8333, overrides = {}) {
  return {
    pid,
    startTime: '638891424000000000',
    executable: executableIdentity(),
    ...overrides
  };
}

function running(processIdentity) {
  return { state: 'running', identity: processIdentity };
}

function journalRecord(processIdentity) {
  return {
    version: 1,
    ...processIdentity,
    executable: process.platform === 'win32'
      ? processIdentity.executable.toLowerCase()
      : processIdentity.executable,
    platform: process.platform
  };
}

function writeJournal(dataDir, processIdentity) {
  const recoveryFile = path.join(dataDir, JOURNAL_NAME);
  fs.writeFileSync(recoveryFile, JSON.stringify(journalRecord(processIdentity)), 'utf8');
  return recoveryFile;
}

function fakeChild(pid = 8333, onKill = null) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    return onKill ? onKill(child) : true;
  };
  return child;
}

function configureLaunch(interceptor, child) {
  interceptor.ca = {
    systemTrustInstalled: true,
    getTerminalCaBundlePath: () => process.execPath
  };
  interceptor._spawn = () => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
}

test('InterceptorManager gives Electron ownership storage in its data directory', t => {
  const dataDir = createDataDir(t);
  const manager = new InterceptorManager(null, { dataDir });

  assert.equal(
    manager.interceptors.get('electron').recoveryFile,
    path.join(dataDir, JOURNAL_NAME)
  );
});

test('a matching Electron child is journaled, adopted after restart, and safely stopped', async t => {
  const dataDir = createDataDir(t);
  const owner = identity();
  let runningNow = true;
  const lookup = async pid => {
    assert.equal(pid, owner.pid);
    return runningNow ? running({ ...owner }) : { state: 'absent' };
  };

  const original = new ElectronInterceptor({ dataDir, processIdentityLookup: lookup });
  const child = fakeChild(owner.pid);
  configureLaunch(original, child);
  await original.activate(8080, { appPath: 'electron-test' });

  const recoveryFile = path.join(dataDir, JOURNAL_NAME);
  assert.equal(await original.isActive(), true, 'the live handle is revalidated by strong identity');
  assert.deepEqual(JSON.parse(fs.readFileSync(recoveryFile, 'utf8')), journalRecord(owner));
  assert.deepEqual(
    fs.readdirSync(dataDir).filter(name => name.includes('.tmp')),
    [],
    'the atomic write leaves no temporary journal behind'
  );

  const restarted = new ElectronInterceptor({ dataDir, processIdentityLookup: lookup });
  assert.equal(restarted.process, null);
  assert.equal(await restarted.isActive(), true);
  assert.equal(restarted.toJSON().pid, owner.pid);
  const signalled = [];
  restarted._killOwnedPid = pid => {
    signalled.push(pid);
    runningNow = false;
    return true;
  };
  restarted.deactivationTimeoutMs = 10;
  restarted.processExitPollIntervalMs = 1;

  await restarted.deactivate();

  assert.deepEqual(signalled, [owner.pid]);
  assert.equal(restarted.active, false);
  assert.equal(restarted.ownership, null);
  assert.equal(fs.existsSync(recoveryFile), false);
});

test('a journal for an already-dead Electron child is removed without signalling', async t => {
  const dataDir = createDataDir(t);
  const owner = identity(8334);
  const recoveryFile = writeJournal(dataDir, owner);
  const interceptor = new ElectronInterceptor({
    dataDir,
    processIdentityLookup: async () => ({ state: 'absent' })
  });
  const signalled = [];
  interceptor._killOwnedPid = pid => signalled.push(pid);

  assert.equal(await interceptor.isActive(), false);

  assert.deepEqual(signalled, []);
  assert.equal(interceptor.ownership, null);
  assert.equal(fs.existsSync(recoveryFile), false);
});

test('a reused Electron PID is discarded and never signalled', async t => {
  const dataDir = createDataDir(t);
  const owner = identity(8335);
  const recoveryFile = writeJournal(dataDir, owner);
  const interceptor = new ElectronInterceptor({
    dataDir,
    processIdentityLookup: async () => running(identity(owner.pid, {
      startTime: '638891999999999999',
      executable: process.platform === 'win32'
        ? 'C:\\Windows\\System32\\notepad.exe'
        : '/usr/bin/unrelated'
    }))
  });
  const signalled = [];
  interceptor._killOwnedPid = pid => signalled.push(pid);

  await interceptor.deactivate();

  assert.deepEqual(signalled, []);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.ownership, null);
  assert.equal(fs.existsSync(recoveryFile), false);
});

test('Stop revalidates recovered identity immediately before signalling', async t => {
  const dataDir = createDataDir(t);
  const owner = identity(8340);
  const recoveryFile = writeJournal(dataDir, owner);
  const observations = [
    running({ ...owner }),
    running(identity(owner.pid, { startTime: '638892000000000000' }))
  ];
  const interceptor = new ElectronInterceptor({
    dataDir,
    processIdentityLookup: async () => observations.shift()
  });
  const signalled = [];
  interceptor._killOwnedPid = pid => signalled.push(pid);

  await interceptor.deactivate();

  assert.deepEqual(signalled, []);
  assert.equal(interceptor.active, false);
  assert.equal(fs.existsSync(recoveryFile), false);
});

test('identity lookup failures retain ownership for retry and never authorize a signal', async t => {
  const dataDir = createDataDir(t);
  const owner = identity(8336);
  const recoveryFile = writeJournal(dataDir, owner);
  let lookupFails = true;
  const interceptor = new ElectronInterceptor({
    dataDir,
    processIdentityLookup: async () => {
      if (lookupFails) throw new Error('identity service unavailable');
      return { state: 'absent' };
    }
  });
  const signalled = [];
  interceptor._killOwnedPid = pid => signalled.push(pid);

  assert.equal(await interceptor.isActive(), true);
  await assert.rejects(interceptor.deactivate(), /identity service unavailable.*Stop can be retried/);
  assert.deepEqual(signalled, []);
  assert.equal(interceptor.active, true);
  assert.deepEqual(interceptor.ownership, journalRecord(owner));
  assert.equal(fs.existsSync(recoveryFile), true);

  lookupFails = false;
  assert.equal(await interceptor.isActive(), false, 'a later conclusive absence permits cleanup');
  assert.equal(fs.existsSync(recoveryFile), false);
});

test('a corrupt ownership journal is retained and blocks unsafe Stop or replacement launch', async t => {
  t.mock.method(console, 'warn', () => {});
  const dataDir = createDataDir(t);
  const recoveryFile = path.join(dataDir, JOURNAL_NAME);
  const corruptContents = '{"version":1,"pid":';
  fs.writeFileSync(recoveryFile, corruptContents, 'utf8');
  const interceptor = new ElectronInterceptor({ dataDir });
  let spawnCalls = 0;
  interceptor._spawn = () => {
    spawnCalls += 1;
    assert.fail('a corrupt journal must block replacement launch');
  };
  interceptor._killOwnedPid = () => assert.fail('a corrupt journal must never authorize a signal');
  interceptor.ca = {
    systemTrustInstalled: true,
    getTerminalCaBundlePath: () => process.execPath
  };

  assert.equal(await interceptor.isActive(), false);
  await assert.rejects(interceptor.deactivate(), /ownership journal is invalid/);
  await assert.rejects(
    interceptor.activate(8080, { appPath: 'electron-test' }),
    /ownership journal is invalid and must be resolved before launch/
  );

  assert.equal(spawnCalls, 0);
  assert.equal(fs.readFileSync(recoveryFile, 'utf8'), corruptContents);
});

test('ownership journals reject unbounded or unexpected schema data without deleting it', t => {
  t.mock.method(console, 'warn', () => {});
  const dataDir = createDataDir(t);
  const recoveryFile = path.join(dataDir, JOURNAL_NAME);
  const invalidRecord = {
    ...journalRecord(identity(8337)),
    unexpected: 'x'.repeat(17 * 1024)
  };
  fs.writeFileSync(recoveryFile, JSON.stringify(invalidRecord), 'utf8');

  const interceptor = new ElectronInterceptor({ dataDir });

  assert.equal(interceptor.ownership, null);
  assert.match(interceptor.recoveryJournalError.message, /bounded regular file/);
  assert.equal(fs.existsSync(recoveryFile), true);
  assert.throws(
    () => interceptor._validateOwnershipJournal({
      ...journalRecord(identity(8341)),
      unexpected: true
    }),
    /invalid schema/
  );
});

test('normal Electron child exit removes its ownership journal', async t => {
  const dataDir = createDataDir(t);
  const owner = identity(8338);
  const interceptor = new ElectronInterceptor({
    dataDir,
    processIdentityLookup: async () => running({ ...owner })
  });
  const child = fakeChild(owner.pid);
  configureLaunch(interceptor, child);

  await interceptor.activate(8080, { appPath: 'electron-test' });
  const recoveryFile = path.join(dataDir, JOURNAL_NAME);
  assert.equal(fs.existsSync(recoveryFile), true);

  child.exitCode = 0;
  child.emit('exit', 0, null);

  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
  assert.equal(interceptor.ownership, null);
  assert.equal(fs.existsSync(recoveryFile), false);
});

test('an exit immediately after spawn confirmation cannot create stale ownership', async t => {
  const dataDir = createDataDir(t);
  const child = fakeChild(8342);
  let identityLookups = 0;
  const interceptor = new ElectronInterceptor({
    dataDir,
    processIdentityLookup: async () => {
      identityLookups += 1;
      return running(identity(child.pid));
    }
  });
  configureLaunch(interceptor, child);
  interceptor._spawn = () => {
    queueMicrotask(() => {
      child.emit('spawn');
      child.exitCode = 0;
      child.emit('exit', 0, null);
    });
    return child;
  };

  await assert.rejects(
    interceptor.activate(8080, { appPath: 'electron-test' }),
    /exited before its ownership could be recorded/
  );

  assert.equal(identityLookups, 0);
  assert.equal(child.killCalls, 0, 'an already-exited PID must not be signalled');
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
  assert.equal(fs.existsSync(path.join(dataDir, JOURNAL_NAME)), false);
});

test('journal persistence failure terminates the spawned child instead of losing ownership', async t => {
  const dataDir = createDataDir(t);
  const owner = identity(8339);
  const interceptor = new ElectronInterceptor({
    dataDir,
    processIdentityLookup: async () => running({ ...owner })
  });
  const child = fakeChild(owner.pid, processHandle => {
    queueMicrotask(() => {
      processHandle.exitCode = 0;
      processHandle.emit('exit', 0, null);
    });
    return true;
  });
  configureLaunch(interceptor, child);
  interceptor._persistOwnershipJournal = () => {
    throw new Error('journal disk full');
  };

  await assert.rejects(
    interceptor.activate(8080, { appPath: 'electron-test' }),
    /Failed to launch Electron app: journal disk full/
  );

  assert.equal(child.killCalls, 1);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
  assert.equal(interceptor.ownership, null);
  assert.equal(fs.existsSync(path.join(dataDir, JOURNAL_NAME)), false);
});

test('failed journal persistence and failed cleanup retain the exact live handle for Stop retry', async t => {
  const dataDir = createDataDir(t);
  const owner = identity(8343);
  const interceptor = new ElectronInterceptor({
    dataDir,
    processIdentityLookup: async () => running({ ...owner })
  });
  const child = fakeChild(owner.pid, () => false);
  configureLaunch(interceptor, child);
  interceptor.deactivationTimeoutMs = 1;
  interceptor._persistOwnershipJournal = () => {
    throw new Error('journal permissions denied');
  };

  await assert.rejects(
    interceptor.activate(8080, { appPath: 'electron-test' }),
    /journal permissions denied.*remains tracked so Stop can be retried/
  );

  assert.equal(child.killCalls, 1);
  assert.equal(interceptor.active, true);
  assert.equal(interceptor.process, child);
  assert.equal(interceptor.ownership, null);
  assert.equal(await interceptor.isActive(), true);

  child.kill = () => {
    child.killCalls += 1;
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    });
    return true;
  };
  await interceptor.deactivate();

  assert.equal(child.killCalls, 2);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
});
