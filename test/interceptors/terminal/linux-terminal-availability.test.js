import assert from 'node:assert/strict';
import test from 'node:test';

import { FreshTerminalInterceptor } from '../../../src/interceptors/terminal-interceptors.js';

function linuxInterceptor(pathValue, executablePaths = []) {
  const interceptor = new FreshTerminalInterceptor();
  const checkedPaths = [];
  interceptor._platform = () => 'linux';
  interceptor._environment = () => pathValue === undefined ? {} : { PATH: pathValue };
  interceptor._workingDirectory = () => '/workspace';
  interceptor._isExecutablePath = async executablePath => {
    checkedPaths.push(executablePath);
    return executablePaths.includes(executablePath);
  };
  return { interceptor, checkedPaths };
}

test('Fresh Terminal is unavailable when no supported Linux launcher is executable', async () => {
  const { interceptor } = linuxInterceptor('/opt/bin:/usr/local/bin');

  assert.deepEqual(await interceptor._availableLinuxTerminalLaunchers(), []);
  assert.equal(await interceptor.isActivable(), false);
});

test('Fresh Terminal resolves one launcher through empty, spaced, and relative PATH entries', async () => {
  const { interceptor, checkedPaths } = linuxInterceptor(
    ':/opt/Terminal Tools/bin:relative/bin',
    ['/workspace/relative/bin/xterm']
  );

  const available = await interceptor._availableLinuxTerminalLaunchers();

  assert.deepEqual(available.map(launcher => launcher.command), ['xterm']);
  assert.equal(await interceptor.isActivable(), true);
  assert.ok(checkedPaths.includes('/workspace/gnome-terminal'));
  assert.ok(checkedPaths.includes('/opt/Terminal Tools/bin/gnome-terminal'));
  assert.ok(checkedPaths.includes('/workspace/relative/bin/xterm'));
});

test('Fresh Terminal reports multiple resolved launchers in activation fallback order', async () => {
  const { interceptor } = linuxInterceptor('/tools/first:/tools/second', [
    '/tools/second/gnome-terminal',
    '/tools/first/konsole'
  ]);

  const available = await interceptor._availableLinuxTerminalLaunchers();

  assert.deepEqual(available.map(launcher => launcher.command), [
    'gnome-terminal',
    'konsole'
  ]);
  assert.equal(await interceptor.isActivable(), true);
});

test('Fresh Terminal uses the Unix command-search default when PATH is absent', async () => {
  const { interceptor, checkedPaths } = linuxInterceptor(undefined, ['/usr/bin/xterm']);

  assert.equal(await interceptor.isActivable(), true);
  assert.ok(checkedPaths.includes('/usr/bin/gnome-terminal'));
  assert.ok(checkedPaths.includes('/usr/bin/xterm'));
  assert.ok(checkedPaths.includes('/bin/konsole'));
});

test('Fresh Terminal preserves unconditional Windows and macOS availability', async () => {
  for (const platform of ['win32', 'darwin']) {
    const interceptor = new FreshTerminalInterceptor();
    interceptor._platform = () => platform;
    interceptor._availableLinuxTerminalLaunchers = () => {
      assert.fail(`Linux discovery must not run on ${platform}`);
    };

    assert.equal(await interceptor.isActivable(), true, platform);
  }
});

test('Fresh Terminal executable discovery yields to event-loop work', async () => {
  const { interceptor } = linuxInterceptor('/slow/bin');
  let checksFinished = 0;
  interceptor._isExecutablePath = executablePath => new Promise(resolve => {
    setTimeout(() => {
      checksFinished++;
      resolve(executablePath.endsWith('/xterm'));
    }, 10);
  });

  const discovery = interceptor.isActivable();
  await Promise.resolve();

  assert.equal(checksFinished, 0);
  assert.equal(await discovery, true);
  assert.equal(checksFinished, 3);
});
