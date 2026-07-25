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
  interceptor._isSessionRunning = pid => pid === 4321;
  const launcher = fakeLauncher();
  let launch;
  interceptor._spawnDetached = async (command, args, options) => {
    launch = { command, args, options };
    return launcher;
  };
  const killed = [];
  interceptor._killSession = pid => killed.push(pid);

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
  interceptor._isSessionRunning = () => true;
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
