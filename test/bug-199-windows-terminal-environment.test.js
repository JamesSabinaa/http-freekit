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
  proc.kill = () => {
    proc.killed = true;
    return true;
  };
  return proc;
}

test('Windows Terminal new tabs inherit the supplied FreeKit environment', async () => {
  const interceptor = new FreshTerminalInterceptor();
  const launcher = fakeLauncher(6101);
  const launches = [];
  interceptor._platform = () => 'win32';
  interceptor._launcherStartupGraceMs = () => 1;
  interceptor._spawnDetached = async (command, args, options) => {
    launches.push({ command, args, options });
    return launcher;
  };

  const result = await interceptor.activate(8765);

  assert.equal(result.pid, launcher.pid);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].command, 'wt.exe');
  assert.deepEqual(launches[0].args, ['new-tab', '--inheritEnvironment']);
  assert.equal(launches[0].options.env.HTTP_PROXY, 'http://127.0.0.1:8765');
  assert.equal(launches[0].options.env.HTTPS_PROXY, 'http://127.0.0.1:8765');
  assert.equal(launches[0].options.detached, true);

  await interceptor.deactivate();
});
