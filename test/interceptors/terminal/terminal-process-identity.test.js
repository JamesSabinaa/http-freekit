import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FreshTerminalInterceptor } from '../../../src/interceptors/terminal-interceptors.js';

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

function ownershipMarker(name) {
  return path.join(
    os.tmpdir(),
    `http-freekit-terminal-handshake-${name}`,
    'ownership.marker'
  );
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

test('a Linux owner remains tracked after the acknowledged shell execs its login shell', async () => {
  const interceptor = new FreshTerminalInterceptor({ platform: 'linux' });
  const owner = identity(7106, {
    executable: '/usr/bin/dash',
    bootId: '11111111-1111-4111-8111-111111111111'
  });
  const loginShell = { ...owner, executable: '/usr/bin/bash' };
  interceptor.sessions.set(owner.pid, owner);
  interceptor.active = true;
  interceptor.gracefulExitTimeoutMs = 0;
  interceptor.forceExitTimeoutMs = 0;
  interceptor._startStatusMonitor = () => {};
  let running = true;
  interceptor._inspectSessionIdentity = async () => running
    ? { state: 'running', identity: { ...loginShell } }
    : { state: 'absent' };
  const signalled = [];
  interceptor._killSession = pid => {
    signalled.push(pid);
    running = false;
    return true;
  };

  assert.equal(await interceptor.isActive(), true);
  await interceptor.deactivate();

  assert.deepEqual(signalled, [owner.pid]);
  assert.equal(interceptor.sessions.size, 0);
  assert.equal(interceptor.active, false);
});

test('a macOS owner with a matching PID and start time from another boot is never signalled', async () => {
  const interceptor = new FreshTerminalInterceptor({ platform: 'darwin' });
  const owner = identity(7107, {
    executable: '/bin/sh',
    bootId: '11111111-1111-4111-8111-111111111111',
    ownershipMarkerFile: ownershipMarker('cross-boot')
  });
  interceptor.sessions.set(owner.pid, owner);
  interceptor.active = true;
  interceptor._inspectSessionIdentity = async () => running({
    ...owner,
    executable: '/bin/zsh',
    bootId: '22222222-2222-4222-8222-222222222222'
  });
  const signalled = [];
  interceptor._killSession = pid => signalled.push(pid);

  assert.equal(await interceptor.isActive(), false);
  await interceptor.deactivate();

  assert.deepEqual(signalled, []);
  assert.equal(interceptor.sessions.size, 0);
});

test('a macOS PID with a changed executable in the same start-time second is never signalled', async () => {
  const interceptor = new FreshTerminalInterceptor({ platform: 'darwin' });
  const owner = identity(7108, {
    executable: '/bin/zsh',
    bootId: '11111111-1111-4111-8111-111111111111',
    ownershipMarkerFile: ownershipMarker('pid-reuse')
  });
  interceptor.sessions.set(owner.pid, owner);
  interceptor.active = true;
  interceptor._inspectSessionIdentity = async () => running({
    ...owner,
    executable: '/usr/bin/unrelated',
    ownershipMarkerFile: undefined
  });
  const signalled = [];
  interceptor._killSession = pid => signalled.push(pid);

  assert.equal(await interceptor.isActive(), false);
  await interceptor.deactivate();

  assert.deepEqual(signalled, []);
  assert.equal(interceptor.sessions.size, 0);
});

test('a macOS owner remains tracked when its open-file marker survives exec', async () => {
  const interceptor = new FreshTerminalInterceptor({ platform: 'darwin' });
  const owner = identity(7109, {
    executable: '/bin/zsh',
    bootId: '11111111-1111-4111-8111-111111111111',
    ownershipMarkerFile: ownershipMarker('exec-continuity')
  });
  const execedShell = { ...owner, executable: '/bin/bash' };
  interceptor.sessions.set(owner.pid, owner);
  interceptor.active = true;
  interceptor.gracefulExitTimeoutMs = 0;
  interceptor.forceExitTimeoutMs = 0;
  interceptor._startStatusMonitor = () => {};
  let runningNow = true;
  interceptor._inspectSessionIdentity = async () => runningNow
    ? running({ ...execedShell })
    : { state: 'absent' };
  const signalled = [];
  interceptor._killSession = pid => {
    signalled.push(pid);
    runningNow = false;
    return true;
  };

  assert.equal(await interceptor.isActive(), true);
  await interceptor.deactivate();

  assert.deepEqual(signalled, [owner.pid]);
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

test('failed POSIX identity acquisition rejects the unacknowledged shell PID', async () => {
  const interceptor = new FreshTerminalInterceptor();
  const launcher = fakeLauncher(7201);
  interceptor._platform = () => 'linux';
  interceptor._createPosixHandshake = () => ({
    directory: null,
    reportFile: '/tmp/freekit-bug-307.json',
    acknowledgementFile: '/tmp/freekit-bug-307.ack',
    nonce: 'bug-307-nonce'
  });
  interceptor._waitForPosixShellReport = async () => 7202;
  interceptor._cleanupTerminalHandshake = () => {};
  interceptor._spawnDetached = async () => launcher;
  interceptor._inspectSessionIdentity = async () => ({
    state: 'unknown',
    error: new Error('permission denied')
  });
  const signalled = [];
  interceptor._killSession = pid => signalled.push(pid);

  launcher.kill = (signal = 'SIGTERM') => {
    launcher.killed = true;
    launcher.signalCode = signal;
    queueMicrotask(() => launcher.emit('exit', null, signal));
    return true;
  };
  await assert.rejects(
    interceptor.activate(8080),
    /launch was rejected.*identity could not be verified/
  );

  assert.equal(interceptor.sessions.size, 0);
  assert.equal(interceptor.active, false);
  assert.deepEqual(signalled, []);
  assert.equal(launcher.killed, true);
});

test('the macOS identity lookup is bounded and records start time plus normalized executable', async () => {
  const interceptor = new FreshTerminalInterceptor();
  interceptor._platform = () => 'darwin';
  interceptor._environment = () => ({ PATH: '/usr/bin' });
  interceptor._identityInspectionTimeoutMs = () => 321;
  const invocations = [];
  const markerFile = ownershipMarker('identity-inspection');
  interceptor._execFile = async (command, args, options) => {
    invocations.push({ command, args, options });
    if (command === '/usr/sbin/sysctl') {
      return { stdout: '11111111-1111-4111-8111-111111111111\n', stderr: '' };
    }
    if (command === '/usr/sbin/lsof') {
      return { stdout: `p7301\nf9\nn${markerFile}\n`, stderr: '' };
    }
    return { stdout: '7301 Sun Jul 26 12:34:56 2026 /bin/../bin/zsh\n', stderr: '' };
  };

  const observation = await interceptor._inspectSessionIdentity(7301, markerFile);

  assert.equal(observation.state, 'running');
  assert.deepEqual(observation.identity, {
    pid: 7301,
    startTime: String(Date.parse('Sun Jul 26 12:34:56 2026')),
    executable: '/bin/zsh',
    bootId: '11111111-1111-4111-8111-111111111111',
    ownershipMarkerFile: markerFile
  });
  const invocation = invocations.find(candidate => candidate.command === '/bin/ps');
  assert.equal(invocation.command, '/bin/ps');
  assert.equal(invocation.options.timeout, 321);
  assert.equal(invocation.options.maxBuffer, 16 * 1024);
  assert.equal(invocation.options.env.LC_ALL, 'C');
  assert.equal(invocations.filter(candidate => candidate.command === '/usr/sbin/sysctl').length, 1);
  const lsofInvocation = invocations.find(candidate => candidate.command === '/usr/sbin/lsof');
  assert.deepEqual(lsofInvocation.args, ['-a', '-p', '7301', '-Fpfn', markerFile]);
  assert.equal(lsofInvocation.options.timeout, 321);
});

test('macOS clears a same-second PID whose ownership marker is no longer open', async () => {
  const interceptor = new FreshTerminalInterceptor({ platform: 'darwin' });
  const markerFile = ownershipMarker('closed-marker');
  const owner = identity(7302, {
    startTime: String(Date.parse('Sun Jul 26 12:34:56 2026')),
    executable: '/bin/zsh',
    bootId: '11111111-1111-4111-8111-111111111111',
    ownershipMarkerFile: markerFile
  });
  interceptor.sessions.set(owner.pid, owner);
  interceptor.active = true;
  interceptor._execFile = async command => {
    if (command === '/usr/sbin/sysctl') {
      return { stdout: `${owner.bootId}\n`, stderr: '' };
    }
    if (command === '/usr/sbin/lsof') {
      const error = new Error('no matching open file');
      error.code = 1;
      throw error;
    }
    return { stdout: '7302 Sun Jul 26 12:34:56 2026 /bin/zsh\n', stderr: '' };
  };
  const signalled = [];
  interceptor._killSession = pid => signalled.push(pid);

  assert.equal(await interceptor.isActive(), false);
  await interceptor.deactivate();

  assert.deepEqual(signalled, []);
  assert.equal(interceptor.sessions.size, 0);
});

test('macOS detects a cross-boot PID before consulting a stale ownership marker', async () => {
  const interceptor = new FreshTerminalInterceptor({ platform: 'darwin' });
  const owner = identity(7303, {
    startTime: String(Date.parse('Sun Jul 26 12:34:56 2026')),
    executable: '/bin/zsh',
    bootId: '11111111-1111-4111-8111-111111111111',
    ownershipMarkerFile: ownershipMarker('stale-cross-boot')
  });
  interceptor.sessions.set(owner.pid, owner);
  interceptor.active = true;
  let lsofCalls = 0;
  interceptor._execFile = async command => {
    if (command === '/usr/sbin/sysctl') {
      return { stdout: '22222222-2222-4222-8222-222222222222\n', stderr: '' };
    }
    if (command === '/usr/sbin/lsof') {
      lsofCalls++;
      throw new Error('a cross-boot marker must not be queried');
    }
    return { stdout: '7303 Sun Jul 26 12:34:56 2026 /bin/zsh\n', stderr: '' };
  };

  assert.equal(await interceptor.isActive(), false);
  assert.equal(lsofCalls, 0);
});

test('macOS retains ownership when its marker inspection tool is unavailable', async () => {
  const interceptor = new FreshTerminalInterceptor({ platform: 'darwin' });
  const owner = identity(7304, {
    startTime: String(Date.parse('Sun Jul 26 12:34:56 2026')),
    executable: '/bin/zsh',
    bootId: '11111111-1111-4111-8111-111111111111',
    ownershipMarkerFile: ownershipMarker('lsof-unavailable')
  });
  interceptor.sessions.set(owner.pid, owner);
  interceptor.active = true;
  interceptor._startStatusMonitor = () => {};
  interceptor._execFile = async command => {
    if (command === '/usr/sbin/sysctl') {
      return { stdout: `${owner.bootId}\n`, stderr: '' };
    }
    if (command === '/usr/sbin/lsof') {
      const error = new Error('spawn lsof ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    return { stdout: '7304 Sun Jul 26 12:34:56 2026 /bin/zsh\n', stderr: '' };
  };
  const signalled = [];
  interceptor._killSession = pid => signalled.push(pid);

  assert.equal(await interceptor.isActive(), true);
  await assert.rejects(interceptor.deactivate(), /Stop can be retried/);

  assert.deepEqual(signalled, []);
  assert.equal(interceptor.sessions.size, 1);
});

test('Linux stat parsing uses the kernel start tick even when the command contains parentheses', () => {
  const interceptor = new FreshTerminalInterceptor();
  const fields = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 1)), '987654', '21'];
  const stat = `7401 (shell (login)) ${fields.join(' ')}`;

  assert.equal(interceptor._parseLinuxProcessStart(stat, 7401), '987654');
});
