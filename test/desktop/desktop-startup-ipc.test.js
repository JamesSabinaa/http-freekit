import assert from 'node:assert/strict';
import test from 'node:test';
import readinessModule from '../../electron/server-readiness.cjs';
import {
  DESKTOP_API_PORT_IN_USE_MESSAGE_TYPE,
  reportDesktopApiPortInUse
} from '../../src/desktop-startup-ipc.js';

const { SERVER_API_PORT_IN_USE_MESSAGE_TYPE } = readinessModule;

function createTimers() {
  const scheduled = [];
  const cleared = [];
  return {
    scheduled,
    cleared,
    setTimeoutFn(callback, delay) {
      const handle = { callback, delay };
      scheduled.push(handle);
      return handle;
    },
    clearTimeoutFn(handle) {
      handle.cleared = true;
      cleared.push(handle);
    }
  };
}

test('child and desktop use the same API-port collision message type', () => {
  assert.equal(DESKTOP_API_PORT_IN_USE_MESSAGE_TYPE, SERVER_API_PORT_IN_USE_MESSAGE_TYPE);
});

test('the child waits for delivery of the API-port collision retry signal', async () => {
  const timers = createTimers();
  const messages = [];
  let sendCallback;
  const ipcProcess = {
    connected: true,
    send(message, callback) {
      messages.push(message);
      sendCallback = callback;
    }
  };
  const reporting = reportDesktopApiPortInUse(8123, ipcProcess, {
    timeoutMs: 321,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });

  assert.deepEqual(messages, [{
    type: DESKTOP_API_PORT_IN_USE_MESSAGE_TYPE,
    port: 8123
  }]);
  assert.equal(timers.scheduled[0].delay, 321);
  sendCallback(null);

  assert.equal(await reporting, true);
  assert.deepEqual(timers.cleared, timers.scheduled);
});

test('a broken or stalled collision-report channel fails closed and cleans up', async () => {
  const throwingTimers = createTimers();
  assert.equal(await reportDesktopApiPortInUse(8123, {
    connected: true,
    send() { throw new Error('IPC unavailable'); }
  }, {
    setTimeoutFn: throwingTimers.setTimeoutFn,
    clearTimeoutFn: throwingTimers.clearTimeoutFn
  }), false);
  assert.deepEqual(throwingTimers.cleared, throwingTimers.scheduled);

  const stalledTimers = createTimers();
  const stalled = reportDesktopApiPortInUse(8123, {
    connected: true,
    send() {}
  }, {
    setTimeoutFn: stalledTimers.setTimeoutFn,
    clearTimeoutFn: stalledTimers.clearTimeoutFn
  });
  stalledTimers.scheduled[0].callback();
  assert.equal(await stalled, false);
  assert.deepEqual(stalledTimers.cleared, stalledTimers.scheduled);

  assert.equal(await reportDesktopApiPortInUse(8123, { connected: false }), false);
});
