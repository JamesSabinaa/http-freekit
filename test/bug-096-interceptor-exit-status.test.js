import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ElectronInterceptor } from '../src/interceptors/electron-interceptor.js';
import { FreshTerminalInterceptor } from '../src/interceptors/terminal-interceptors.js';

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

test('Electron child exit publishes an inactive status event', async () => {
  const interceptor = new ElectronInterceptor();
  interceptor.ca = {
    getSpkiFingerprint: () => 'test-spki',
    getTerminalCaBundlePath: () => process.execPath
  };
  const child = fakeChild(5101);
  interceptor._spawn = () => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const events = [];
  interceptor.onStatusChange = event => events.push(event);

  await interceptor.activate(8080, { appPath: 'test-electron-app' });
  child.emit('exit', 0);

  assert.equal(events.at(-1).reason, 'exited');
  assert.equal(events.at(-1).active, false);
  assert.equal(events.at(-1).pid, 5101);
});

test('Fresh Terminal session exit publishes an inactive status event', async () => {
  const interceptor = new FreshTerminalInterceptor();
  interceptor.active = true;
  interceptor.sessions.set(6201, { pid: 6201, startTime: '300', executable: '/bin/sh' });
  interceptor._inspectSessionIdentity = async () => ({ state: 'absent' });
  const events = [];
  interceptor.onStatusChange = event => events.push(event);

  await interceptor._refreshActiveState();

  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'exited');
  assert.equal(events[0].active, false);
});
