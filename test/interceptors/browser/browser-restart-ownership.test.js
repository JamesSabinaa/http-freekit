import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserInterceptor } from '../../../src/interceptors/browser-interceptor.js';
import { ExistingBrowserInterceptor } from '../../../src/interceptors/existing-browser-interceptor.js';
import { InterceptorManager } from '../../../src/interceptors/interceptor-manager.js';
import {
  cleanupStaleBrowserProfiles,
  createManagedBrowserProfile,
  parsePosixProcessSnapshot
} from '../../../src/interceptors/browser-lifecycle.js';

const JOURNAL_NAME = 'existing-browser-chrome-ownership.json';

function tempDir(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function markOwnerDead(profileDir) {
  const markerPath = path.join(profileDir, '.http-freekit-profile.json');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  fs.writeFileSync(markerPath, JSON.stringify({ ...marker, ownerPid: 2147483647 }));
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killSignals = [];
  child.kill = signal => {
    child.killSignals.push(signal);
    return true;
  };
  return child;
}

function processRow(pid, executable, startedAt = 1722254400000) {
  return {
    pid,
    ppid: 1,
    startedAt,
    command: `"${executable}" --proxy-server=127.0.0.1:8080`,
    executablePath: executable,
    argv0: executable,
    commandName: path.basename(executable)
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('startup classifies exact browser processes from a dead profile owner as recoverable', t => {
  const root = tempDir(t, 'http-freekit-bug-218-cleanup-');
  const profileDir = createManagedBrowserProfile('chrome', root);
  markOwnerDead(profileDir);
  const marker = JSON.parse(fs.readFileSync(
    path.join(profileDir, '.http-freekit-profile.json'),
    'utf8'
  ));
  const snapshot = [{
    pid: 8218,
    ppid: 1,
    startedAt: Date.now(),
    command: `chrome --user-data-dir="${profileDir}" --proxy-server=127.0.0.1:8123`,
    commandName: 'chrome'
  }];

  const result = cleanupStaleBrowserProfiles({
    tempDir: root,
    processSnapshot: snapshot,
    platform: process.platform
  });

  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skippedActive, [profileDir]);
  assert.deepEqual(result.recoverable, [{
    profileDir,
    browserType: 'chrome',
    createdAt: Date.parse(marker.createdAt),
    processIds: [8218],
    proxyPort: 8123
  }]);
});

test('an isolated interceptor adopts and stops every recoverable profile of its type', async t => {
  const firstProfile = createManagedBrowserProfile('chrome');
  const secondProfile = createManagedBrowserProfile('chrome');
  t.after(() => fs.rmSync(firstProfile, { recursive: true, force: true }));
  t.after(() => fs.rmSync(secondProfile, { recursive: true, force: true }));
  const browser = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  const processIds = new Map([
    [firstProfile, new Set([8219, 8220])],
    [secondProfile, new Set([8221])]
  ]);
  const signalled = [];
  browser._getRelatedProcessIds = async profileDir => {
    const current = processIds.get(profileDir) || new Set();
    processIds.set(profileDir, new Set());
    return new Set(current);
  };
  browser._signalProcesses = (ids, signal) => signalled.push([signal, [...ids].sort()]);
  browser._forceTerminateProcesses = () => assert.fail('graceful stop should be sufficient');

  assert.equal(browser.recoverProfiles([{
    profileDir: firstProfile,
    browserType: 'chrome',
    processIds: [8219, 8220],
    proxyPort: 8080
  }, {
    profileDir: secondProfile,
    browserType: 'chrome',
    processIds: [8221],
    proxyPort: 8080
  }]), true);
  assert.equal(browser.active, true);
  assert.equal(browser.toJSON().pid, 8219);
  assert.equal(browser.needsDeactivation(), true);

  await browser.deactivate();

  assert.deepEqual(signalled, [
    ['SIGTERM', [8219, 8220]],
    ['SIGTERM', [8221]]
  ]);
  assert.equal(browser.recoveredProfiles.size, 0);
  assert.equal(browser.active, false);
  assert.equal(browser.needsDeactivation(), false);
  assert.equal(fs.existsSync(firstProfile), false);
  assert.equal(fs.existsSync(secondProfile), false);
});

test('unknown isolated-profile process state preserves recovery ownership without signalling', async t => {
  const profileDir = createManagedBrowserProfile('chrome');
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const browser = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  browser.recoverProfiles([{
    profileDir,
    browserType: 'chrome',
    processIds: [8222],
    proxyPort: 8080
  }]);
  browser._getRelatedProcessIds = async () => { throw new Error('snapshot unavailable'); };
  browser._signalProcesses = () => assert.fail('unknown ownership must never authorize a signal');

  await assert.rejects(browser.deactivate(), /process state could not be verified/);

  assert.equal(browser.active, true);
  assert.equal(browser.recoveredProfiles.size, 1);
  assert.equal(fs.existsSync(profileDir), true);
  browser._stopStatusMonitor();
});

test('a delayed isolated-profile refresh cannot resurrect state after Stop', async t => {
  const profileDir = createManagedBrowserProfile('chrome');
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const browser = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  browser.recoverProfiles([{
    profileDir,
    browserType: 'chrome',
    processIds: [8230],
    proxyPort: 8080
  }]);
  browser._stopStatusMonitor();
  const snapshot = deferred();
  browser._getRelatedProcessIds = () => snapshot.promise;

  const refresh = browser.isActive();
  browser.recoveredProfilesGeneration += 1;
  browser.recoveredProfiles.clear();
  browser.active = false;
  browser.cleanupPending = false;
  snapshot.resolve(new Set([8230]));

  assert.equal(await refresh, false);
  assert.equal(browser.active, false);
  assert.equal(browser.recoveredProfiles.size, 0);
});

test('macOS Global Chrome capture restores the full executable identity safely', async () => {
  const browserPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const rows = parsePosixProcessSnapshot(
    ` 8231 Google Chrome 8231 1 Wed Jul 29 10:20:30 2026 ${browserPath} --proxy-server=127.0.0.1:8080`
  );
  assert.equal(rows[0].argv0, '/Applications/Google');
  const interceptor = new ExistingBrowserInterceptor(
    'existing-chrome',
    'Global Chrome',
    'chrome'
  );
  interceptor._getPlatform = () => 'darwin';
  interceptor._getProcessSnapshot = async () => rows;

  const ownership = await interceptor._captureLaunchedOwnership({ pid: 8231 }, browserPath);

  assert.equal(ownership.executable, browserPath);
  assert.equal(interceptor._observationMatches(
    ownership,
    await interceptor._observeOwnedProcess(ownership)
  ), true);

  const wrongPathRows = parsePosixProcessSnapshot(
    ' 8231 Google Chrome 8231 1 Wed Jul 29 10:20:30 2026 /tmp/Google Chrome --proxy-server=127.0.0.1:8080'
  );
  interceptor._getProcessSnapshot = async () => wrongPathRows;
  assert.equal(interceptor._observationMatches(
    ownership,
    await interceptor._observeOwnedProcess(ownership)
  ), false);
});

test('Global Chrome ownership is journaled, adopted after restart, and revalidated before Stop', async t => {
  const dataDir = tempDir(t, 'http-freekit-bug-218-global-');
  const browserPath = process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : '/opt/google/chrome/chrome';
  const row = processRow(8223, browserPath);
  const child = fakeChild(row.pid);
  const original = new ExistingBrowserInterceptor(
    'existing-chrome',
    'Global Chrome',
    'chrome',
    { dataDir }
  );
  original.ca = { systemTrustInstalled: true };
  original._findBrowserPath = () => browserPath;
  original._isBrowserRunning = async () => false;
  original._getProcessSnapshot = async () => [row];
  original._spawn = () => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  original.startupConfirmationMs = 0;

  await original.activate(8080);
  const recoveryFile = path.join(dataDir, JOURNAL_NAME);
  assert.equal(fs.existsSync(recoveryFile), true);
  assert.equal(original.ownership.pid, row.pid);

  let running = true;
  const restarted = new ExistingBrowserInterceptor(
    'existing-chrome',
    'Global Chrome',
    'chrome',
    { dataDir }
  );
  restarted._getProcessSnapshot = async () => running ? [row] : [];
  assert.equal(restarted.process, null);
  assert.equal(await restarted.isActive(), true);
  assert.equal(restarted.toJSON().pid, row.pid);
  const signals = [];
  restarted._killOwnedPid = (pid, signal) => {
    signals.push([pid, signal]);
    running = false;
    return true;
  };
  restarted.gracefulExitTimeoutMs = 20;
  restarted.processExitPollIntervalMs = 1;

  await restarted.deactivate();

  assert.deepEqual(signals, [[row.pid, 'SIGTERM']]);
  assert.equal(restarted.active, false);
  assert.equal(restarted.ownership, null);
  assert.equal(fs.existsSync(recoveryFile), false);
});

test('an immediate Global Chrome exit cannot leave stale restart ownership', async t => {
  const dataDir = tempDir(t, 'http-freekit-bug-218-immediate-exit-');
  const browserPath = process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : '/opt/google/chrome/chrome';
  const row = processRow(8226, browserPath);
  const child = fakeChild(row.pid);
  const interceptor = new ExistingBrowserInterceptor(
    'existing-chrome',
    'Global Chrome',
    'chrome',
    { dataDir }
  );
  interceptor.ca = { systemTrustInstalled: true };
  interceptor._findBrowserPath = () => browserPath;
  interceptor._isBrowserRunning = async () => false;
  interceptor._getProcessSnapshot = async () => [row];
  interceptor._spawn = () => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  interceptor.startupConfirmationMs = 0;
  const persist = interceptor._persistOwnershipJournal.bind(interceptor);
  interceptor._persistOwnershipJournal = ownership => {
    persist(ownership);
    child.exitCode = 0;
    child.emit('exit', 0, null);
  };

  await assert.rejects(interceptor.activate(8080), /exited before its ownership could be recorded/);

  assert.equal(interceptor.process, null);
  assert.equal(interceptor.ownership, null);
  assert.equal(interceptor.active, false);
  assert.equal(fs.existsSync(path.join(dataDir, JOURNAL_NAME)), false);
});

test('a delayed Global Chrome refresh cannot resurrect ownership after Stop', async t => {
  const dataDir = tempDir(t, 'http-freekit-bug-218-refresh-race-');
  const recoveryFile = path.join(dataDir, JOURNAL_NAME);
  const executable = process.platform === 'win32'
    ? 'c:\\program files\\google\\chrome\\application\\chrome.exe'
    : '/opt/google/chrome/chrome';
  const ownership = {
    version: 1,
    id: 'existing-chrome',
    browserType: 'chrome',
    pid: 8232,
    startedAt: 1722254400000,
    executable,
    platform: process.platform
  };
  fs.writeFileSync(recoveryFile, JSON.stringify(ownership));
  const interceptor = new ExistingBrowserInterceptor(
    'existing-chrome',
    'Global Chrome',
    'chrome',
    { dataDir }
  );
  const snapshot = deferred();
  interceptor._getProcessSnapshot = () => snapshot.promise;

  const refresh = interceptor.isActive();
  interceptor._clearOwnership(interceptor.ownership);
  interceptor.active = false;
  snapshot.resolve([processRow(ownership.pid, executable, ownership.startedAt)]);

  assert.equal(await refresh, false);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.ownership, null);
  assert.equal(fs.existsSync(recoveryFile), false);
});

test('Global Chrome restart ownership never signals a reused PID', async t => {
  const dataDir = tempDir(t, 'http-freekit-bug-218-reused-');
  const recoveryFile = path.join(dataDir, JOURNAL_NAME);
  const executable = process.platform === 'win32'
    ? 'c:\\program files\\google\\chrome\\application\\chrome.exe'
    : '/opt/google/chrome/chrome';
  fs.writeFileSync(recoveryFile, JSON.stringify({
    version: 1,
    id: 'existing-chrome',
    browserType: 'chrome',
    pid: 8224,
    startedAt: 1722254400000,
    executable,
    platform: process.platform
  }));
  const interceptor = new ExistingBrowserInterceptor(
    'existing-chrome',
    'Global Chrome',
    'chrome',
    { dataDir }
  );
  interceptor._getProcessSnapshot = async () => [processRow(
    8224,
    process.platform === 'win32' ? 'C:\\Windows\\System32\\notepad.exe' : '/usr/bin/unrelated',
    1722254401000
  )];
  interceptor._killOwnedPid = () => assert.fail('a reused PID must never be signalled');

  await interceptor.deactivate();

  assert.equal(interceptor.active, false);
  assert.equal(interceptor.ownership, null);
  assert.equal(fs.existsSync(recoveryFile), false);
});

test('unknown Global Chrome identity preserves the journal for a safe Stop retry', async t => {
  const dataDir = tempDir(t, 'http-freekit-bug-218-unknown-');
  const recoveryFile = path.join(dataDir, JOURNAL_NAME);
  fs.writeFileSync(recoveryFile, JSON.stringify({
    version: 1,
    id: 'existing-chrome',
    browserType: 'chrome',
    pid: 8225,
    startedAt: 1722254400000,
    executable: process.platform === 'win32'
      ? 'c:\\program files\\google\\chrome\\application\\chrome.exe'
      : '/opt/google/chrome/chrome',
    platform: process.platform
  }));
  const interceptor = new ExistingBrowserInterceptor(
    'existing-chrome',
    'Global Chrome',
    'chrome',
    { dataDir }
  );
  interceptor._getProcessSnapshot = async () => { throw new Error('snapshot unavailable'); };
  interceptor._killOwnedPid = () => assert.fail('unknown ownership must never authorize a signal');

  await assert.rejects(interceptor.deactivate(), /snapshot unavailable.*Stop can be retried/);

  assert.equal(interceptor.active, true);
  assert.equal(interceptor.ownership.pid, 8225);
  assert.equal(fs.existsSync(recoveryFile), true);
});

test('manager provides Global Chrome with durable ownership storage', t => {
  const dataDir = tempDir(t, 'http-freekit-bug-218-manager-');
  const manager = new InterceptorManager(null, { dataDir });

  assert.equal(
    manager.interceptors.get('existing-chrome').recoveryFile,
    path.join(dataDir, JOURNAL_NAME)
  );
  for (const browserType of ['chrome', 'firefox', 'edge', 'brave']) {
    manager.interceptors.get(browserType)._stopStatusMonitor();
  }
});
