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
  interceptor._waitForWindowsShellReport = async () => ({
    pid: 7654,
    startTime: '300',
    executable: 'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe'
  });
  interceptor._acknowledgeWindowsShell = async () => {};
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
  assert.match(launch.args[5], /pid = \[int\]\$PID/);
  assert.match(launch.args[5], /WriteAllText\(.+ConvertTo-Json/);
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

test('Windows Terminal rejects a reported PID that was reused before identity inspection', async () => {
  const interceptor = new FreshTerminalInterceptor();
  interceptor._platform = () => 'win32';
  interceptor._windowsHandshakeCloseDelayMs = () => 0;
  interceptor._waitForWindowsShellReport = async () => ({
    pid: 7664,
    startTime: '400',
    executable: 'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe'
  });
  interceptor._inspectSessionIdentity = async pid => ({
    state: 'running',
    identity: {
      pid,
      startTime: '401',
      executable: 'c:\\windows\\system32\\notepad.exe'
    }
  });
  interceptor._acknowledgeWindowsShell = async () => {
    assert.fail('a replaced PID must never receive the ownership acknowledgement');
  };
  const launcher = fakeLauncher(7663);
  interceptor._spawnDetached = async command => {
    if (command === 'wt.exe') return launcher;
    throw new Error(`${command} unavailable`);
  };
  interceptor._killSession = () => assert.fail('a replacement process must never be signalled');

  await assert.rejects(interceptor.activate(8080), /No supported terminal found/);

  assert.equal(launcher.killed, true);
  assert.equal(interceptor.sessions.size, 0);
  assert.equal(interceptor.active, false);
});

test('an unacknowledged Windows Terminal child fails closed before cmd fallback', async () => {
  const interceptor = new FreshTerminalInterceptor();
  interceptor._platform = () => 'win32';
  let closeDelayCalls = 0;
  interceptor._windowsHandshakeCloseDelayMs = () => 0;
  interceptor._sleep = async () => { closeDelayCalls++; };
  interceptor._waitForWindowsShellReport = async () => {
    throw new Error('identity report unreadable');
  };
  const wtLauncher = fakeLauncher(7673);
  const cmdLauncher = fakeLauncher(7675);
  const launches = [];
  interceptor._spawnDetached = async (command, args) => {
    launches.push({ command, args });
    if (command === 'wt.exe') return wtLauncher;
    if (command === 'powershell.exe') throw new Error('PowerShell unavailable');
    return cmdLauncher;
  };

  const result = await interceptor.activate(8080);

  assert.equal(result.pid, cmdLauncher.pid);
  assert.equal(wtLauncher.killed, true);
  assert.ok(closeDelayCalls >= 1);
  assert.match(launches[0].args[5], /ConvertTo-Json -Compress/);
  assert.match(launches[0].args[5], /\.ack/);
  assert.match(launches[0].args[5], /exit 1/);

  interceptor._stopStatusMonitor();
  cmdLauncher.exitCode = 0;
  cmdLauncher.emit('exit', 0);
  await new Promise(resolve => setImmediate(resolve));
});

test('durable cmd fallback rejects a launcher PID already reused by another executable', async () => {
  const interceptor = new FreshTerminalInterceptor({
    platform: 'win32',
    recoveryFile: 'unused-fresh-terminal-journal.json'
  });
  const cmdLauncher = fakeLauncher(7685);
  cmdLauncher.exitCode = 0;
  interceptor._spawnDetached = async command => {
    if (command === 'cmd.exe') return cmdLauncher;
    throw new Error(`${command} unavailable`);
  };
  interceptor._inspectSessionIdentity = async pid => ({
    state: 'running',
    identity: {
      pid,
      startTime: '500',
      executable: 'c:\\windows\\system32\\notepad.exe'
    }
  });
  interceptor._killSession = () => assert.fail('the reused cmd PID must never be signalled');

  await assert.rejects(interceptor.activate(8080), /No supported terminal found/);

  assert.equal(interceptor.sessions.size, 0);
  assert.equal(interceptor.active, false);
});
