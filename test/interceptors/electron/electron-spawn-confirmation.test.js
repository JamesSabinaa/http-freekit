import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ElectronInterceptor } from '../../../src/interceptors/electron-interceptor.js';

function fakeChild(pid = 1234) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

test('Electron activation rejects an asynchronous spawn failure', async () => {
  const interceptor = new ElectronInterceptor();
  interceptor.ca = {
    getSpkiFingerprint: () => 'test-spki',
    getTerminalCaBundlePath: () => process.execPath
  };
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
  interceptor.startupConfirmationMs = 0;
  interceptor.ca = {
    getSpkiFingerprint: () => 'test-spki',
    getTerminalCaBundlePath: () => process.execPath
  };
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

test('Electron activation rejects a child that exits during the stability window', async () => {
  const interceptor = new ElectronInterceptor();
  interceptor.startupConfirmationMs = 25;
  interceptor.ca = {
    getSpkiFingerprint: () => 'test-spki',
    getTerminalCaBundlePath: () => process.execPath
  };
  const child = fakeChild();
  interceptor._spawn = () => child;
  let settled = false;

  const activation = interceptor.activate(8080, { appPath: 'single-instance-app' });
  activation.then(
    () => { settled = true; },
    () => { settled = true; }
  );
  await new Promise(resolve => setImmediate(resolve));
  child.emit('spawn');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);

  child.exitCode = 0;
  child.emit('exit', 0, null);
  await assert.rejects(activation, /exited during startup/);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
});

test('overlapping Electron activation is rejected while spawn is pending', async () => {
  const interceptor = new ElectronInterceptor();
  interceptor.startupConfirmationMs = 0;
  interceptor.ca = {
    getSpkiFingerprint: () => 'test-spki',
    getTerminalCaBundlePath: () => process.execPath
  };
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
