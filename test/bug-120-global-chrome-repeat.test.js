import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ExistingBrowserInterceptor } from '../src/interceptors/existing-browser-interceptor.js';

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    });
    return true;
  };
  return child;
}

function spawnChild(child) {
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

test('Global Chrome rejects repeated activation and retains its first handle', async () => {
  const interceptor = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome');
  interceptor._findBrowserPath = () => '/test/chrome';
  interceptor._isBrowserRunning = async () => false;
  interceptor.ca = { systemTrustInstalled: true };
  const first = fakeChild(7101);
  let spawns = 0;
  interceptor._spawn = () => {
    spawns += 1;
    return spawnChild(first);
  };

  await interceptor.activate(8080);
  await assert.rejects(interceptor.activate(8080), /already running/);

  assert.equal(spawns, 1);
  assert.equal(interceptor.process, first);
  assert.equal(interceptor.active, true);
});

test('events from a stopped Global Chrome handle cannot affect a replacement', async () => {
  const interceptor = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome');
  interceptor._findBrowserPath = () => '/test/chrome';
  interceptor._isBrowserRunning = async () => false;
  interceptor.ca = { systemTrustInstalled: true };
  const first = fakeChild(7101);
  const second = fakeChild(7102);
  const children = [first, second];
  interceptor._spawn = () => spawnChild(children.shift());

  await interceptor.activate(8080);
  await interceptor.deactivate();
  await interceptor.activate(8080);
  first.emit('exit', 0);

  assert.equal(interceptor.process, second);
  assert.equal(interceptor.active, true);
});
