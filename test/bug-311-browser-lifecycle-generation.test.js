import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { BrowserInterceptor } from '../src/interceptors/browser-interceptor.js';

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flushEvents() {
  return new Promise(resolve => setImmediate(resolve));
}

test('a pending old monitor cannot erase a replacement held in launch preparation', async t => {
  t.mock.method(console, 'log', () => {});
  const intervals = [];
  t.mock.method(globalThis, 'setInterval', callback => {
    intervals.push(callback);
    return { unref() {} };
  });
  t.mock.method(globalThis, 'clearInterval', () => {});

  const browser = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  const oldChild = fakeChild(7311);
  const newChild = fakeChild(7312);
  const profiles = ['old-profile', 'new-profile'];
  const children = [oldChild, newChild];
  const cleanedProfiles = [];
  browser.ca = { systemTrustInstalled: true };
  browser._findBrowserPath = () => '/test/chrome';
  browser._createManagedProfile = () => profiles.shift();
  browser._spawn = () => children.shift();
  browser._waitForSpawn = async () => {};
  browser._cleanup = profileDir => {
    cleanedProfiles.push(profileDir);
    return { removed: true };
  };

  await browser.activate(8311);
  assert.equal(intervals.length, 1);
  const oldGeneration = browser.lifecycleGeneration;

  const oldInspection = deferred();
  const inspectionStarted = deferred();
  let inspectionCalls = 0;
  browser._isBrowserStillRunning = async () => {
    inspectionCalls += 1;
    if (inspectionCalls === 1) {
      inspectionStarted.resolve();
      return oldInspection.promise;
    }
    return false;
  };

  intervals[0]();
  await inspectionStarted.promise;

  const replacementPreparation = deferred();
  const replacementPreparationStarted = deferred();
  browser._getBrowserArgs = async (_proxyPort, _options, profileDir) => {
    assert.equal(profileDir, 'new-profile');
    replacementPreparationStarted.resolve();
    await replacementPreparation.promise;
    return [`--user-data-dir=${profileDir}`];
  };

  const replacement = browser.activate(8312);
  await replacementPreparationStarted.promise;
  assert.deepEqual(cleanedProfiles, ['old-profile']);
  assert.ok(browser.lifecycleGeneration > oldGeneration);
  assert.equal(browser.profileDir, 'new-profile');
  assert.equal(browser.process, null);
  assert.equal(browser.active, false);

  oldInspection.resolve(false);
  await flushEvents();
  assert.deepEqual(cleanedProfiles, ['old-profile']);
  assert.equal(browser.profileDir, 'new-profile');
  assert.equal(browser.process, null);

  replacementPreparation.resolve();
  await replacement;
  assert.equal(browser.profileDir, 'new-profile');
  assert.equal(browser.process, newChild);
  assert.equal(browser.active, true);

  oldChild.emit('error', new Error('stale child error'));
  oldChild.emit('exit', 99);
  await flushEvents();
  assert.deepEqual(cleanedProfiles, ['old-profile']);
  assert.equal(browser.profileDir, 'new-profile');
  assert.equal(browser.process, newChild);
  assert.equal(browser.active, true);

  browser._stopStatusMonitor();
  browser._resetLifecycleState();
});

test('a stale child exit lookup no-ops while replacement arguments are pending', async t => {
  t.mock.method(console, 'log', () => {});
  const browser = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  const oldChild = fakeChild(7321);
  const newChild = fakeChild(7322);
  const children = [oldChild, newChild];
  const profiles = ['old-exit-profile', 'new-exit-profile'];
  const cleanedProfiles = [];
  browser.ca = { systemTrustInstalled: true };
  browser._findBrowserPath = () => '/test/chrome';
  browser._createManagedProfile = () => profiles.shift();
  browser._spawn = () => children.shift();
  browser._waitForSpawn = async () => {};
  browser._startStatusMonitor = () => {};
  browser._cleanup = profileDir => {
    cleanedProfiles.push(profileDir);
    return { removed: true };
  };

  await browser.activate(8321);
  const oldExitInspection = deferred();
  const inspectionStarted = deferred();
  let inspectionCalls = 0;
  browser._isBrowserStillRunning = async () => {
    inspectionCalls += 1;
    if (inspectionCalls === 1) {
      inspectionStarted.resolve();
      return oldExitInspection.promise;
    }
    return false;
  };
  oldChild.emit('exit', 0);
  await inspectionStarted.promise;

  const preparation = deferred();
  const preparationStarted = deferred();
  browser._getBrowserArgs = async (_proxyPort, _options, profileDir) => {
    preparationStarted.resolve();
    await preparation.promise;
    return [`--user-data-dir=${profileDir}`];
  };
  const replacement = browser.activate(8322);
  await preparationStarted.promise;
  oldExitInspection.resolve(false);
  await flushEvents();

  assert.deepEqual(cleanedProfiles, ['old-exit-profile']);
  assert.equal(browser.profileDir, 'new-exit-profile');
  assert.equal(browser.process, null);

  preparation.resolve();
  await replacement;
  assert.equal(browser.process, newChild);
  assert.equal(browser.active, true);
  browser._resetLifecycleState();
});

test('the current generation exit still cleans and resets its own profile', async t => {
  t.mock.method(console, 'log', () => {});
  const browser = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  const child = fakeChild(7331);
  const cleanedProfiles = [];
  browser.ca = { systemTrustInstalled: true };
  browser._findBrowserPath = () => '/test/chrome';
  browser._createManagedProfile = () => 'current-profile';
  browser._spawn = () => child;
  browser._waitForSpawn = async () => {};
  browser._startStatusMonitor = () => {};
  browser._cleanup = profileDir => {
    cleanedProfiles.push(profileDir);
    return { removed: true };
  };
  await browser.activate(8331);
  browser._isBrowserStillRunning = async () => false;

  child.emit('exit', 0);
  await flushEvents();
  await flushEvents();

  assert.deepEqual(cleanedProfiles, ['current-profile']);
  assert.equal(browser.profileDir, null);
  assert.equal(browser.process, null);
  assert.equal(browser.active, false);
});

test('a superseded launch failure cleans only its own profile and cannot reset newer state', async t => {
  t.mock.method(console, 'log', () => {});
  const browser = new BrowserInterceptor('firefox', 'Firefox', 'firefox');
  const preparation = deferred();
  const preparationStarted = deferred();
  const newerChild = fakeChild(7342);
  const cleanedProfiles = [];
  browser._findBrowserPath = () => '/test/firefox';
  browser._createManagedProfile = () => 'failed-launch-profile';
  browser._getBrowserArgs = async (_proxyPort, _options, profileDir) => {
    preparationStarted.resolve(profileDir);
    await preparation.promise;
    throw new Error('asynchronous Firefox preparation failed');
  };
  browser._cleanup = profileDir => {
    cleanedProfiles.push(profileDir);
    return { removed: true };
  };

  const activation = browser.activate(8341);
  assert.equal(await preparationStarted.promise, 'failed-launch-profile');

  browser._invalidateLifecycleCallbacks();
  browser.profileDir = 'newer-profile';
  browser.process = newerChild;
  browser.proxyPort = 8342;
  browser.active = true;
  preparation.resolve();

  await assert.rejects(activation, /asynchronous Firefox preparation failed/);
  assert.deepEqual(cleanedProfiles, ['failed-launch-profile']);
  assert.equal(browser.profileDir, 'newer-profile');
  assert.equal(browser.process, newerChild);
  assert.equal(browser.proxyPort, 8342);
  assert.equal(browser.active, true);
  browser._resetLifecycleState();
});

test('replacement stops before profile creation when old profile cleanup needs retry', async t => {
  t.mock.method(console, 'log', () => {});
  const browser = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  const oldChild = fakeChild(7351);
  const statusEvents = [];
  browser.active = true;
  browser.process = oldChild;
  browser.profileDir = 'locked-old-profile';
  browser.proxyPort = 8351;
  browser._findBrowserPath = () => '/test/chrome';
  browser._isBrowserStillRunning = async () => false;
  browser._createManagedProfile = () => assert.fail('replacement profile must not be created');
  browser._cleanup = profileDir => {
    assert.equal(profileDir, 'locked-old-profile');
    return { removed: false, reason: 'profile locked' };
  };
  browser.onStatusChange = event => statusEvents.push(event);

  await assert.rejects(
    browser.activate(8352),
    error => error.code === 'BROWSER_CLEANUP_PENDING'
  );
  assert.equal(browser.profileDir, 'locked-old-profile');
  assert.equal(browser.process, oldChild);
  assert.equal(browser.active, false);
  assert.equal(browser.cleanupPending, true);
  assert.equal(statusEvents.at(-1).reason, 'cleanup-failed');
});
