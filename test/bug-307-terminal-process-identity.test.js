import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { FreshTerminalInterceptor } from '../src/interceptors/terminal-interceptors.js';

function identity(pid, overrides = {}) {
  return {
    pid,
    startTime: '123456',
    executable: '/bin/zsh',
    ...overrides
  };
}

function running(processIdentity) {
  return { state: 'running', identity: processIdentity };
}

function fakeLauncher(pid) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.killed = false;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.unref = () => {};
  proc.kill = () => {
    proc.killed = true;
    return true;
  };
  return proc;
}

test('a matching terminal owner remains active and is revalidated before SIGTERM', async () => {
  const interceptor = new FreshTerminalInterceptor();
  const owner = identity(7101);
  interceptor.sessions.set(owner.pid, owner);
  interceptor.active = true;
  interceptor.gracefulExitTimeoutMs = 0;
  interceptor.forceExitTimeoutMs = 0;
  interceptor._startStatusMonitor = () => {};
  let inspections = 0;
  let running = true;
  interceptor._inspectSessionIdentity = async pid => {
    inspections++;
    assert.equal(pid, owner.pid);
    return running ? { state: 'running', identity: { ...owner } } : { state: 'absent' };
  };
  const signalled = [];
  interceptor._killSession = pid => {
    signalled.push(pid);
    running = false;
    return true;
  };

  assert.equal(await interceptor.isActive(), true);
  assert.equal(interceptor.toJSON().pid, owner.pid);
  await interceptor.deactivate();

  assert.ok(inspections >= 3, 'Stop revalidates immediately before signalling and confirms exit');
  assert.deepEqual(signalled, [owner.pid]);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.sessions.size, 0);
});

test('an absent terminal owner is removed and publishes the existing exit transition', async () => {
  const interceptor = new FreshTerminalInterceptor();
  const owner = identity(7102);
  interceptor.sessions.set(owner.pid, owner);
  interceptor.active = true;
  interceptor._inspectSessionIdentity = async () => ({ state: 'absent' });
  const events = [];
  interceptor.onStatusChange = event => events.push(event);

  assert.equal(await interceptor.isActive(), false);

  assert.equal(interceptor.sessions.size, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'exited');
  assert.equal(events[0].active, false);
});

test('a reused PID is removed during refresh and is never signalled', async () => {
  const interceptor = new FreshTerminalInterceptor();
  const owner = identity(7103);
  interceptor.sessions.set(owner.pid, owner);
  interceptor.active = true;
  interceptor._inspectSessionIdentity = async () => running(identity(owner.pid, {
    startTime: '999999',
    executable: '/usr/bin/unrelated'
  }));
  const signalled = [];
  interceptor._killSession = pid => signalled.push(pid);

  assert.equal(await interceptor.isActive(), false);
  await interceptor.deactivate();

  assert.equal(interceptor.sessions.size, 0);
  assert.deepEqual(signalled, []);
});

test('Stop skips a PID that changed identity after the last successful refresh', async () => {
  const interceptor = new FreshTerminalInterceptor();
  const owner = identity(7104);
  interceptor.sessions.set(owner.pid, owner);
  interceptor.active = true;
  const observations = [
    running({ ...owner }),
    running(identity(owner.pid, { startTime: '654321' }))
  ];
  interceptor._inspectSessionIdentity = async () => observations.shift();
  const signalled = [];
  interceptor._killSession = pid => signalled.push(pid);

  assert.equal(await interceptor.isActive(), true);
  await interceptor.deactivate();

  assert.deepEqual(signalled, [], 'the stale PID is not trusted from the earlier refresh');
});

test('an ambiguous or failed identity lookup never authorizes a signal and remains retryable', async () => {
  for (const inspect of [
    async () => ({ state: 'unknown' }),
    async () => ({ state: 'unknown', error: new Error('inspection timed out') }),
    async () => { throw new Error('inspection crashed'); }
  ]) {
    const interceptor = new FreshTerminalInterceptor();
    const owner = identity(7105);
    interceptor.sessions.set(owner.pid, owner);
    interceptor.active = true;
    interceptor._startStatusMonitor = () => {};
    interceptor._inspectSessionIdentity = inspect;
    const signalled = [];
    interceptor._killSession = pid => signalled.push(pid);

    await assert.rejects(interceptor.deactivate(), /Stop can be retried/);

    assert.deepEqual(signalled, []);
    assert.equal(interceptor.active, true);
    assert.equal(interceptor.sessions.size, 1);
  }
});

test('failed identity acquisition tracks only the launcher handle, not the reported shell PID', async () => {
  const interceptor = new FreshTerminalInterceptor();
  const launcher = fakeLauncher(7201);
  interceptor._platform = () => 'linux';
  interceptor._createPidFilePath = () => '/tmp/freekit-bug-307.pid';
  interceptor._waitForShellPid = async () => 7202;
  interceptor._spawnDetached = async () => launcher;
  interceptor._inspectSessionIdentity = async () => ({
    state: 'unknown',
    error: new Error('permission denied')
  });
  const signalled = [];
  interceptor._killSession = pid => signalled.push(pid);

  const result = await interceptor.activate(8080);

  assert.equal(result.pid, launcher.pid);
  assert.equal(interceptor.sessions.size, 0);
  assert.equal(interceptor.active, true, 'the known launcher handle may still be tracked');

  launcher.kill = (signal = 'SIGTERM') => {
    launcher.killed = true;
    launcher.signalCode = signal;
    queueMicrotask(() => launcher.emit('exit', null, signal));
    return true;
  };
  await interceptor.deactivate();
  assert.deepEqual(signalled, []);
  assert.equal(launcher.killed, true);
});

test('the macOS identity lookup is bounded and records start time plus normalized executable', async () => {
  const interceptor = new FreshTerminalInterceptor();
  interceptor._platform = () => 'darwin';
  interceptor._environment = () => ({ PATH: '/usr/bin' });
  interceptor._identityInspectionTimeoutMs = () => 321;
  let invocation;
  interceptor._execFile = async (command, args, options) => {
    invocation = { command, args, options };
    return { stdout: '7301 Sun Jul 26 12:34:56 2026 /bin/../bin/zsh\n', stderr: '' };
  };

  const observation = await interceptor._inspectSessionIdentity(7301);

  assert.equal(observation.state, 'running');
  assert.deepEqual(observation.identity, {
    pid: 7301,
    startTime: String(Date.parse('Sun Jul 26 12:34:56 2026')),
    executable: '/bin/zsh'
  });
  assert.equal(invocation.command, '/bin/ps');
  assert.equal(invocation.options.timeout, 321);
  assert.equal(invocation.options.maxBuffer, 16 * 1024);
  assert.equal(invocation.options.env.LC_ALL, 'C');
});

test('Linux stat parsing uses the kernel start tick even when the command contains parentheses', () => {
  const interceptor = new FreshTerminalInterceptor();
  const fields = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 1)), '987654', '21'];
  const stat = `7401 (shell (login)) ${fields.join(' ')}`;

  assert.equal(interceptor._parseLinuxProcessStart(stat, 7401), '987654');
});
