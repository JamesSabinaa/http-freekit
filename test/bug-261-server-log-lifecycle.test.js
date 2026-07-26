import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import serverLogModule from '../electron/server-log.cjs';

const { createServerLogLifecycle } = serverLogModule;
const mainSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.cjs'), 'utf8');
const startServerStart = mainSource.indexOf('async function startServer()');
const startServerEnd = mainSource.indexOf('function registerProtocolHandler()', startServerStart);
assert.ok(startServerStart >= 0 && startServerEnd > startServerStart);
const startServerSource = mainSource.slice(startServerStart, startServerEnd);

class FakeDestination extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
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
    this.destroyed = true;
  }

  end() {
    this.endCalls++;
    this.writableEnded = true;
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
    createWriteStream: () => destination,
    onLateError
  });
  return { destination, lifecycle };
}

async function makeLifecycleReady(harness) {
  harness.destination.emit('open');
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
  writeFailure.destination.emit('open');
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
    resolveDesktopMcpExecutable: () => 'mcp',
    spawn: () => {
      const proc = new FakeProcess();
      spawned.push(proc);
      return proc;
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
    attachProcess: () => {},
    completeStartup: () => {},
    write: () => false,
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
    attachProcess: () => true,
    completeStartup: () => {},
    write: () => true,
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

test('a child that cannot be force-killed remains tracked for quit cleanup', async () => {
  const logFailure = deferred();
  const serverLog = {
    ready: Promise.resolve(),
    startupFailure: logFailure.promise,
    attachProcess: () => true,
    completeStartup: () => {},
    write: () => true,
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
