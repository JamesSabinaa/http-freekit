import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ExistingBrowserInterceptor } from '../src/interceptors/existing-browser-interceptor.js';

function fakeChild(pid, kill) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killSignals = [];
  child.kill = signal => {
    child.killSignals.push(signal);
    return kill(signal, child);
  };
  return child;
}

function emitExit(child, { code = 0, signal = null } = {}) {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit('exit', code, signal);
}

function activeInterceptor(child) {
  const interceptor = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome');
  interceptor.active = true;
  interceptor.process = child;
  interceptor.gracefulExitTimeoutMs = 10;
  interceptor.forceExitTimeoutMs = 10;
  return interceptor;
}

function spawnChild(child) {
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

test('Global Chrome Stop remains active until SIGTERM produces an actual exit', async () => {
  const child = fakeChild(7401, (_signal, processHandle) => {
    queueMicrotask(() => emitExit(processHandle));
    return true;
  });
  const interceptor = activeInterceptor(child);
  const statuses = [];
  interceptor.onStatusChange = event => statuses.push(event);

  const stopping = interceptor.deactivate();
  assert.equal(interceptor.active, true);
  assert.equal(interceptor.process, child);
  await stopping;

  assert.deepEqual(child.killSignals, ['SIGTERM']);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
  assert.deepEqual(statuses.map(event => event.reason), ['inactive']);
});

test('Global Chrome Stop escalates an ignored SIGTERM and waits for forced exit', async () => {
  const child = fakeChild(7402, (signal, processHandle) => {
    if (signal === 'SIGKILL') {
      queueMicrotask(() => emitExit(processHandle, { code: null, signal: 'SIGKILL' }));
    }
    return true;
  });
  const interceptor = activeInterceptor(child);

  await interceptor.deactivate();

  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
});

test('unconfirmed signal failures retain the exact child so Stop can retry it', async () => {
  let attempt = 0;
  const child = fakeChild(7403, (signal, processHandle) => {
    if (attempt === 0 && signal === 'SIGTERM') {
      queueMicrotask(() => processHandle.emit('error', new Error('EPERM')));
      return true;
    }
    if (attempt === 0) return false;
    queueMicrotask(() => emitExit(processHandle));
    return true;
  });
  const interceptor = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome');
  interceptor._findBrowserPath = () => '/test/chrome';
  interceptor._isBrowserRunning = async () => false;
  interceptor._spawn = () => spawnChild(child);
  interceptor.ca = { systemTrustInstalled: true };
  interceptor.gracefulExitTimeoutMs = 10;
  interceptor.forceExitTimeoutMs = 10;
  const statuses = [];
  interceptor.onStatusChange = event => statuses.push(event);
  await interceptor.activate(8080);
  statuses.length = 0;

  await assert.rejects(interceptor.deactivate(), /process state was preserved.*Stop can be retried/);

  assert.equal(interceptor.active, true);
  assert.equal(interceptor.process, child);
  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(statuses.some(event => event.reason === 'inactive'), false);
  assert.equal(statuses[0].reason, 'process-error');
  assert.equal(statuses[0].active, true);
  assert.equal(statuses.at(-1).reason, 'stop-failed');
  assert.equal(statuses.at(-1).active, true);
  assert.equal(statuses.at(-1).pid, child.pid);

  attempt += 1;
  await interceptor.deactivate();

  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL', 'SIGTERM']);
});

test('an already-exited Global Chrome is cleared without sending another signal', async () => {
  const child = fakeChild(7404, () => {
    throw new Error('an already-exited child must not be signaled');
  });
  child.exitCode = 0;
  const interceptor = activeInterceptor(child);

  await interceptor.deactivate();

  assert.deepEqual(child.killSignals, []);
  assert.equal(interceptor.process, null);
  assert.equal(interceptor.active, false);
});

test('stale exit and error listeners cannot clear or misreport a newer child', async () => {
  const oldChild = fakeChild(7405, (_signal, processHandle) => {
    queueMicrotask(() => emitExit(processHandle));
    return true;
  });
  const newerChild = fakeChild(7406, () => true);
  const children = [oldChild, newerChild];
  const interceptor = new ExistingBrowserInterceptor('existing-chrome', 'Global Chrome', 'chrome');
  interceptor._findBrowserPath = () => '/test/chrome';
  interceptor._isBrowserRunning = async () => false;
  interceptor._spawn = () => spawnChild(children.shift());
  interceptor.ca = { systemTrustInstalled: true };
  const statuses = [];
  interceptor.onStatusChange = event => statuses.push(event);

  await interceptor.activate(8080);
  await interceptor.deactivate();
  await interceptor.activate(8080);
  const statusCount = statuses.length;

  oldChild.emit('exit', 0, null);
  oldChild.emit('error', new Error('stale child error'));

  assert.equal(interceptor.process, newerChild);
  assert.equal(interceptor.active, true);
  assert.equal(statuses.length, statusCount);
});
