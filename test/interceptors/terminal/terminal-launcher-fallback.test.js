import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { FreshTerminalInterceptor } from '../../../src/interceptors/terminal-interceptors.js';

function fakeLauncher(pid, exitCode = null) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.killed = false;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.unref = () => {};
  proc.kill = (signal = 'SIGTERM') => {
    proc.killed = true;
    if (proc.exitCode == null && proc.signalCode == null) {
      proc.signalCode = signal;
      queueMicrotask(() => proc.emit('exit', null, signal));
    }
    return true;
  };

  if (exitCode !== null) {
    queueMicrotask(() => {
      proc.exitCode = exitCode;
      proc.emit('exit', exitCode, null);
    });
  }
  return proc;
}

function windowsInterceptor(launchers) {
  const interceptor = new FreshTerminalInterceptor();
  const commands = [];
  let currentLauncher = null;
  const stoppedPids = new Set();
  interceptor._platform = () => 'win32';
  interceptor._windowsHandshakeCloseDelayMs = () => 0;
  interceptor._spawnDetached = async command => {
    commands.push(command);
    currentLauncher = launchers.shift();
    return currentLauncher;
  };
  interceptor._waitForWindowsShellReport = async () => ({
    pid: currentLauncher.pid,
    startTime: String(currentLauncher.pid),
    executable: 'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe'
  });
  interceptor._inspectSessionIdentity = async pid => stoppedPids.has(pid)
    ? { state: 'absent' }
    : {
        state: 'running',
        identity: {
          pid,
          startTime: String(pid),
          executable: 'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe'
        }
      };
  interceptor._acknowledgeWindowsShell = async () => {};
  interceptor._killSession = pid => {
    stoppedPids.add(pid);
    return true;
  };
  return { interceptor, commands };
}

test('Fresh Terminal falls back after a launcher exits nonzero during startup', async () => {
  const failed = fakeLauncher(4101, 1);
  const working = fakeLauncher(4102);
  const { interceptor, commands } = windowsInterceptor([failed, working]);

  const result = await interceptor.activate(8080);

  assert.deepEqual(commands, ['wt.exe', 'powershell.exe']);
  assert.equal(result.pid, 4102);
  assert.equal(interceptor.processes[0], working);
  assert.equal(interceptor.active, true);
  assert.equal(failed.killed, true);

  await interceptor.deactivate();
});

test('Fresh Terminal keeps watching a candidate until its shell identity is ready', async () => {
  const failed = fakeLauncher(4121);
  const working = fakeLauncher(4122);
  const { interceptor, commands } = windowsInterceptor([failed, working]);
  let reports = 0;
  let failedReportCancelled = false;
  interceptor._waitForWindowsShellReport = async (reportFile, timeoutMs, signal) => {
    const launcher = reports++ === 0 ? failed : working;
    if (launcher === failed) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 150);
        signal?.addEventListener('abort', () => {
          failedReportCancelled = true;
          clearTimeout(timer);
          reject(new Error('cancelled test report'));
        }, { once: true });
      });
    }
    return {
      pid: launcher.pid,
      startTime: String(launcher.pid),
      executable: 'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe'
    };
  };

  setTimeout(() => {
    failed.exitCode = 17;
    failed.emit('exit', 17, null);
  }, 110);

  const result = await interceptor.activate(8080);

  assert.deepEqual(commands, ['wt.exe', 'powershell.exe']);
  assert.equal(result.pid, 4122);
  assert.equal(interceptor.processes[0], working);
  assert.equal(interceptor.active, true);
  assert.equal(failed.killed, true);
  assert.equal(failedReportCancelled, true);
  assert.equal(failed.listenerCount('exit'), 0);
  assert.equal(failed.listenerCount('error'), 0);

  await interceptor.deactivate();
});

test('Linux Fresh Terminal keeps watching a launcher until its shell PID is ready', async () => {
  const failed = fakeLauncher(4151);
  const working = fakeLauncher(4152);
  const interceptor = new FreshTerminalInterceptor();
  const commands = [];
  interceptor._platform = () => 'linux';
  interceptor._createPidFilePath = () => '/tmp/freekit-bug-164.pid';
  let shellWaits = 0;
  let failedPidWaitCancelled = false;
  interceptor._waitForShellPid = async (pidFile, timeoutMs, signal) => {
    const shellPid = shellWaits++ === 0 ? 4153 : 4154;
    if (shellPid === 4153) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 150);
        signal?.addEventListener('abort', () => {
          failedPidWaitCancelled = true;
          clearTimeout(timer);
          reject(new Error('cancelled test PID wait'));
        }, { once: true });
      });
    }
    return shellPid;
  };
  let sessionRunning = true;
  interceptor._inspectSessionIdentity = async pid => ({
    ...(sessionRunning ? {
      state: 'running',
      identity: { pid, startTime: '400', executable: '/bin/sh' }
    } : { state: 'absent' })
  });
  interceptor._killSession = () => {
    sessionRunning = false;
    return true;
  };
  interceptor._spawnDetached = async command => {
    commands.push(command);
    return commands.length === 1 ? failed : working;
  };

  setTimeout(() => {
    failed.exitCode = 23;
    failed.emit('exit', 23, null);
  }, 110);

  const result = await interceptor.activate(8080);

  assert.deepEqual(commands, ['gnome-terminal', 'xterm']);
  assert.equal(result.pid, 4154);
  assert.equal(interceptor.processes[0], working);
  assert.equal(failed.killed, true);
  assert.equal(failedPidWaitCancelled, true);
  assert.equal(failed.listenerCount('exit'), 0);
  assert.equal(failed.listenerCount('error'), 0);

  await interceptor.deactivate();
});

test('Fresh Terminal does not report success when every launcher fails at startup', async () => {
  const { interceptor, commands } = windowsInterceptor([
    fakeLauncher(4201, 1),
    fakeLauncher(4202, 2)
  ]);

  await assert.rejects(() => interceptor.activate(8080), /No supported terminal found/);
  assert.deepEqual(commands, ['wt.exe', 'powershell.exe']);
  assert.equal(interceptor.active, false);
  assert.deepEqual(interceptor.processes, []);
});
