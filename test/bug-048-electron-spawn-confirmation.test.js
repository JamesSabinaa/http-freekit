import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ElectronInterceptor } from '../src/interceptors/electron-interceptor.js';

function fakeChild(pid = 1234) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

test('Electron activation rejects an asynchronous spawn failure', async () => {
  const interceptor = new ElectronInterceptor();
  interceptor.ca = { getSpkiFingerprint: () => 'test-spki' };
  const child = fakeChild();
  interceptor._spawn = () => {
    queueMicrotask(() => child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' })));
    return child;
  };

  await assert.rejects(
    interceptor.activate(8080, { appPath: 'missing-app' }),
    /Failed to launch Electron app: not found/
  );

  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
  assert.equal(interceptor.activating, false);
});

test('Electron activation does not resolve before the spawn event', async () => {
  const interceptor = new ElectronInterceptor();
  interceptor.ca = { getSpkiFingerprint: () => 'test-spki' };
  const child = fakeChild();
  interceptor._spawn = () => child;
  let settled = false;

  const activation = interceptor.activate(8080, { appPath: 'slow-app' }).then(result => {
    settled = true;
    return result;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(interceptor.activating, true);

  child.emit('spawn');
  const result = await activation;
  assert.equal(result.success, true);
  assert.equal(interceptor.active, true);
  assert.equal(interceptor.process, child);
});

test('overlapping Electron activation is rejected while spawn is pending', async () => {
  const interceptor = new ElectronInterceptor();
  interceptor.ca = { getSpkiFingerprint: () => 'test-spki' };
  const child = fakeChild();
  interceptor._spawn = () => child;

  const firstActivation = interceptor.activate(8080, { appPath: 'slow-app' });
  await assert.rejects(
    interceptor.activate(8080, { appPath: 'second-app' }),
    /already being intercepted/
  );
  child.emit('spawn');
  await firstActivation;
});
