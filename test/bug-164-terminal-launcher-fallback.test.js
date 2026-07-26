import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { FreshTerminalInterceptor } from '../src/interceptors/terminal-interceptors.js';

function fakeLauncher(pid, exitCode = null) {
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
  interceptor._platform = () => 'win32';
  interceptor._launcherStartupGraceMs = () => 5;
  interceptor._spawnDetached = async command => {
    commands.push(command);
    return launchers.shift();
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

test('Linux Fresh Terminal promptly tries the next candidate after startup failure', async () => {
  const failed = fakeLauncher(4151, 1);
  const working = fakeLauncher(4152);
  const interceptor = new FreshTerminalInterceptor();
  const commands = [];
  interceptor._platform = () => 'linux';
  interceptor._launcherStartupGraceMs = () => 5;
  interceptor._createPidFilePath = () => '/tmp/freekit-bug-164.pid';
  interceptor._waitForShellPid = async () => 4153;
  interceptor._inspectSessionIdentity = async pid => ({
    state: 'running',
    identity: { pid, startTime: '400', executable: '/bin/sh' }
  });
  interceptor._spawnDetached = async command => {
    commands.push(command);
    return commands.length === 1 ? failed : working;
  };

  const result = await interceptor.activate(8080);

  assert.deepEqual(commands, ['gnome-terminal', 'xterm']);
  assert.equal(result.pid, 4153);
  assert.equal(interceptor.processes[0], working);
  assert.equal(failed.killed, true);

  await interceptor.deactivate();
});

test('Fresh Terminal does not report success when every launcher fails at startup', async () => {
  const { interceptor, commands } = windowsInterceptor([
    fakeLauncher(4201, 1),
    fakeLauncher(4202, 2),
    fakeLauncher(4203, 3)
  ]);

  await assert.rejects(() => interceptor.activate(8080), /No supported terminal found/);
  assert.deepEqual(commands, ['wt.exe', 'powershell.exe', 'cmd.exe']);
  assert.equal(interceptor.active, false);
  assert.deepEqual(interceptor.processes, []);
});
