import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InterceptorManager } from '../src/interceptors/interceptor-manager.js';
import { FreshTerminalInterceptor } from '../src/interceptors/terminal-interceptors.js';

const JOURNAL_NAME = 'fresh-terminal-session-ownership.json';

function createDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-336-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function executableIdentity(platform = process.platform) {
  return platform === 'win32'
    ? 'C:\\Program Files\\Terminal Test\\PowerShell.EXE'
    : '/bin/zsh';
}

function identity(pid = 8361, platform = process.platform, overrides = {}) {
  return Object.freeze({
    pid,
    startTime: '638891424000000000',
    executable: executableIdentity(platform),
    ...overrides
  });
}

function running(processIdentity) {
  return { state: 'running', identity: processIdentity };
}

function journalRecord(processIdentity, platform = process.platform) {
  return {
    version: 1,
    sessions: [{
      pid: processIdentity.pid,
      startTime: processIdentity.startTime,
      executable: platform === 'win32'
        ? path.win32.normalize(processIdentity.executable).toLowerCase()
        : path.posix.normalize(processIdentity.executable),
      platform
    }]
  };
}

function writeJournal(dataDir, processIdentity, platform = process.platform) {
  const recoveryFile = path.join(dataDir, JOURNAL_NAME);
  fs.writeFileSync(recoveryFile, JSON.stringify(journalRecord(processIdentity, platform)), 'utf8');
  return recoveryFile;
}

function fakeLauncher(pid = 9361, onKill = null) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killSignals = [];
  proc.unrefCalls = 0;
  proc.unref = () => { proc.unrefCalls += 1; };
  proc.kill = signal => {
    proc.killSignals.push(signal);
    return onKill ? onKill(signal, proc) : true;
  };
  return proc;
}

function exitLauncher(proc, signal = null) {
  proc.exitCode = signal ? null : 0;
  proc.signalCode = signal;
  proc.emit('exit', proc.exitCode, signal);
}

function configurePosixLaunch(interceptor, owner, launcher) {
  interceptor.ca = { getTerminalCaBundlePath: () => process.execPath };
  interceptor._launcherStartupGraceMs = () => 0;
  interceptor._createPidFilePath = () => path.join(os.tmpdir(), `bug-336-${owner.pid}.pid`);
  interceptor._waitForShellPid = async () => owner.pid;
  interceptor._spawnDetached = async () => launcher;
  interceptor._inspectSessionIdentity = async pid => {
    assert.equal(pid, owner.pid);
    return running({ ...owner });
  };
}

function stopMonitor(interceptor) {
  interceptor._stopStatusMonitor();
  interceptor._startStatusMonitor = () => {};
}

test('InterceptorManager gives Fresh Terminal ownership storage in its data directory', t => {
  const dataDir = createDataDir(t);
  const manager = new InterceptorManager(null, { dataDir });
  const terminal = manager.interceptors.get('fresh-terminal');
  stopMonitor(terminal);

  assert.equal(terminal.recoveryFile, path.join(dataDir, JOURNAL_NAME));
});

test('manager shutdown cleans recovered terminal ownership through needsDeactivation', async t => {
  const dataDir = createDataDir(t);
  const owner = identity(8360, process.platform);
  const recoveryFile = writeJournal(dataDir, owner, process.platform);
  const manager = new InterceptorManager(null, { dataDir });
  const terminal = manager.interceptors.get('fresh-terminal');
  stopMonitor(terminal);
  terminal._inspectSessionIdentity = async () => ({ state: 'absent' });
  terminal._killSession = () => assert.fail('a conclusively absent recovered PID must not be signalled');

  assert.equal(await terminal.needsDeactivation(), true);
  await manager.deactivateAll();

  assert.equal(await terminal.needsDeactivation(), false);
  assert.equal(fs.existsSync(recoveryFile), false);
});

test('a POSIX shell is journaled, adopted after restart, and safely stopped', async t => {
  const dataDir = createDataDir(t);
  const owner = identity(8362, 'linux');
  const launcher = fakeLauncher(9362);
  const original = new FreshTerminalInterceptor({ dataDir, platform: 'linux' });
  configurePosixLaunch(original, owner, launcher);
  stopMonitor(original);

  const result = await original.activate(8080);
  const recoveryFile = path.join(dataDir, JOURNAL_NAME);

  assert.equal(result.pid, owner.pid);
  assert.deepEqual(JSON.parse(fs.readFileSync(recoveryFile, 'utf8')), journalRecord(owner, 'linux'));
  assert.deepEqual(
    fs.readdirSync(dataDir).filter(name => name.endsWith('.tmp')),
    [],
    'the atomic write leaves no temporary journal behind'
  );

  let runningNow = true;
  const restarted = new FreshTerminalInterceptor({ dataDir, platform: 'linux' });
  stopMonitor(restarted);
  restarted._inspectSessionIdentity = async pid => {
    assert.equal(pid, owner.pid);
    return runningNow ? running({ ...owner }) : { state: 'absent' };
  };
  const signals = [];
  restarted._killSession = (pid, signal) => {
    signals.push([pid, signal]);
    runningNow = false;
    return true;
  };
  restarted.gracefulExitTimeoutMs = 10;
  restarted.sessionExitPollIntervalMs = 1;

  assert.equal(restarted.processes.length, 0, 'restart recovery needs no stale process handle');
  assert.equal(await restarted.isActive(), true);
  assert.equal(await restarted.needsDeactivation(), true);
  await restarted.deactivate();

  assert.deepEqual(signals, [[owner.pid, 'SIGTERM']]);
  assert.equal(restarted.active, false);
  assert.equal(await restarted.needsDeactivation(), false);
  assert.equal(fs.existsSync(recoveryFile), false);
});

test('Windows Terminal records its durable PowerShell child rather than the wt launcher', async t => {
  const dataDir = createDataDir(t);
  const owner = identity(8363, 'win32');
  const launcher = fakeLauncher(9363);
  const interceptor = new FreshTerminalInterceptor({ dataDir, platform: 'win32' });
  interceptor.ca = { getTerminalCaBundlePath: () => process.execPath };
  interceptor._launcherStartupGraceMs = () => 0;
  interceptor._createWindowsHandshake = () => ({
    directory: null,
    reportFile: path.join(os.tmpdir(), `bug-336-win-${owner.pid}.json`),
    acknowledgementFile: path.join(os.tmpdir(), `bug-336-win-${owner.pid}.ack`),
    nonce: 'bug-336-test-nonce'
  });
  interceptor._waitForWindowsShellReport = async () => ({
    ...owner,
    executable: owner.executable.toLowerCase()
  });
  interceptor._acknowledgeWindowsShell = async () => {};
  let invocation;
  interceptor._spawnDetached = async (command, args, options) => {
    invocation = { command, args, options };
    return launcher;
  };
  let runningNow = true;
  interceptor._inspectSessionIdentity = async pid => runningNow && pid === owner.pid
    ? running({ ...owner, executable: owner.executable.toLowerCase() })
    : { state: 'absent' };
  const signals = [];
  interceptor._killSession = (pid, signal) => {
    signals.push([pid, signal]);
    runningNow = false;
    return true;
  };
  stopMonitor(interceptor);

  const result = await interceptor.activate(8080);

  assert.equal(result.pid, owner.pid);
  assert.equal(invocation.command, 'wt.exe');
  assert.deepEqual(invocation.args.slice(0, 5), [
    'new-tab', '--inheritEnvironment', 'powershell.exe', '-NoExit', '-Command'
  ]);
  assert.match(invocation.args[5], /pid = \[int\]\$PID/);
  assert.match(invocation.args[5], /FileMode\]::CreateNew/);
  assert.match(invocation.args[5], /ReadAllText\(.+bug-336-test-nonce/);
  assert.equal(interceptor.toJSON().pid, owner.pid);
  assert.equal(interceptor.sessions.has(launcher.pid), false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(interceptor.recoveryFile, 'utf8')),
    journalRecord(owner, 'win32')
  );

  exitLauncher(launcher);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(interceptor.active, true, 'the durable session survives the short-lived wt launcher');

  await interceptor.deactivate();
  assert.deepEqual(signals, [[owner.pid, 'SIGTERM']]);
  assert.deepEqual(launcher.killSignals, []);
});

test('Windows identity inspection is bounded and normalizes its executable path', async () => {
  const interceptor = new FreshTerminalInterceptor({ platform: 'win32' });
  interceptor._identityInspectionTimeoutMs = () => 4321;
  let invocation;
  interceptor._execFile = async (command, args, options) => {
    invocation = { command, args, options };
    return {
      stdout: JSON.stringify({
        pid: 8364,
        startTime: '638891424000000001',
        executable: 'C:\\Program Files\\Terminal Test\\..\\Terminal Test\\PowerShell.EXE'
      }),
      stderr: ''
    };
  };

  const observation = await interceptor._inspectSessionIdentity(8364);

  assert.deepEqual(observation, running({
    pid: 8364,
    startTime: '638891424000000001',
    executable: 'c:\\program files\\terminal test\\powershell.exe'
  }));
  assert.equal(invocation.command, 'powershell.exe');
  assert.match(invocation.args.at(-1), /Get-CimInstance.+ProcessId = 8364/s);
  assert.equal(invocation.options.timeout, 4321);
  assert.equal(invocation.options.maxBuffer, 16 * 1024);
  assert.equal(invocation.options.windowsHide, true);
});

test('dead and reused recovered PIDs are cleared without ever being signalled', async t => {
  for (const [suffix, observation] of [
    ['dead', { state: 'absent' }],
    ['reused', running(identity(8365, 'linux', {
      startTime: '638891424999999999',
      executable: '/usr/bin/unrelated'
    }))]
  ]) {
    await t.test(suffix, async t => {
      const dataDir = createDataDir(t);
      const owner = identity(8365, 'linux');
      const recoveryFile = writeJournal(dataDir, owner, 'linux');
      const interceptor = new FreshTerminalInterceptor({ dataDir, platform: 'linux' });
      stopMonitor(interceptor);
      interceptor._inspectSessionIdentity = async () => observation;
      const signals = [];
      interceptor._killSession = (...args) => signals.push(args);

      await interceptor.deactivate();

      assert.deepEqual(signals, []);
      assert.equal(interceptor.sessions.size, 0);
      assert.equal(interceptor.active, false);
      assert.equal(fs.existsSync(recoveryFile), false);
    });
  }
});

test('unknown recovered identity remains retryable and never authorizes a signal', async t => {
  const dataDir = createDataDir(t);
  const owner = identity(8366, 'linux');
  const recoveryFile = writeJournal(dataDir, owner, 'linux');
  const interceptor = new FreshTerminalInterceptor({ dataDir, platform: 'linux' });
  stopMonitor(interceptor);
  let uncertain = true;
  interceptor._inspectSessionIdentity = async () => uncertain
    ? { state: 'unknown', error: new Error('identity service unavailable') }
    : { state: 'absent' };
  const signals = [];
  interceptor._killSession = (...args) => signals.push(args);

  assert.equal(await interceptor.isActive(), true);
  await assert.rejects(interceptor.deactivate(), /Stop can be retried/);
  assert.deepEqual(signals, []);
  assert.equal(interceptor.sessions.size, 1);
  assert.equal(fs.existsSync(recoveryFile), true);

  uncertain = false;
  assert.equal(await interceptor.isActive(), false);
  assert.equal(interceptor.sessions.size, 0);
  assert.equal(fs.existsSync(recoveryFile), false);
});

test('corrupt and oversized journals are retained and block unsafe launch or Stop', async t => {
  t.mock.method(console, 'warn', () => {});
  for (const [suffix, contents] of [
    ['corrupt', '{"version":1,"sessions":'],
    ['oversized', 'x'.repeat((64 * 1024) + 1)]
  ]) {
    await t.test(suffix, async t => {
      const dataDir = createDataDir(t);
      const recoveryFile = path.join(dataDir, JOURNAL_NAME);
      fs.writeFileSync(recoveryFile, contents, 'utf8');
      const interceptor = new FreshTerminalInterceptor({ dataDir, platform: 'linux' });
      let launches = 0;
      interceptor._spawnDetached = async () => { launches += 1; };
      interceptor._killSession = () => assert.fail('invalid journal data must never authorize a signal');

      assert.equal(await interceptor.isActive(), false);
      assert.equal(await interceptor.needsDeactivation(), true);
      await assert.rejects(interceptor.deactivate(), /ownership journal is invalid/);
      await assert.rejects(interceptor.activate(8080), /ownership journal is invalid.*before launch/);

      assert.equal(launches, 0);
      assert.equal(fs.readFileSync(recoveryFile, 'utf8'), contents);
    });
  }
});

test('journal validation rejects unexpected, cross-platform, and duplicate session records', () => {
  const interceptor = new FreshTerminalInterceptor({ platform: 'linux' });
  const owner = identity(8367, 'linux');
  const valid = journalRecord(owner, 'linux');

  assert.throws(
    () => interceptor._validateSessionJournal({ ...valid, unexpected: true }),
    /invalid schema/
  );
  assert.throws(
    () => interceptor._validateSessionJournal({
      ...valid,
      sessions: [{ ...valid.sessions[0], platform: 'win32' }]
    }),
    /invalid session schema/
  );
  assert.throws(
    () => interceptor._validateSessionJournal({
      ...valid,
      sessions: [valid.sessions[0], { ...valid.sessions[0] }]
    }),
    /duplicate process IDs/
  );
});

test('serialized journal writes are bounded before any temporary file is created', t => {
  const dataDir = createDataDir(t);
  const interceptor = new FreshTerminalInterceptor({ dataDir, platform: 'linux' });
  const sessions = new Map();
  for (let index = 0; index < 32; index++) {
    const processIdentity = identity(8400 + index, 'linux', {
      executable: `/${String(index).padStart(2, '0')}/${'x'.repeat(4080)}`
    });
    sessions.set(processIdentity.pid, processIdentity);
  }

  assert.throws(() => interceptor._writeSessionJournal(sessions), /exceeds its size limit/);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
  assert.deepEqual(fs.readdirSync(dataDir), []);
});

test('an atomic rename failure preserves the old journal and removes its temporary file', t => {
  const dataDir = createDataDir(t);
  const oldOwner = identity(8368, 'linux');
  const newOwner = identity(8369, 'linux');
  const recoveryFile = writeJournal(dataDir, oldOwner, 'linux');
  const oldContents = fs.readFileSync(recoveryFile, 'utf8');
  const interceptor = new FreshTerminalInterceptor({ dataDir, platform: 'linux' });
  stopMonitor(interceptor);
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === recoveryFile) throw new Error('atomic rename denied');
    return originalRename(source, destination);
  });

  assert.throws(
    () => interceptor._addTrackedSession(newOwner),
    /atomic rename denied/
  );

  assert.equal(fs.readFileSync(recoveryFile, 'utf8'), oldContents);
  assert.deepEqual(fs.readdirSync(dataDir), [JOURNAL_NAME]);
  assert.equal(interceptor.sessions.has(oldOwner.pid), true);
  assert.equal(interceptor.sessions.has(newOwner.pid), false);
});

test('durable activation rejects an unverified shell PID without journaling weak ownership', async t => {
  const dataDir = createDataDir(t);
  const owner = identity(8374, 'linux');
  const launcher = fakeLauncher(9374, (_signal, proc) => {
    queueMicrotask(() => exitLauncher(proc));
    return true;
  });
  const interceptor = new FreshTerminalInterceptor({ dataDir, platform: 'linux' });
  configurePosixLaunch(interceptor, owner, launcher);
  stopMonitor(interceptor);
  interceptor._inspectSessionIdentity = async () => ({
    state: 'unknown',
    error: new Error('identity inspection denied')
  });
  const shellSignals = [];
  interceptor._killSession = (...args) => shellSignals.push(args);
  interceptor.gracefulExitTimeoutMs = 10;

  await assert.rejects(
    interceptor.activate(8080),
    /launch was rejected.*identity could not be verified.*launcher was stopped/
  );

  assert.deepEqual(shellSignals, [], 'an unverified reported PID is never signalled');
  assert.deepEqual(launcher.killSignals, ['SIGTERM']);
  assert.equal(interceptor.sessions.size, 0);
  assert.equal(interceptor.processes.length, 0);
  assert.equal(interceptor.active, false);
  assert.equal(fs.existsSync(path.join(dataDir, JOURNAL_NAME)), false);
});

test('failed cleanup after unverified identity retains only the exact launcher handle', async t => {
  const dataDir = createDataDir(t);
  const owner = identity(8375, 'linux');
  const launcher = fakeLauncher(9375, () => true);
  const interceptor = new FreshTerminalInterceptor({ dataDir, platform: 'linux' });
  configurePosixLaunch(interceptor, owner, launcher);
  stopMonitor(interceptor);
  interceptor._inspectSessionIdentity = async () => ({ state: 'unknown' });
  const shellSignals = [];
  interceptor._killSession = (...args) => shellSignals.push(args);
  interceptor.gracefulExitTimeoutMs = 0;
  interceptor.forceExitTimeoutMs = 0;

  await assert.rejects(
    interceptor.activate(8080),
    /launch was rejected.*exact launcher handle remains tracked so Stop can be retried/
  );

  assert.deepEqual(shellSignals, []);
  assert.deepEqual(launcher.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(interceptor.sessions.size, 0, 'the weak reported PID is not adopted');
  assert.deepEqual(interceptor.processes, [launcher]);
  assert.equal(interceptor.active, true);
  assert.equal(await interceptor.needsDeactivation(), true);
  assert.equal(fs.existsSync(path.join(dataDir, JOURNAL_NAME)), false);

  launcher.kill = signal => {
    launcher.killSignals.push(signal);
    queueMicrotask(() => exitLauncher(launcher, signal));
    return true;
  };
  await interceptor.deactivate();
  assert.equal(interceptor.active, false);
  assert.equal(await interceptor.needsDeactivation(), false);
});

test('journal write failure after spawn stops the exact owned session', async t => {
  const dataDir = createDataDir(t);
  const owner = identity(8370, 'linux');
  const launcher = fakeLauncher(9370, (_signal, proc) => {
    queueMicrotask(() => exitLauncher(proc));
    return true;
  });
  const interceptor = new FreshTerminalInterceptor({ dataDir, platform: 'linux' });
  configurePosixLaunch(interceptor, owner, launcher);
  stopMonitor(interceptor);
  let runningNow = true;
  interceptor._inspectSessionIdentity = async () => runningNow
    ? running({ ...owner })
    : { state: 'absent' };
  const signals = [];
  interceptor._killSession = (pid, signal) => {
    signals.push([pid, signal]);
    runningNow = false;
    return true;
  };
  interceptor._writeSessionJournal = () => { throw new Error('journal disk full'); };
  interceptor.gracefulExitTimeoutMs = 10;
  interceptor.sessionExitPollIntervalMs = 1;

  await assert.rejects(
    interceptor.activate(8080),
    /ownership could not be persisted, so the launched session was stopped/
  );

  assert.deepEqual(signals, [[owner.pid, 'SIGTERM']]);
  assert.deepEqual(launcher.killSignals, ['SIGTERM']);
  assert.equal(interceptor.sessions.size, 0);
  assert.equal(interceptor.processes.length, 0);
  assert.equal(interceptor.active, false);
});

test('failed journal write and failed cleanup retain exact live state for Stop retry', async t => {
  const dataDir = createDataDir(t);
  const owner = identity(8371, 'linux');
  const launcher = fakeLauncher(9371, (_signal, proc) => {
    queueMicrotask(() => exitLauncher(proc));
    return true;
  });
  const interceptor = new FreshTerminalInterceptor({ dataDir, platform: 'linux' });
  configurePosixLaunch(interceptor, owner, launcher);
  stopMonitor(interceptor);
  let canStop = false;
  interceptor._inspectSessionIdentity = async () => canStop
    ? { state: 'absent' }
    : running({ ...owner });
  const signals = [];
  interceptor._killSession = (pid, signal) => {
    signals.push([pid, signal]);
    return true;
  };
  interceptor._writeSessionJournal = () => { throw new Error('journal permissions denied'); };
  interceptor.gracefulExitTimeoutMs = 0;
  interceptor.forceExitTimeoutMs = 0;

  await assert.rejects(
    interceptor.activate(8080),
    /journal permissions denied.*exact live process remains tracked so Stop can be retried/
  );

  assert.deepEqual(signals, [[owner.pid, 'SIGTERM'], [owner.pid, 'SIGKILL']]);
  assert.equal(interceptor.sessions.has(owner.pid), true);
  assert.equal(interceptor.active, true);
  assert.equal(await interceptor.needsDeactivation(), true);

  interceptor._writeSessionJournal = FreshTerminalInterceptor.prototype._writeSessionJournal.bind(interceptor);
  canStop = true;
  await interceptor.deactivate();

  assert.equal(interceptor.sessions.size, 0);
  assert.equal(interceptor.active, false);
});

test('journal removal failure retains cleanup state until a later retry succeeds', async t => {
  const dataDir = createDataDir(t);
  const owner = identity(8372, 'linux');
  const recoveryFile = writeJournal(dataDir, owner, 'linux');
  const interceptor = new FreshTerminalInterceptor({ dataDir, platform: 'linux' });
  stopMonitor(interceptor);
  interceptor._inspectSessionIdentity = async () => ({ state: 'absent' });
  const originalWrite = interceptor._writeSessionJournal.bind(interceptor);
  let removalFails = true;
  interceptor._writeSessionJournal = sessions => {
    if (removalFails && sessions.size === 0) throw new Error('journal unlink denied');
    return originalWrite(sessions);
  };
  const events = [];
  interceptor.onStatusChange = event => events.push(event);

  assert.equal(await interceptor.isActive(), true, 'unpersisted removal remains active for retry');
  assert.equal(interceptor.sessions.has(owner.pid), true);
  assert.equal(fs.existsSync(recoveryFile), true);
  assert.equal(events.at(-1).reason, 'cleanup-failed');

  removalFails = false;
  assert.equal(await interceptor.isActive(), false);
  assert.equal(interceptor.sessions.size, 0);
  assert.equal(fs.existsSync(recoveryFile), false);
  assert.equal(events.at(-1).reason, 'exited');
});

test('normal launcher exit clears a conclusively gone shell journal and publishes status', async t => {
  const dataDir = createDataDir(t);
  const owner = identity(8373, 'linux');
  const launcher = fakeLauncher(9373);
  const interceptor = new FreshTerminalInterceptor({ dataDir, platform: 'linux' });
  configurePosixLaunch(interceptor, owner, launcher);
  stopMonitor(interceptor);
  let runningNow = true;
  interceptor._inspectSessionIdentity = async () => runningNow
    ? running({ ...owner })
    : { state: 'absent' };
  const events = [];
  interceptor.onStatusChange = event => events.push(event);

  await interceptor.activate(8080);
  const recoveryFile = path.join(dataDir, JOURNAL_NAME);
  assert.equal(fs.existsSync(recoveryFile), true);

  runningNow = false;
  exitLauncher(launcher);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(interceptor.sessions.size, 0);
  assert.equal(interceptor.processes.length, 0);
  assert.equal(interceptor.active, false);
  assert.equal(fs.existsSync(recoveryFile), false);
  assert.equal(events.at(-1).reason, 'exited');
});
