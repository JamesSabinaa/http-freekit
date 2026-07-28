import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { FreshTerminalInterceptor } from '../src/interceptors/terminal-interceptors.js';

function fakeLauncher(pid = 100) {
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

test('macOS terminal activation tracks the interactive shell after osascript exits', async () => {
  const interceptor = new FreshTerminalInterceptor();
  interceptor._platform = () => 'darwin';
  interceptor._createPidFilePath = () => '/tmp/freekit-shell.pid';
  interceptor._waitForShellPid = async () => 4321;
  let sessionRunning = true;
  interceptor._inspectSessionIdentity = async pid => ({
    ...(sessionRunning ? {
      state: 'running',
      identity: { pid, startTime: '100', executable: '/bin/zsh' }
    } : { state: 'absent' })
  });
  const launcher = fakeLauncher();
  let launch;
  interceptor._spawnDetached = async (command, args, options) => {
    launch = { command, args, options };
    return launcher;
  };
  const killed = [];
  interceptor._killSession = pid => {
    killed.push(pid);
    sessionRunning = false;
    return true;
  };

  const result = await interceptor.activate(8080);
  assert.equal(result.pid, 4321);
  assert.equal(launch.command, 'osascript');
  assert.match(launch.args[1], /printf '%s' \\"\$\$\\"/);
  assert.match(launch.args[1], /freekit-shell\.pid/);

  launcher.exitCode = 0;
  launcher.emit('exit', 0);
  assert.equal(await interceptor.isActive(), true);

  await interceptor.deactivate();
  assert.deepEqual(killed, [4321]);
  assert.equal(interceptor.active, false);
});

test('Linux terminal commands wait for and identify their interactive shell', async () => {
  const interceptor = new FreshTerminalInterceptor();
  interceptor._platform = () => 'linux';
  interceptor._createPidFilePath = () => '/tmp/freekit-linux-shell.pid';
  interceptor._waitForShellPid = async () => 9876;
  interceptor._inspectSessionIdentity = async pid => ({
    state: 'running',
    identity: { pid, startTime: '200', executable: '/bin/bash' }
  });
  const launcher = fakeLauncher();
  let launch;
  interceptor._spawnDetached = async (command, args, options) => {
    launch = { command, args, options };
    return launcher;
  };

  const result = await interceptor.activate(9090);
  assert.equal(result.pid, 9876);
  assert.equal(launch.command, 'gnome-terminal');
  assert.deepEqual(launch.args.slice(0, 4), ['--wait', '--', 'sh', '-c']);
  assert.match(launch.args[4], /printf '%s' "\$\$"/);
  assert.match(launch.args[4], /exec "\$\{SHELL:-\/bin\/sh\}" -l/);
});

test('Windows Terminal tracks its durable PowerShell child without a recovery journal', async () => {
  const interceptor = new FreshTerminalInterceptor();
  interceptor._platform = () => 'win32';
  interceptor._createPidFilePath = () => 'C:\\Temp\\freekit-shell.pid';
  interceptor._waitForShellPid = async () => 7654;
  let sessionRunning = true;
  interceptor._inspectSessionIdentity = async pid => sessionRunning && pid === 7654
    ? {
        state: 'running',
        identity: {
          pid,
          startTime: '300',
          executable: 'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe'
        }
      }
    : { state: 'absent' };
  const launcher = fakeLauncher(7653);
  let launch;
  interceptor._spawnDetached = async (command, args, options) => {
    launch = { command, args, options };
    return launcher;
  };
  const killed = [];
  interceptor._killSession = pid => {
    killed.push(pid);
    sessionRunning = false;
    return true;
  };

  const result = await interceptor.activate(8080);
  assert.equal(result.pid, 7654);
  assert.equal(launch.command, 'wt.exe');
  assert.deepEqual(launch.args.slice(0, 5), [
    'new-tab', '--inheritEnvironment', 'powershell.exe', '-NoExit', '-Command'
  ]);
  assert.match(launch.args[5], /WriteAllText\(.+\$PID/);
  assert.equal(interceptor.sessions.has(7654), true);
  assert.equal(interceptor.sessions.has(launcher.pid), false);

  launcher.exitCode = 0;
  launcher.emit('exit', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await interceptor.isActive(), true);

  await interceptor.deactivate();
  assert.deepEqual(killed, [7654]);
  assert.equal(interceptor.active, false);
});
