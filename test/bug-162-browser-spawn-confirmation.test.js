import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { BrowserInterceptor } from '../src/interceptors/browser-interceptor.js';
import { ExistingBrowserInterceptor } from '../src/interceptors/existing-browser-interceptor.js';

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
  interceptor.ca = { systemTrustInstalled: true };

  let settled = false;
  const activation = interceptor.activate(8080).finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);

  child.pid = 7101;
  child.emit('spawn');
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
  interceptor.ca = { systemTrustInstalled: true };

  let settled = false;
  const activation = interceptor.activate(8080).finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);

  child.pid = 7201;
  child.emit('spawn');
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
