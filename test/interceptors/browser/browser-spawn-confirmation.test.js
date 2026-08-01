import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { BrowserInterceptor } from '../../../src/interceptors/browser-interceptor.js';
import { ExistingBrowserInterceptor } from '../../../src/interceptors/existing-browser-interceptor.js';
import { InterceptorManager } from '../../../src/interceptors/interceptor-manager.js';

const uiSource = readFileSync(new URL('../../../src/ui/app.js', import.meta.url), 'utf8');

function fakeChild(pid = undefined) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test('isolated browser activation waits for spawn confirmation', async () => {
  const interceptor = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  const child = fakeChild();
  interceptor._findBrowserPath = () => '/test/chrome';
  interceptor._createManagedProfile = () => '/test/profile';
  interceptor._spawn = () => child;
  interceptor.startupConfirmationMs = 10;
  interceptor.ca = { systemTrustInstalled: true };

  let settled = false;
  const activation = interceptor.activate(8080).finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);

  child.pid = 7101;
  child.emit('spawn');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'spawn alone must not confirm startup stability');
  const result = await activation;

  assert.equal(result.success, true);
  assert.equal(result.pid, 7101);
  assert.equal(interceptor.active, true);
  assert.equal(interceptor.process, child);
  interceptor._stopStatusMonitor();
  interceptor._resetLifecycleState();
});

test('isolated browser activation rejects spawn errors and removes its profile', async () => {
  const interceptor = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  const child = fakeChild();
  const cleanedProfiles = [];
  interceptor._findBrowserPath = () => '/test/not-executable';
  interceptor._createManagedProfile = () => '/test/profile';
  interceptor._spawn = () => child;
  interceptor._cleanup = profileDir => {
    cleanedProfiles.push(profileDir);
    return { removed: true };
  };
  interceptor.ca = { systemTrustInstalled: true };

  const activation = interceptor.activate(8080);
  await new Promise(resolve => setImmediate(resolve));
  child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));

  await assert.rejects(activation, /spawn EACCES/);
  assert.deepEqual(cleanedProfiles, ['/test/profile']);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
  assert.equal(interceptor.profileDir, null);
});

test('Global Chrome activation waits for spawn confirmation', async () => {
  const interceptor = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome');
  const child = fakeChild();
  interceptor._findBrowserPath = () => '/test/chrome';
  interceptor._isBrowserRunning = async () => false;
  interceptor._spawn = () => child;
  interceptor.startupConfirmationMs = 10;
  interceptor.ca = { systemTrustInstalled: true };

  let settled = false;
  const activation = interceptor.activate(8080).finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);

  child.pid = 7201;
  child.emit('spawn');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'spawn alone must not confirm startup stability');
  const result = await activation;

  assert.equal(result.success, true);
  assert.equal(result.pid, 7201);
  assert.equal(interceptor.active, true);
  assert.equal(interceptor.process, child);
});

test('Global Chrome activation rejects spawn errors without becoming active', async () => {
  const interceptor = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome');
  const child = fakeChild();
  interceptor._findBrowserPath = () => '/test/not-executable';
  interceptor._isBrowserRunning = async () => false;
  interceptor._spawn = () => child;
  interceptor.ca = { systemTrustInstalled: true };

  const activation = interceptor.activate(8080);
  await new Promise(resolve => setImmediate(resolve));
  child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));

  await assert.rejects(activation, /spawn EACCES/);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
});

test('isolated browser activation rejects an early post-spawn exit and removes its profile', async () => {
  const interceptor = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  const child = fakeChild(7301);
  const cleanedProfiles = [];
  interceptor._findBrowserPath = () => '/test/corrupt-chrome';
  interceptor._createManagedProfile = () => '/test/profile';
  interceptor._spawn = () => child;
  interceptor._refreshTrackedProcessIds = async force => {
    assert.equal(force, true);
    return new Set();
  };
  interceptor._cleanup = profileDir => {
    cleanedProfiles.push(profileDir);
    return { removed: true };
  };
  interceptor.startupConfirmationMs = 50;
  interceptor.ca = { systemTrustInstalled: true };

  const activation = interceptor.activate(8080);
  await new Promise(resolve => setImmediate(resolve));
  child.emit('spawn');
  child.exitCode = 1;
  child.emit('exit', 1, null);

  await assert.rejects(activation, /Chrome exited during startup \(exit code 1\)/);
  assert.deepEqual(cleanedProfiles, ['/test/profile']);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
  assert.equal(interceptor.profileDir, null);
  assert.equal(child.listenerCount('spawn'), 0);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

test('isolated browser adopts profile descendants after its launcher exits during startup', async t => {
  t.mock.method(console, 'error', () => {});
  const interceptor = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  const child = fakeChild(7351);
  const cleanedProfiles = [];
  let inspections = 0;
  interceptor._findBrowserPath = () => '/test/chrome-launcher';
  interceptor._createManagedProfile = () => '/test/profile';
  interceptor._spawn = () => child;
  interceptor._cleanup = profileDir => {
    cleanedProfiles.push(profileDir);
    return { removed: true };
  };
  interceptor._refreshTrackedProcessIds = async (force, lifecycle) => {
    inspections++;
    assert.equal(force, true);
    assert.equal(lifecycle.profileDir, '/test/profile');
    const relatedIds = new Set([7352, 7353]);
    interceptor.trackedProcessIds = relatedIds;
    return new Set(relatedIds);
  };
  interceptor._isBrowserStillRunning = async () => true;
  interceptor.startupConfirmationMs = 50;
  interceptor.ca = { systemTrustInstalled: true };

  const activation = interceptor.activate(8080);
  await new Promise(resolve => setImmediate(resolve));
  child.emit('spawn');
  child.exitCode = 0;
  child.emit('exit', 0, null);

  const result = await activation;

  assert.equal(result.success, true);
  assert.equal(result.pid, 7351);
  assert.equal(inspections, 1);
  assert.deepEqual(cleanedProfiles, []);
  assert.equal(interceptor.active, true);
  assert.equal(interceptor.process, child);
  assert.equal(interceptor.profileDir, '/test/profile');
  assert.deepEqual([...interceptor.trackedProcessIds], [7352, 7353]);
  assert.equal(interceptor.cleanupPending, false);

  child.emit('error', new Error('late launcher error'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(interceptor.active, true);
  assert.deepEqual(cleanedProfiles, []);

  interceptor._stopStatusMonitor();
  interceptor._clearLifecycleState();
});

test('isolated browser preserves startup ownership when descendant inspection is unavailable', async () => {
  const interceptor = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  const child = fakeChild(7371);
  interceptor._findBrowserPath = () => '/test/chrome-launcher';
  interceptor._createManagedProfile = () => '/test/profile';
  interceptor._spawn = () => child;
  interceptor._cleanup = () => assert.fail('an unverified startup profile must not be removed');
  interceptor._refreshTrackedProcessIds = async () => null;
  interceptor.startupConfirmationMs = 50;
  interceptor.ca = { systemTrustInstalled: true };

  const activation = interceptor.activate(8080);
  await new Promise(resolve => setImmediate(resolve));
  child.emit('spawn');
  child.exitCode = 9;
  child.emit('exit', 9, null);

  await assert.rejects(activation, /Chrome exited during startup \(exit code 9\)/);
  assert.equal(interceptor.active, true);
  assert.equal(interceptor.process, child);
  assert.equal(interceptor.profileDir, '/test/profile');
  assert.equal(interceptor.cleanupPending, true);
  assert.equal(interceptor.needsDeactivation(), true);
  assert.equal(child.listenerCount('spawn'), 0);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
  interceptor._clearLifecycleState();
});

test('manager publishes inspection-unknown startup ownership and its final cleanup', async () => {
  const interceptor = new BrowserInterceptor('chrome', 'Chrome', 'chrome');
  const child = fakeChild(7381);
  interceptor._findBrowserPath = () => '/test/chrome-launcher';
  interceptor._createManagedProfile = () => '/test/profile';
  interceptor._spawn = () => child;
  interceptor._cleanup = () => assert.fail('an unverified startup profile must not be removed');
  interceptor._refreshTrackedProcessIds = async () => null;
  interceptor.startupConfirmationMs = 50;
  interceptor.ca = { systemTrustInstalled: true };

  const manager = Object.create(InterceptorManager.prototype);
  manager.interceptors = new Map();
  manager.operationsInProgress = new Map();
  manager.statusOperations = new Map();
  manager.closing = false;
  manager._initializationPromise = Promise.resolve(false);
  manager._register(interceptor);
  const events = [];
  manager.onStatusChange = event => events.push(event);

  const activation = manager.activate('chrome', 8080);
  await new Promise(resolve => setImmediate(resolve));
  child.emit('spawn');
  child.exitCode = 12;
  child.emit('exit', 12, null);

  await assert.rejects(activation, /Chrome exited during startup \(exit code 12\)/);
  assert.deepEqual(events.map(event => ({
    active: event.active,
    reason: event.reason,
    launchFailed: event.launchFailed,
    processStateUnknown: event.processStateUnknown
  })), [{
    active: true,
    reason: 'cleanup-failed',
    launchFailed: true,
    processStateUnknown: true
  }]);
  assert.equal(interceptor.active, true);
  assert.equal(interceptor.cleanupPending, true);

  interceptor._refreshTrackedProcessIds = async () => new Set();
  interceptor._terminateProcessTree = async targetIds => {
    assert.equal(targetIds.size, 0);
    return new Set();
  };
  interceptor._cleanup = profileDir => {
    assert.equal(profileDir, '/test/profile');
    return { removed: true };
  };

  await manager.deactivate('chrome');

  assert.deepEqual(events.map(event => [event.active, event.reason]), [
    [true, 'cleanup-failed'],
    [false, 'inactive']
  ]);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.cleanupPending, false);
  assert.equal(interceptor.profileDir, null);
});

test('UI refreshes interceptor state after an activation error', () => {
  const start = uiSource.indexOf('async function toggleInterceptor');
  const end = uiSource.indexOf('// ============ MOCK RULES', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const toggleSource = uiSource.slice(start, end);

  assert.match(
    toggleSource,
    /catch \(err\) \{[\s\S]*toast\(`Error: \$\{err\.message\}`, 'error'\);[\s\S]*setTimeout\(loadInterceptors, 300\);/
  );
});

test('Global Chrome activation rejects an early post-spawn exit', async () => {
  const interceptor = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome');
  const child = fakeChild(7401);
  interceptor._findBrowserPath = () => '/test/corrupt-chrome';
  interceptor._isBrowserRunning = async () => false;
  interceptor._spawn = () => child;
  interceptor.startupConfirmationMs = 50;
  interceptor.ca = { systemTrustInstalled: true };

  const activation = interceptor.activate(8080);
  await new Promise(resolve => setImmediate(resolve));
  child.emit('spawn');
  child.signalCode = 'SIGABRT';
  child.emit('exit', null, 'SIGABRT');

  await assert.rejects(activation, /Global Chrome exited during startup \(signal SIGABRT\)/);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
  assert.equal(child.listenerCount('spawn'), 0);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});
