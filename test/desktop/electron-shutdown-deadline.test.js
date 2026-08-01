import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import shutdownModule from '../../electron/server-shutdown.cjs';

const {
  DEFAULT_EXIT_AFTER_CLEANUP_MS,
  DEFAULT_SHUTDOWN_DEADLINE_MS,
  SHUTDOWN_COMPLETE_MESSAGE,
  shutdownServerProcess
} = shutdownModule;

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.killSignals = [];
  }

  kill(signal) {
    this.killSignals.push(signal);
    return true;
  }

  exit() {
    this.exitCode = 0;
    this.emit('exit', 0, null);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createTimerHarness() {
  const timers = [];
  return {
    timers,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      timer.cleared = true;
    }
  };
}

function createRequest(onEnd = () => {}) {
  return (_options, onResponse) => {
    const req = new EventEmitter();
    req.end = () => {
      onResponse?.({ resume() {} });
      onEnd();
    };
    return req;
  };
}

test('resistant browser cleanup can finish before later proxy restorations without being force-killed', async () => {
  const proc = new FakeChildProcess();
  const timers = createTimerHarness();
  const browserCanExit = deferred();
  const cleanupEvents = [];

  const request = createRequest(() => {
    void (async () => {
      cleanupEvents.push('browser-sigterm');
      await browserCanExit.promise;
      cleanupEvents.push('browser-sigkill-wait-complete');
      cleanupEvents.push('system-proxy-restored');
      cleanupEvents.push('android-proxy-restored');
      proc.emit('message', { type: SHUTDOWN_COMPLETE_MESSAGE });
      proc.exit();
    })();
  });

  const shutdown = shutdownServerProcess({
    proc,
    apiPort: 8123,
    authToken: 'test-token',
    request,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });

  await Promise.resolve();
  assert.deepEqual(cleanupEvents, ['browser-sigterm']);
  assert.deepEqual(proc.killSignals, []);
  assert.equal(timers.timers[0].delay, DEFAULT_SHUTDOWN_DEADLINE_MS);

  browserCanExit.resolve();
  const result = await shutdown;

  assert.deepEqual(cleanupEvents, [
    'browser-sigterm',
    'browser-sigkill-wait-complete',
    'system-proxy-restored',
    'android-proxy-restored'
  ]);
  assert.deepEqual(proc.killSignals, []);
  assert.deepEqual(result, { reason: 'exit', cleanupComplete: true });
});

test('a hung cleanup is force-killed only when the deliberate overall deadline expires', async () => {
  const proc = new FakeChildProcess();
  const timers = createTimerHarness();
  const shutdown = shutdownServerProcess({
    proc,
    apiPort: 8123,
    authToken: 'test-token',
    request: createRequest(),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });

  assert.deepEqual(proc.killSignals, []);
  assert.equal(timers.timers.length, 1);
  assert.equal(timers.timers[0].delay, DEFAULT_SHUTDOWN_DEADLINE_MS);

  timers.timers[0].callback();
  assert.deepEqual(await shutdown, { reason: 'deadline', cleanupComplete: false });
  assert.deepEqual(proc.killSignals, ['SIGKILL']);
});

test('a backend that reports completed cleanup but stalls is safe to force-kill', async () => {
  const proc = new FakeChildProcess();
  const timers = createTimerHarness();
  const shutdown = shutdownServerProcess({
    proc,
    apiPort: 8123,
    authToken: 'test-token',
    request: createRequest(),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });

  proc.emit('message', { type: SHUTDOWN_COMPLETE_MESSAGE });

  assert.equal(timers.timers[0].cleared, true);
  assert.equal(timers.timers[1].delay, DEFAULT_EXIT_AFTER_CLEANUP_MS);
  assert.deepEqual(proc.killSignals, []);

  timers.timers[1].callback();
  assert.deepEqual(await shutdown, {
    reason: 'cleanup-complete-exit-timeout',
    cleanupComplete: true
  });
  assert.deepEqual(proc.killSignals, ['SIGKILL']);
});

test('desktop child wiring exposes IPC and reports completion after graceful cleanup', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const mainSource = fs.readFileSync(path.join(repoRoot, 'electron', 'main.cjs'), 'utf8');
  const backendSource = fs.readFileSync(path.join(repoRoot, 'src', 'index.js'), 'utf8');

  assert.match(mainSource, /stdio:\s*\['ignore', 'pipe', 'pipe', 'ipc'\]/);
  assert.match(mainSource, /shutdownServerProcess\(\{[\s\S]*?proc: serverProcess/);
  assert.ok(backendSource.includes(`type: '${SHUTDOWN_COMPLETE_MESSAGE}'`));
  assert.match(
    backendSource,
    /await interceptors\.deactivateAll\(\);[\s\S]*?await proxy\.stop\(\);[\s\S]*?await api\.stop\(\);[\s\S]*?await notifyDesktopShutdownComplete\(\);[\s\S]*?process\.exit\(finalExitCode\)/
  );
});
