import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ElectronInterceptor } from '../../../src/interceptors/electron-interceptor.js';

function fakeChild(pid = 7301) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.killCount = 0;
  child.kill = () => {
    child.killed = true;
    child.killCount += 1;
    return true;
  };
  return child;
}

test('Electron Stop remains pending until the child confirms exit', async () => {
  const interceptor = new ElectronInterceptor();
  const child = fakeChild();
  interceptor.active = true;
  interceptor.process = child;
  let settled = false;

  const stopping = interceptor.deactivate().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(interceptor.active, true);
  assert.equal(interceptor.process, child);

  child.emit('exit', 0);
  await stopping;

  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
});

test('Electron Stop preserves process state when exit is not confirmed', async () => {
  const interceptor = new ElectronInterceptor();
  const child = fakeChild();
  interceptor.active = true;
  interceptor.process = child;
  interceptor.deactivationTimeoutMs = 10;

  await assert.rejects(interceptor.deactivate(), /Stop can be retried/);

  assert.equal(interceptor.active, true);
  assert.equal(interceptor.process, child);
  assert.equal(await interceptor.isActive(), true);
  assert.equal(child.killCount, 1);

  child.kill = () => {
    child.killCount += 1;
    queueMicrotask(() => child.emit('exit', 0));
    return true;
  };
  await interceptor.deactivate();

  assert.equal(child.killCount, 2);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
});
