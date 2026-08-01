import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ElectronInterceptor } from '../../../src/interceptors/electron-interceptor.js';

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit('exit', 0));
    return true;
  };
  return child;
}

test('a second Electron activation is rejected while the first child is active', async () => {
  const interceptor = new ElectronInterceptor();
  interceptor.ca = {
    getSpkiFingerprint: () => 'test-spki',
    getTerminalCaBundlePath: () => process.execPath
  };
  const first = fakeChild(1001);
  let spawnCount = 0;
  interceptor._spawn = () => {
    spawnCount += 1;
    queueMicrotask(() => first.emit('spawn'));
    return first;
  };

  await interceptor.activate(8080, { appPath: 'first-app' });
  await assert.rejects(
    interceptor.activate(8080, { appPath: 'second-app' }),
    /already being intercepted/
  );

  assert.equal(spawnCount, 1);
  assert.equal(interceptor.process, first);
  assert.equal(interceptor.active, true);
});

test('events from a stopped Electron child cannot deactivate its replacement', async () => {
  const interceptor = new ElectronInterceptor();
  interceptor.ca = {
    getSpkiFingerprint: () => 'test-spki',
    getTerminalCaBundlePath: () => process.execPath
  };
  const first = fakeChild(1001);
  const second = fakeChild(1002);
  const children = [first, second];
  interceptor._spawn = () => {
    const child = children.shift();
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };

  await interceptor.activate(8080, { appPath: 'first-app' });
  await interceptor.deactivate();
  await interceptor.activate(8080, { appPath: 'second-app' });
  first.emit('exit', 0);

  assert.equal(interceptor.process, second);
  assert.equal(interceptor.active, true);
  await interceptor.deactivate();
  assert.equal(second.killed, true);
});
