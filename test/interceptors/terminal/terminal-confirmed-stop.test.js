import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { FreshTerminalInterceptor } from '../../../src/interceptors/terminal-interceptors.js';

function identity(pid = 8101, overrides = {}) {
  return Object.freeze({
    pid,
    startTime: '123456',
    executable: '/bin/zsh',
    ...overrides
  });
}

function running(processIdentity) {
  return { state: 'running', identity: processIdentity };
}

function sessionInterceptor(owner = identity()) {
  const interceptor = new FreshTerminalInterceptor();
  interceptor.sessions.set(owner.pid, owner);
  interceptor.active = true;
  interceptor.gracefulExitTimeoutMs = 0;
  interceptor.forceExitTimeoutMs = 0;
  interceptor.sessionExitPollIntervalMs = 1;
  interceptor._startStatusMonitor = () => {};
  return interceptor;
}

function fakeLauncher(pid, onKill) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killSignals = [];
  proc.unref = () => {};
  proc.kill = signal => {
    proc.killSignals.push(signal);
    return onKill(signal, proc);
  };
  return proc;
}

function exitLauncher(proc, signal = null) {
  proc.exitCode = signal ? null : 0;
  proc.signalCode = signal;
  proc.emit('exit', proc.exitCode, signal);
}

test('Stop clears an owned shell only after SIGTERM produces a confirmed exit', async () => {
  const owner = identity(8101);
  const interceptor = sessionInterceptor(owner);
  let state = 'same';
  let observations = 0;
  interceptor.gracefulExitTimeoutMs = 100;
  interceptor._observeSessionIdentity = async () => {
    observations++;
    return state === 'same' ? running({ ...owner }) : { state: 'absent' };
  };
  interceptor._sleep = async () => { state = 'absent'; };
  const signals = [];
  interceptor._killSession = (pid, signal) => {
    signals.push([pid, signal]);
    return true;
  };
  const statuses = [];
  interceptor.onStatusChange = event => statuses.push(event);

  await interceptor.deactivate();

  assert.deepEqual(signals, [[owner.pid, 'SIGTERM']]);
  assert.ok(observations >= 4, 'Stop polls the same identity until exit is observed');
  assert.equal(interceptor.sessions.size, 0);
  assert.equal(interceptor.active, false);
  assert.deepEqual(statuses.map(event => event.reason), ['inactive']);
});

test('Stop escalates an exact shell to SIGKILL and waits for its confirmed exit', async () => {
  const owner = identity(8102);
  const interceptor = sessionInterceptor(owner);
  let state = 'same';
  interceptor._observeSessionIdentity = async () => state === 'same'
    ? running({ ...owner })
    : { state: 'absent' };
  const signals = [];
  interceptor._killSession = (_pid, signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') state = 'absent';
    return true;
  };

  await interceptor.deactivate();

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(interceptor.sessions.size, 0);
  assert.equal(interceptor.active, false);
});

test('a shell surviving both signals remains active and retryable', async () => {
  const owner = identity(8103);
  const interceptor = sessionInterceptor(owner);
  interceptor._observeSessionIdentity = async () => running({ ...owner });
  const signals = [];
  interceptor._killSession = (_pid, signal) => {
    signals.push(signal);
    return true;
  };
  const statuses = [];
  interceptor.onStatusChange = event => statuses.push(event);

  await assert.rejects(interceptor.deactivate(), /process state was preserved so Stop can be retried/);

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(interceptor.sessions.size, 1);
  assert.equal(interceptor.sessions.get(owner.pid).cleanupPending, true);
  assert.equal(interceptor.active, true);
  assert.equal(statuses.at(-1).reason, 'stop-failed');
  assert.equal(statuses.at(-1).active, true);
});

test('identity replacement after SIGTERM clears ownership without signalling the replacement', async () => {
  const owner = identity(8104);
  const replacement = identity(owner.pid, {
    startTime: '999999',
    executable: '/usr/bin/unrelated'
  });
  const interceptor = sessionInterceptor(owner);
  let current = owner;
  interceptor._observeSessionIdentity = async () => running({ ...current });
  const signals = [];
  interceptor._killSession = (_pid, signal) => {
    signals.push(signal);
    current = replacement;
    return true;
  };

  await interceptor.deactivate();

  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(interceptor.sessions.size, 0);
  assert.equal(interceptor.active, false);
});

test('identity inspection becoming ambiguous after SIGTERM retains safe retry state', async () => {
  const owner = identity(8105);
  const interceptor = sessionInterceptor(owner);
  let ambiguous = false;
  interceptor._observeSessionIdentity = async () => ambiguous
    ? { state: 'unknown', error: new Error('inspection denied') }
    : running({ ...owner });
  const signals = [];
  interceptor._killSession = (_pid, signal) => {
    signals.push(signal);
    ambiguous = true;
    return true;
  };

  await assert.rejects(interceptor.deactivate(), /Stop can be retried/);

  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(interceptor.sessions.size, 1);
  assert.equal(interceptor.sessions.get(owner.pid).cleanupPending, true);
  assert.equal(interceptor.active, true);
  assert.equal(await interceptor.isActive(), true, 'ambiguous cleanup ownership survives refresh');
});

test('launcher handles are cleared only after exit and escalate when needed', async () => {
  const graceful = fakeLauncher(8201, (_signal, proc) => {
    queueMicrotask(() => exitLauncher(proc));
    return true;
  });
  const forced = fakeLauncher(8202, (signal, proc) => {
    if (signal === 'SIGKILL') queueMicrotask(() => exitLauncher(proc, 'SIGKILL'));
    return true;
  });
  const interceptor = new FreshTerminalInterceptor();
  interceptor.processes.push(graceful, forced);
  interceptor.active = true;
  interceptor.gracefulExitTimeoutMs = 0;
  interceptor.forceExitTimeoutMs = 10;

  await interceptor.deactivate();

  assert.deepEqual(graceful.killSignals, ['SIGTERM']);
  assert.deepEqual(forced.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(interceptor.processes, []);
  assert.equal(interceptor.active, false);
});

test('a surviving launcher handle remains active and retryable', async () => {
  const launcher = fakeLauncher(8203, () => true);
  const interceptor = new FreshTerminalInterceptor();
  interceptor.processes.push(launcher);
  interceptor.active = true;
  interceptor.gracefulExitTimeoutMs = 0;
  interceptor.forceExitTimeoutMs = 0;
  interceptor._startStatusMonitor = () => {};
  const statuses = [];
  interceptor.onStatusChange = event => statuses.push(event);

  await assert.rejects(interceptor.deactivate(), /Stop can be retried/);

  assert.deepEqual(launcher.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(interceptor.processes, [launcher]);
  assert.equal(interceptor.active, true);
  assert.equal(statuses.at(-1).reason, 'stop-failed');
  assert.equal(statuses.some(event => event.reason === 'inactive'), false);
});

test('a repeated Stop can finish cleanup retained by the first failed attempt', async () => {
  const owner = identity(8106);
  const interceptor = sessionInterceptor(owner);
  let state = 'same';
  let stopAttempt = 1;
  interceptor._observeSessionIdentity = async () => state === 'same'
    ? running({ ...owner })
    : { state: 'absent' };
  const signals = [];
  interceptor._killSession = (_pid, signal) => {
    signals.push(signal);
    if (stopAttempt === 2 && signal === 'SIGTERM') state = 'absent';
    return true;
  };

  await assert.rejects(interceptor.deactivate(), /Stop can be retried/);
  assert.equal(interceptor.active, true);

  stopAttempt = 2;
  await interceptor.deactivate();

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL', 'SIGTERM']);
  assert.equal(interceptor.sessions.size, 0);
  assert.equal(interceptor.active, false);
});
