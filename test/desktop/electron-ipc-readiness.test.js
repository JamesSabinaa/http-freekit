import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import readinessModule from '../../electron/server-readiness.cjs';

const { SERVER_READY_MESSAGE_TYPE, waitForServer } = readinessModule;
const desktopSource = fs.readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
const serverSource = fs.readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');

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
    },
    fire(handle = scheduled[0]) {
      assert.ok(handle, 'a timeout must be scheduled');
      handle.callback();
    }
  };
}

function waitWithTimers(port, proc, timeoutMs, timers) {
  return waitForServer(port, proc, timeoutMs, {
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });
}

test('the server child reports readiness only after its API listener starts', () => {
  const apiStarted = serverSource.indexOf('await api.start();');
  const desktopGuard = serverSource.indexOf("process.env.ELECTRON === '1'", apiStarted);
  const readyMessage = serverSource.indexOf(
    `type: '${SERVER_READY_MESSAGE_TYPE}'`,
    apiStarted
  );
  const mcpInitialization = serverSource.indexOf('// 6. Initialize MCP Server', apiStarted);

  assert.ok(apiStarted >= 0);
  assert.ok(desktopGuard > apiStarted);
  assert.ok(readyMessage > desktopGuard);
  assert.ok(mcpInitialization > readyMessage);
});

test('Electron startup uses the child IPC waiter instead of an HTTP readiness probe', () => {
  const startServerStart = desktopSource.indexOf('async function startServer()');
  const startServerEnd = desktopSource.indexOf('function registerProtocolHandler()', startServerStart);
  const startServer = desktopSource.slice(startServerStart, startServerEnd);

  assert.match(desktopSource, /const \{ waitForServer \} = require\('\.\/server-readiness\.cjs'\);/);
  assert.doesNotMatch(desktopSource, /function waitForServer\(/);
  assert.match(startServer, /ELECTRON: '1'/);
  assert.match(startServer, /waitForServer\(apiPort, proc\)/);
});

test('an unrelated HTTP 503 listener is never treated as the FreeKit child', async t => {
  const requests = [];
  const impostor = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'not-http-freekit' }));
  });
  impostor.listen(0, '127.0.0.1');
  await once(impostor, 'listening');
  t.after(() => new Promise(resolve => impostor.close(resolve)));

  const proc = new EventEmitter();
  const port = impostor.address().port;

  await assert.rejects(
    waitForServer(port, proc, 30),
    /Server did not start within 30ms/
  );
  assert.deepEqual(requests, [], 'readiness must not send auth or any request to the port winner');
  assert.equal(proc.listenerCount('message'), 0);
  assert.equal(proc.listenerCount('exit'), 0);
});

test('the exact spawned child readiness message resolves and cleans up listeners', async () => {
  const proc = new EventEmitter();
  const timers = createTimers();
  const waiting = waitWithTimers(8123, proc, 30000, timers);

  assert.equal(proc.listenerCount('message'), 1);
  assert.equal(proc.listenerCount('exit'), 1);
  assert.equal(timers.scheduled[0].delay, 30000);

  proc.emit('message', { type: SERVER_READY_MESSAGE_TYPE, port: 8123 });
  await waiting;

  assert.equal(proc.listenerCount('message'), 0);
  assert.equal(proc.listenerCount('exit'), 0);
  assert.deepEqual(timers.cleared, timers.scheduled);
});

test('wrong IPC types, malformed ports, and wrong ports are ignored', async () => {
  const proc = new EventEmitter();
  const timers = createTimers();
  let settled = false;
  const waiting = waitWithTimers(8123, proc, 30000, timers).then(() => {
    settled = true;
  });

  for (const message of [
    null,
    'ready',
    {},
    { type: 'other-service:ready', port: 8123 },
    { type: SERVER_READY_MESSAGE_TYPE },
    { type: SERVER_READY_MESSAGE_TYPE, port: '8123' },
    { type: SERVER_READY_MESSAGE_TYPE, port: 8124 },
    Object.create({ type: SERVER_READY_MESSAGE_TYPE, port: 8123 })
  ]) {
    proc.emit('message', message);
  }
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(proc.listenerCount('message'), 1);
  assert.equal(proc.listenerCount('exit'), 1);

  proc.emit('message', { type: SERVER_READY_MESSAGE_TYPE, port: 8123 });
  await waiting;
  assert.equal(settled, true);
  assert.equal(proc.listenerCount('message'), 0);
  assert.equal(proc.listenerCount('exit'), 0);
});

test('child exit before readiness rejects immediately and cleans up', async () => {
  const proc = new EventEmitter();
  const timers = createTimers();
  const waiting = waitWithTimers(8123, proc, 30000, timers);

  proc.emit('exit', 7);

  await assert.rejects(waiting, /Server process exited with code 7 before becoming ready/);
  assert.equal(proc.listenerCount('message'), 0);
  assert.equal(proc.listenerCount('exit'), 0);
  assert.deepEqual(timers.cleared, timers.scheduled);
});

test('readiness timeout rejects and removes child listeners', async () => {
  const proc = new EventEmitter();
  const timers = createTimers();
  const waiting = waitWithTimers(8123, proc, 1234, timers);

  timers.fire();

  await assert.rejects(waiting, /Server did not start within 1234ms/);
  assert.equal(proc.listenerCount('message'), 0);
  assert.equal(proc.listenerCount('exit'), 0);
  assert.deepEqual(timers.cleared, timers.scheduled);
});
