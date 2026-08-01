import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { BrowserInterceptor } from '../../../src/interceptors/browser-interceptor.js';
import { InterceptorManager } from '../../../src/interceptors/interceptor-manager.js';

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

function flushEvents() {
  return new Promise(resolve => setImmediate(resolve));
}

function createManager(interceptor) {
  const manager = Object.create(InterceptorManager.prototype);
  manager.interceptors = new Map([[interceptor.id, interceptor]]);
  manager.operationsInProgress = new Map();
  manager.statusOperations = new Map();
  return manager;
}

test('failed profile cleanup after browser exit is inactive, visible, and retryable by Stop', async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const browser = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  const child = fakeChild(9317);
  let cleanupAttempts = 0;
  browser.ca = { systemTrustInstalled: true };
  browser._platform = () => 'win32';
  browser._findBrowserPath = () => '/test/chrome';
  browser._createManagedProfile = () => 'cleanup-only-profile';
  browser._spawn = () => child;
  browser._waitForSpawn = async () => {};
  browser._startStatusMonitor = () => {};
  browser._isBrowserStillRunning = async () => false;
  browser._refreshTrackedProcessIds = async () => new Set();
  browser._terminateProcessTree = async () => new Set();
  browser._cleanup = profileDir => {
    cleanupAttempts += 1;
    assert.equal(profileDir, 'cleanup-only-profile');
    return cleanupAttempts === 1
      ? { removed: false, reason: 'profile locked' }
      : { removed: true };
  };

  await browser.activate(8317);
  child.exitCode = 0;
  child.emit('exit', 0);
  await flushEvents();
  await flushEvents();

  assert.equal(browser.cleanupPending, true);
  assert.equal(await browser.isActive(), false);
  assert.deepEqual(browser.toJSON(), {
    id: 'chrome',
    name: 'Chrome',
    type: 'chrome',
    active: false,
    pid: 9317,
    focusable: false,
    cleanupPending: true
  });

  const manager = createManager(browser);
  const [listedBrowser] = await manager.getAll();
  assert.equal(listedBrowser.active, false);
  assert.equal(listedBrowser.focusable, false);
  assert.equal(listedBrowser.cleanupPending, true);
  assert.equal(browser.needsDeactivation(), true);

  await browser.deactivate();
  assert.equal(cleanupAttempts, 2);
  assert.equal(browser.needsDeactivation(), false);
  assert.equal(browser.profileDir, null);
  assert.equal(browser.cleanupPending, false);
});

test('cleanup-only state rejects direct Open and Focus before invoking browser helpers', async () => {
  const browser = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  browser.active = false;
  browser.process = { pid: 9417, exitCode: 0, signalCode: null };
  browser.profileDir = 'cleanup-only-profile';
  browser.proxyPort = 8317;
  browser.cleanupPending = true;
  browser._platform = () => 'win32';
  browser._findBrowserPath = () => assert.fail('Open must not reach the browser opener');

  await assert.rejects(
    browser.openUrl('https://example.com/cleanup'),
    error => error.code === 'BROWSER_CLEANUP_PENDING'
  );
  await assert.rejects(browser.focus(), /Chrome is not running/);
  assert.equal(browser.toJSON().focusable, false);
});

test('a fresh dead-process check disables focus before profile cleanup is attempted', async () => {
  const browser = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  browser.active = true;
  browser.process = { pid: 9467, exitCode: 0, signalCode: null };
  browser.profileDir = 'not-yet-cleaned-profile';
  browser._platform = () => 'win32';
  browser._isBrowserStillRunning = async () => false;

  assert.equal(await browser.isActive(), false);
  assert.equal(browser.cleanupPending, false);
  assert.equal(browser.toJSON().active, false);
  assert.equal(browser.toJSON().focusable, false);
  await assert.rejects(browser.focus(), /Chrome is not running/);
});

test('shutdown retries cleanup-only ownership and Open replaces it only after cleanup', async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});

  const shutdownBrowser = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  shutdownBrowser.profileDir = 'shutdown-profile';
  shutdownBrowser.cleanupPending = true;
  let shutdownRetries = 0;
  shutdownBrowser.deactivate = async () => {
    shutdownRetries += 1;
    shutdownBrowser._resetLifecycleState();
  };
  const shutdownManager = createManager(shutdownBrowser);
  await shutdownManager.deactivateAll();
  assert.equal(shutdownRetries, 1);

  const browser = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  const child = fakeChild(9517);
  const operations = [];
  let cleanupCanSucceed = false;
  browser.active = false;
  browser.process = { pid: 9516, exitCode: 0, signalCode: null };
  browser.profileDir = 'old-profile';
  browser.proxyPort = 8316;
  browser.cleanupPending = true;
  browser.ca = { systemTrustInstalled: true };
  browser.isActivable = async () => true;
  browser._findBrowserPath = () => '/test/chrome';
  browser._cleanup = profileDir => {
    operations.push(`cleanup:${profileDir}`);
    return cleanupCanSucceed
      ? { removed: true }
      : { removed: false, reason: 'profile locked' };
  };
  browser._createManagedProfile = () => {
    operations.push('create:new-profile');
    return 'new-profile';
  };
  browser._spawn = () => {
    operations.push('spawn:new-browser');
    return child;
  };
  browser._waitForSpawn = async () => {};
  browser._startStatusMonitor = () => {};
  browser._isBrowserStillRunning = async () => browser.profileDir === 'new-profile';
  const manager = createManager(browser);

  await assert.rejects(
    manager.openUrl('chrome', 8317, 'https://example.com/replacement'),
    error => error.code === 'BROWSER_CLEANUP_PENDING'
  );
  assert.deepEqual(operations, ['cleanup:old-profile']);
  assert.equal(browser.active, false);
  assert.equal(browser.cleanupPending, true);

  cleanupCanSucceed = true;
  const result = await manager.openUrl('chrome', 8317, 'https://example.com/replacement');
  assert.deepEqual(operations, [
    'cleanup:old-profile',
    'cleanup:old-profile',
    'create:new-profile',
    'spawn:new-browser'
  ]);
  assert.equal(result.success, true);
  assert.equal(browser.profileDir, 'new-profile');
  assert.equal(browser.cleanupPending, false);
  assert.equal(browser.active, true);
  browser._resetLifecycleState();
});
