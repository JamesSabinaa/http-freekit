import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { FreshTerminalInterceptor } from '../src/interceptors/terminal-interceptors.js';

function fakeLauncher(pid) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.killed = false;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.unref = () => {};
  proc.kill = (signal = 'SIGTERM') => {
    proc.killed = true;
    proc.signalCode = signal;
    queueMicrotask(() => proc.emit('exit', null, signal));
    return true;
  };
  return proc;
}

test('Windows Terminal new tabs inherit the supplied FreeKit environment', async () => {
  const interceptor = new FreshTerminalInterceptor();
  const launcher = fakeLauncher(6101);
  const launches = [];
  interceptor._platform = () => 'win32';
  interceptor._waitForWindowsShellReport = async () => ({
    pid: 6102,
    startTime: '6102',
    executable: 'c:\\windows\\powershell.exe'
  });
  interceptor._acknowledgeWindowsShell = async () => {};
  let sessionRunning = true;
  interceptor._inspectSessionIdentity = async pid => sessionRunning && pid === 6102
    ? {
        state: 'running',
        identity: { pid, startTime: '6102', executable: 'c:\\windows\\powershell.exe' }
      }
    : { state: 'absent' };
  interceptor._killSession = () => {
    sessionRunning = false;
    return true;
  };
  interceptor._spawnDetached = async (command, args, options) => {
    launches.push({ command, args, options });
    return launcher;
  };

  const result = await interceptor.activate(8765);

  assert.equal(result.pid, 6102);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].command, 'wt.exe');
  assert.deepEqual(launches[0].args.slice(0, 5), [
    'new-tab', '--inheritEnvironment', 'powershell.exe', '-NoExit', '-Command'
  ]);
  assert.match(launches[0].args[5], /pid = \[int\]\$PID/);
  assert.match(launches[0].args[5], /FileMode\]::CreateNew/);
  assert.match(launches[0].args[5], /ReadAllText/);
  assert.equal(launches[0].options.env.HTTP_PROXY, 'http://127.0.0.1:8765');
  assert.equal(launches[0].options.env.HTTPS_PROXY, 'http://127.0.0.1:8765');
  assert.equal(launches[0].options.detached, true);

  await interceptor.deactivate();
});
