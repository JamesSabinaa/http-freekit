import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findBrowserPath } from '../../../src/interceptors/browser-paths.js';
import { parsePosixProcessSnapshot } from '../../../src/interceptors/browser-lifecycle.js';
import { ExistingBrowserInterceptor } from '../../../src/interceptors/existing-browser-interceptor.js';

// Debian chromium 153.0.8010.52-1: debian/scripts/chromium executes
// /usr/lib/chromium/chromium without exec -a; debian/rules installs /usr/bin/chromium.
// Process inspection, spawning and signaling below are all isolated stubs.
const LAUNCHER = '/usr/bin/chromium';
const EXECUTABLE = '/usr/lib/chromium/chromium';
const PID = 900123;

class LinuxGlobalChrome extends ExistingBrowserInterceptor {
  _getPlatform() { return 'linux'; }
}

function processRows(executable = EXECUTABLE) {
  return parsePosixProcessSnapshot(
    ` ${PID} chromium ${PID} 1 Sun Sep 20 12:00:00 2026 ${executable} --proxy-server=127.0.0.1:8080`
  );
}

function fixture(t, selected = LAUNCHER) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-debian-chromium-'));
  const interceptor = new LinuxGlobalChrome('existing-chrome', 'Global Chrome', 'chrome', { dataDir: directory });
  t.after(() => {
    if (fs.existsSync(interceptor.recoveryFile)) fs.unlinkSync(interceptor.recoveryFile);
    fs.rmdirSync(directory);
  });
  const state = { spawned: false, rows: processRows(), spawnCalls: [], signals: [] };
  const child = Object.assign(new EventEmitter(), { pid: PID, exitCode: null, signalCode: null });
  child.kill = signal => {
    state.signals.push(signal);
    child.signalCode = signal;
    state.rows = [];
    queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  };
  interceptor.ca = { systemTrustInstalled: true };
  interceptor.startupConfirmationMs = 0;
  interceptor._findBrowserPath = () => findBrowserPath('chrome', {
    platform: 'linux', env: { PATH: path.posix.dirname(selected) },
    existsSync: candidate => candidate === selected
  });
  interceptor._getProcessSnapshot = async () => state.spawned ? state.rows : [];
  interceptor._spawn = (executable, args, options) => {
    state.spawnCalls.push({ executable, args, options });
    state.spawned = true;
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  interceptor._killOwnedPid = () => assert.fail('No real PID signaling is permitted');
  return { interceptor, state, directory };
}

test('Global Chrome accepts the Debian launcher and recovers ownership of its actual binary', async t => {
  const { interceptor, state, directory } = fixture(t);
  const result = await interceptor.activate(8080);
  assert.equal(result.success, true);
  assert.equal(state.spawnCalls[0].executable, LAUNCHER);
  assert.ok(state.spawnCalls[0].args.includes('--proxy-server=127.0.0.1:8080'));
  assert.equal(state.spawnCalls[0].args.some(argument => argument.startsWith('--user-data-dir')), false);
  assert.deepEqual(state.signals, []);
  assert.equal(await interceptor.isActive(), true);
  const journal = JSON.parse(fs.readFileSync(interceptor.recoveryFile, 'utf8'));
  assert.equal(journal.executable, EXECUTABLE);
  assert.equal(journal.pid, PID);
  assert.equal(journal.startedAt, state.rows[0].startedAt);

  const recovered = new LinuxGlobalChrome('existing-chrome', 'Global Chrome', 'chrome', { dataDir: directory });
  recovered._getProcessSnapshot = async () => state.rows;
  const recoveredSignals = [];
  recovered._killOwnedPid = (pid, signal) => {
    recoveredSignals.push([pid, signal]);
    state.rows = [];
    return true;
  };
  recovered.processExitPollIntervalMs = 1;
  assert.equal(await recovered.isActive(), true);
  await recovered.deactivate();
  assert.deepEqual(recoveredSignals, [[PID, 'SIGTERM']]);
  assert.equal(recovered.active, false);
  assert.equal(recovered.ownership, null);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});

test('direct Chromium launches still require and retain their exact executable', async t => {
  const { interceptor, state } = fixture(t, EXECUTABLE);
  await interceptor.activate(8080);
  assert.equal(state.spawnCalls[0].executable, EXECUTABLE);
  assert.equal(interceptor.ownership.executable, EXECUTABLE);
  assert.deepEqual(state.signals, []);
  await interceptor.deactivate();
  assert.deepEqual(state.signals, ['SIGTERM']);
});

test('the Debian launcher exception does not admit another executable or browser family', async t => {
  const { interceptor, state } = fixture(t);
  // An authoritative executable path must win even if argv0 resembles Chromium.
  state.rows[0].executablePath = '/tmp/chromium';
  await assert.rejects(interceptor.activate(8080), /executable identity does not match/);
  assert.deepEqual(state.signals, ['SIGTERM']);
  assert.equal(interceptor.active, false);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);

  for (const [platform, browserType, selected, observed] of [
    ['linux', 'chrome', LAUNCHER, '/usr/lib/other/chromium'],
    ['linux', 'chrome', '/usr/local/bin/chromium', EXECUTABLE],
    ['linux', 'chrome', '/usr/bin/google-chrome', EXECUTABLE],
    ['linux', 'edge', LAUNCHER, EXECUTABLE],
    ['darwin', 'chrome', LAUNCHER, EXECUTABLE]
  ]) {
    const candidate = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', browserType);
    candidate._getPlatform = () => platform;
    candidate._getProcessSnapshot = async () => processRows(observed);
    await assert.rejects(candidate._captureLaunchedOwnership({ pid: PID }, selected),
      /executable identity does not match/, `${platform} ${browserType} ${selected} -> ${observed}`);
  }
});

test('a Debian-launched browser must keep its exact captured identity before Stop', async t => {
  for (const change of ['start', 'executable', 'launcher', 'pid']) {
    await t.test(change, async t => {
      const { interceptor, state } = fixture(t);
      await interceptor.activate(8080);
      if (change === 'start') state.rows[0].startedAt += 1000;
      if (change === 'executable') state.rows[0].executablePath = '/tmp/chromium';
      if (change === 'launcher') state.rows = processRows(LAUNCHER);
      if (change === 'pid') state.rows[0].pid++;
      await interceptor.deactivate();
      assert.deepEqual(state.signals, [], 'Changed process identity must not authorize a signal');
      assert.equal(interceptor.ownership, null);
      assert.equal(interceptor.active, false);
      assert.equal(fs.existsSync(interceptor.recoveryFile), false);
    });
  }
});

test('Debian Chromium running detection recognizes the real binary but respects authoritative mismatches', async () => {
  const interceptor = new LinuxGlobalChrome('existing-chrome', 'Global Chrome', 'chrome');
  const rows = processRows();
  interceptor._getProcessSnapshot = async () => rows;
  assert.equal(await interceptor._isBrowserRunning(LAUNCHER), true);
  rows[0].executablePath = EXECUTABLE;
  assert.equal(await interceptor._isBrowserRunning(LAUNCHER), true);
  rows[0].executablePath = '/tmp/chromium';
  assert.equal(await interceptor._isBrowserRunning(LAUNCHER), false);
});
