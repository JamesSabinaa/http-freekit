import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import asarPathModule from '../../electron/asar-path.cjs';
import serverLogModule from '../../electron/server-log.cjs';

const { resolveBundledServerScript } = asarPathModule;
const {
  DEFAULT_SERVER_LOG_MAX_BYTES,
  DEFAULT_SERVER_LOG_MAX_FILES,
  createServerLogLifecycle
} = serverLogModule;
const mainSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.cjs'), 'utf8');
const startServerStart = mainSource.indexOf('async function startServer()');
const startServerEnd = mainSource.indexOf('function registerProtocolHandler()', startServerStart);
assert.ok(startServerStart >= 0 && startServerEnd > startServerStart);
const startServerSource = mainSource.slice(startServerStart, startServerEnd);

class FakeDestination extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.closed = false;
    this.writableEnded = false;
    this.writes = [];
    this.endCalls = 0;
  }

  write(message, callback) {
    this.writes.push({ message, callback });
    return true;
  }

  finishWrite(error) {
    const write = this.writes.at(-1);
    assert.ok(write, 'a pending write must exist');
    write.callback(error);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closed = true;
    this.emit('close');
  }

  end() {
    if (this.writableEnded) return;
    this.endCalls++;
    this.writableEnded = true;
    this.closed = true;
    this.emit('close');
  }
}

class FakeSource extends EventEmitter {
  constructor() {
    super();
    this.pipeCalls = [];
    this.unpipeCalls = [];
    this.resumeCalls = 0;
  }

  pipe(destination, options) {
    this.pipeCalls.push({ destination, options });
    return destination;
  }

  unpipe(destination) {
    this.unpipeCalls.push(destination);
  }

  resume() {
    this.resumeCalls++;
  }
}

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new FakeSource();
    this.stderr = new FakeSource();
    this.killed = false;
    this.killCalls = 0;
    this.killSignals = [];
  }

  kill(signal) {
    this.killed = true;
    this.killCalls++;
    this.killSignals.push(signal);
    return true;
  }
}

function createLifecycle(onLateError = () => {}) {
  const destination = new FakeDestination();
  const lifecycle = createServerLogLifecycle({
    logPath: 'server.log',
    initialMessage: 'starting\n',
    createDestination: () => destination,
    onLateError
  });
  return { destination, lifecycle };
}

async function makeLifecycleReady(harness) {
  harness.destination.finishWrite();
  await harness.lifecycle.ready;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('asynchronous log creation and first-write failures reject readiness without escaping', async () => {
  const openFailure = createLifecycle();
  const openReady = assert.rejects(openFailure.lifecycle.ready, /logs directory denied/);
  assert.doesNotThrow(() => {
    openFailure.destination.emit('error', new Error('logs directory denied'));
  });
  await openReady;
  assert.equal(openFailure.destination.destroyed, true);

  const writeFailure = createLifecycle();
  const writeReady = assert.rejects(writeFailure.lifecycle.ready, /disk full/);
  writeFailure.destination.finishWrite(new Error('disk full'));
  assert.doesNotThrow(() => {
    writeFailure.destination.emit('error', new Error('disk full'));
  });
  await writeReady;
  assert.equal(writeFailure.destination.destroyed, true);
});

test('a log pipe failure during startup rejects startup and detaches both child streams', async () => {
  const harness = createLifecycle();
  await makeLifecycleReady(harness);
  const proc = new FakeProcess();
  assert.equal(harness.lifecycle.attachProcess(proc), true);
  assert.deepEqual(proc.stdout.pipeCalls[0].options, { end: false });
  assert.deepEqual(proc.stderr.pipeCalls[0].options, { end: false });

  const startupFailure = assert.rejects(harness.lifecycle.startupFailure, /pipe broke/);
  assert.doesNotThrow(() => {
    harness.destination.emit('error', new Error('pipe broke'));
  });
  await startupFailure;

  assert.equal(harness.lifecycle.failed, true);
  assert.equal(harness.destination.destroyed, true);
  assert.deepEqual(proc.stdout.unpipeCalls, [harness.destination]);
  assert.deepEqual(proc.stderr.unpipeCalls, [harness.destination]);
  assert.equal(proc.stdout.resumeCalls, 1);
  assert.equal(proc.stderr.resumeCalls, 1);
});

test('a later log failure is reported once, disables logging, and cannot escape', async () => {
  const reported = [];
  const harness = createLifecycle(error => reported.push(error.message));
  await makeLifecycleReady(harness);
  const proc = new FakeProcess();
  harness.lifecycle.attachProcess(proc);
  harness.lifecycle.completeStartup();

  assert.doesNotThrow(() => {
    harness.destination.emit('error', new Error('ENOSPC'));
    harness.destination.emit('error', new Error('duplicate failure'));
  });

  assert.deepEqual(reported, ['ENOSPC']);
  assert.equal(harness.lifecycle.write('after failure'), false);
  assert.equal(harness.destination.destroyed, true);
  assert.equal(proc.stdout.unpipeCalls.length, 1);
  assert.equal(proc.stderr.unpipeCalls.length, 1);
  assert.equal(proc.stdout.resumeCalls, 1);
  assert.equal(proc.stderr.resumeCalls, 1);
});

test('child close unpipes both sources and ends the shared destination exactly once', async () => {
  const harness = createLifecycle();
  await makeLifecycleReady(harness);
  const proc = new FakeProcess();
  harness.lifecycle.attachProcess(proc);
  harness.lifecycle.completeStartup();

  proc.emit('close', 0, null);
  harness.lifecycle.close();

  assert.equal(harness.destination.endCalls, 1);
  assert.deepEqual(proc.stdout.unpipeCalls, [harness.destination]);
  assert.deepEqual(proc.stderr.unpipeCalls, [harness.destination]);
  assert.equal(proc.stdout.listenerCount('error'), 0);
  assert.equal(proc.stderr.listenerCount('error'), 0);
});

test('early lifecycle close keeps child stream errors handled until process close', async () => {
  const harness = createLifecycle();
  await makeLifecycleReady(harness);
  const proc = new FakeProcess();
  harness.lifecycle.attachProcess(proc);

  harness.lifecycle.close();
  assert.equal(proc.stdout.listenerCount('error'), 1);
  assert.doesNotThrow(() => proc.stdout.emit('error', new Error('late source error')));
  assert.equal(proc.stdout.resumeCalls, 1);
  assert.equal(proc.stderr.resumeCalls, 1);

  proc.emit('close', null, 'SIGTERM');
  assert.equal(proc.stdout.listenerCount('error'), 0);
  assert.equal(proc.stderr.listenerCount('error'), 0);
});

test('a retired retry process cannot close the destination used by its replacement', async () => {
  const harness = createLifecycle();
  await makeLifecycleReady(harness);
  const firstProc = new FakeProcess();
  const secondProc = new FakeProcess();

  assert.equal(harness.lifecycle.attachProcess(firstProc), true);
  assert.equal(harness.lifecycle.detachProcess(firstProc), true);
  assert.equal(harness.lifecycle.attachProcess(secondProc), true);
  harness.lifecycle.completeStartup();

  assert.doesNotThrow(() => firstProc.stdout.emit('error', new Error('retired pipe closed')));
  assert.equal(harness.lifecycle.failed, false);
  firstProc.emit('close', null, 'SIGKILL');
  assert.equal(harness.destination.endCalls, 0);
  assert.equal(firstProc.stdout.listenerCount('error'), 0);
  assert.equal(firstProc.stderr.listenerCount('error'), 0);

  secondProc.emit('close', 0, null);
  assert.equal(harness.destination.endCalls, 1);
  await harness.lifecycle.closed;
});

function createTemporaryLog(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-server-log-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'server.log');
}

async function closeLifecycle(lifecycle) {
  lifecycle.close();
  await lifecycle.closed;
}

test('default retention policy is explicitly bounded', () => {
  assert.equal(DEFAULT_SERVER_LOG_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(DEFAULT_SERVER_LOG_MAX_FILES, 3);
});

test('rotates only when the next record would exceed the threshold', async t => {
  const logPath = createTemporaryLog(t);
  const lifecycle = createServerLogLifecycle({
    logPath,
    initialMessage: '12345',
    maxBytes: 10,
    maxFiles: 3
  });
  await lifecycle.ready;

  await lifecycle.writeAndWait('67890');
  assert.equal(fs.readFileSync(logPath, 'utf8'), '1234567890');
  assert.equal(fs.existsSync(`${logPath}.1`), false);

  await lifecycle.writeAndWait('AB');
  await closeLifecycle(lifecycle);
  assert.equal(fs.readFileSync(logPath, 'utf8'), 'AB');
  assert.equal(fs.readFileSync(`${logPath}.1`, 'utf8'), '1234567890');
});

test('retains the newest active segment and two archives in age order', async t => {
  const logPath = createTemporaryLog(t);
  const lifecycle = createServerLogLifecycle({
    logPath,
    initialMessage: 'A111',
    maxBytes: 4,
    maxFiles: 3
  });
  await lifecycle.ready;
  await lifecycle.writeAndWait('B222');
  await lifecycle.writeAndWait('C333');
  await lifecycle.writeAndWait('D444');
  await closeLifecycle(lifecycle);

  const files = fs.readdirSync(path.dirname(logPath))
    .filter(name => name.startsWith('server.log'))
    .sort();
  assert.deepEqual(files, ['server.log', 'server.log.1', 'server.log.2']);
  assert.equal(fs.readFileSync(logPath, 'utf8'), 'D444');
  assert.equal(fs.readFileSync(`${logPath}.1`, 'utf8'), 'C333');
  assert.equal(fs.readFileSync(`${logPath}.2`, 'utf8'), 'B222');
});

test('splits an oversized output chunk without exceeding the total file bound', async t => {
  const logPath = createTemporaryLog(t);
  const lifecycle = createServerLogLifecycle({
    logPath,
    initialMessage: '0',
    maxBytes: 4,
    maxFiles: 3
  });
  await lifecycle.ready;
  await lifecycle.writeAndWait('123456789ABCDE');
  await closeLifecycle(lifecycle);

  const newestToOldest = [logPath, `${logPath}.1`, `${logPath}.2`];
  assert.deepEqual(newestToOldest.map(file => fs.statSync(file).size), [3, 4, 4]);
  assert.equal(fs.readFileSync(`${logPath}.2`, 'utf8'), '4567');
  assert.equal(fs.readFileSync(`${logPath}.1`, 'utf8'), '89AB');
  assert.equal(fs.readFileSync(logPath, 'utf8'), 'CDE');
});

test('repeated launches append below the threshold and rotate as one ordered history', async t => {
  const logPath = createTemporaryLog(t);
  const firstLaunch = createServerLogLifecycle({
    logPath,
    initialMessage: 'launch-one\n',
    maxBytes: 20,
    maxFiles: 3
  });
  await firstLaunch.ready;
  await closeLifecycle(firstLaunch);

  const secondLaunch = createServerLogLifecycle({
    logPath,
    initialMessage: 'launch-two\n',
    maxBytes: 20,
    maxFiles: 3
  });
  await secondLaunch.ready;
  await closeLifecycle(secondLaunch);

  assert.equal(fs.readFileSync(logPath, 'utf8'), 'launch-two\n');
  assert.equal(fs.readFileSync(`${logPath}.1`, 'utf8'), 'launch-one\n');
});

test('keeps recent tails from oversized legacy files and removes excess archives', async t => {
  const logPath = createTemporaryLog(t);
  fs.writeFileSync(logPath, 'old-0123456789');
  fs.writeFileSync(`${logPath}.1`, 'archive-abcdefghij');
  fs.writeFileSync(`${logPath}.3`, 'stale');

  const lifecycle = createServerLogLifecycle({
    logPath,
    initialMessage: 'N',
    maxBytes: 8,
    maxFiles: 3
  });
  await lifecycle.ready;
  await closeLifecycle(lifecycle);

  assert.equal(fs.readFileSync(logPath, 'utf8'), 'N');
  assert.equal(fs.readFileSync(`${logPath}.1`, 'utf8'), '23456789');
  assert.equal(fs.readFileSync(`${logPath}.2`, 'utf8'), 'cdefghij');
  assert.equal(fs.existsSync(`${logPath}.3`), false);
});

test('a missing active file is created without inventing an archive', async t => {
  const logPath = createTemporaryLog(t);
  const lifecycle = createServerLogLifecycle({
    logPath,
    initialMessage: 'new\n',
    maxBytes: 8,
    maxFiles: 3
  });
  await lifecycle.ready;
  await closeLifecycle(lifecycle);

  assert.equal(fs.readFileSync(logPath, 'utf8'), 'new\n');
  assert.equal(fs.existsSync(`${logPath}.1`), false);
});

test('a rotation failure before startup rejects readiness after closing the file', async t => {
  const logPath = createTemporaryLog(t);
  fs.writeFileSync(logPath, '1234');
  const streams = [];
  const rotationError = Object.assign(new Error('rotation denied'), { code: 'EACCES' });
  const fileSystem = new Proxy(fs.promises, {
    get(target, property) {
      if (property === 'rename') return async () => { throw rotationError; };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const lifecycle = createServerLogLifecycle({
    logPath,
    initialMessage: 'X',
    maxBytes: 4,
    maxFiles: 3,
    fileSystem,
    createWriteStream(filePath, options) {
      const stream = fs.createWriteStream(filePath, options);
      streams.push(stream);
      return stream;
    }
  });

  await assert.rejects(lifecycle.ready, rotationError);
  await lifecycle.closed;
  assert.equal(lifecycle.failed, true);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].closed, true);
});

test('a runtime rotation failure disables logging and is reported without escaping', async t => {
  const logPath = createTemporaryLog(t);
  const reported = [];
  const rotationError = Object.assign(new Error('archive rename failed'), { code: 'EACCES' });
  const fileSystem = new Proxy(fs.promises, {
    get(target, property) {
      if (property === 'rename') return async () => { throw rotationError; };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const lifecycle = createServerLogLifecycle({
    logPath,
    initialMessage: '1234',
    maxBytes: 4,
    maxFiles: 3,
    fileSystem,
    onLateError: error => reported.push(error.message)
  });
  await lifecycle.ready;
  lifecycle.completeStartup();

  await assert.rejects(lifecycle.writeAndWait('X'), rotationError);
  await lifecycle.closed;
  assert.equal(lifecycle.failed, true);
  assert.deepEqual(reported, ['archive rename failed']);
  assert.equal(lifecycle.write('after failure'), false);
});

function createStartServerHarness(serverLog, waitForServer) {
  const spawned = [];
  const context = {
    __dirname: path.join(process.cwd(), 'electron'),
    app: {
      isPackaged: false,
      getPath: name => name === 'logs' ? 'logs' : 'user-data'
    },
    console,
    createServerLogLifecycle: () => serverLog,
    findFreePort: async () => 8123,
    fs: { mkdirSync: () => {} },
    path,
    process: { execPath: 'electron', env: {} },
    resolveBundledServerScript,
    resolveDesktopMcpExecutable: () => 'mcp',
    spawn: () => {
      const proc = new FakeProcess();
      spawned.push(proc);
      return proc;
    },
    terminateServerStartupProcess: async proc => {
      if (!proc) return true;
      let terminationRequested = false;
      if (!proc.killed) {
        try { terminationRequested = proc.kill('SIGKILL'); } catch {}
      }
      return proc.killed || terminationRequested;
    },
    waitForServer,
    authToken: 'token',
    dialog: { showErrorBox: () => {} },
    mainWindow: null
  };
  vm.createContext(context);
  vm.runInContext(`
    let apiPort = null;
    let serverProcess = null;
    let serverReady = false;
    let isShuttingDown = false;
    ${startServerSource}
    globalThis.callStartServer = startServer;
    globalThis.serverState = () => ({ apiPort, serverProcess, serverReady });
  `, context);
  return { context, spawned };
}

test('startServer does not spawn until the log destination is ready', async () => {
  const startupError = new Error('cannot create server log');
  const serverLog = {
    ready: Promise.reject(startupError),
    startupFailure: new Promise(() => {}),
    closed: Promise.resolve(),
    attachProcess: () => {},
    detachProcess: () => {},
    completeStartup: () => {},
    write: () => false,
    writeAndWait: () => Promise.resolve(),
    close: () => {}
  };
  const harness = createStartServerHarness(serverLog, () => new Promise(() => {}));

  await assert.rejects(harness.context.callStartServer(), startupError);
  assert.equal(harness.spawned.length, 0);
});

test('a log failure while waiting for readiness rejects startServer and kills its child', async () => {
  const logFailure = deferred();
  let closeCalls = 0;
  const serverLog = {
    ready: Promise.resolve(),
    startupFailure: logFailure.promise,
    closed: Promise.resolve(),
    attachProcess: () => true,
    detachProcess: () => true,
    completeStartup: () => {},
    write: () => true,
    writeAndWait: () => Promise.resolve(),
    close: () => { closeCalls++; }
  };
  const harness = createStartServerHarness(serverLog, () => new Promise(() => {}));
  const starting = harness.context.callStartServer();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.spawned.length, 1);

  logFailure.reject(new Error('server log pipe failed'));
  await assert.rejects(starting, /server log pipe failed/);

  assert.equal(closeCalls, 1);
  assert.equal(harness.spawned[0].killCalls, 1);
  assert.deepEqual(harness.spawned[0].killSignals, ['SIGKILL']);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.serverState())), {
    apiPort: 8123,
    serverProcess: null,
    serverReady: false
  });
});

test('a retry-banner rotation failure aborts before spawning a replacement child', async () => {
  const rotationError = new Error('could not rotate retry log');
  let closeCalls = 0;
  let retryWriteCalls = 0;
  const serverLog = {
    ready: Promise.resolve(),
    startupFailure: new Promise(() => {}),
    closed: Promise.resolve(),
    attachProcess: () => true,
    detachProcess: () => true,
    completeStartup: () => {},
    write: () => true,
    writeAndWait: async () => {
      retryWriteCalls++;
      throw rotationError;
    },
    close: () => { closeCalls++; }
  };
  let readinessCalls = 0;
  const harness = createStartServerHarness(serverLog, async () => {
    readinessCalls++;
    const collision = new Error('port collision');
    collision.code = 'EADDRINUSE';
    collision.apiPort = 8123;
    throw collision;
  });

  await assert.rejects(harness.context.callStartServer(), rotationError);
  assert.equal(readinessCalls, 1);
  assert.equal(retryWriteCalls, 1);
  assert.equal(harness.spawned.length, 1);
  assert.equal(harness.spawned[0].killCalls, 1);
  assert.equal(closeCalls, 1);
});

test('a child that cannot be force-killed remains tracked for quit cleanup', async () => {
  const logFailure = deferred();
  const serverLog = {
    ready: Promise.resolve(),
    startupFailure: logFailure.promise,
    closed: Promise.resolve(),
    attachProcess: () => true,
    detachProcess: () => true,
    completeStartup: () => {},
    write: () => true,
    writeAndWait: () => Promise.resolve(),
    close: () => {}
  };
  const harness = createStartServerHarness(serverLog, () => new Promise(() => {}));
  const starting = harness.context.callStartServer();
  await new Promise(resolve => setImmediate(resolve));
  const proc = harness.spawned[0];
  proc.kill = signal => {
    proc.killCalls++;
    proc.killSignals.push(signal);
    return false;
  };

  logFailure.reject(new Error('server log failed'));
  await assert.rejects(starting, /server log failed/);

  assert.deepEqual(proc.killSignals, ['SIGKILL']);
  assert.equal(harness.context.serverState().serverProcess, proc);
  assert.equal(harness.context.serverState().serverReady, false);
});
