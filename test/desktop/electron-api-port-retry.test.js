import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import asarPathModule from '../../electron/asar-path.cjs';
import readinessModule from '../../electron/server-readiness.cjs';

const { resolveBundledServerScript } = asarPathModule;
const {
  SERVER_API_PORT_IN_USE_MESSAGE_TYPE,
  SERVER_READY_MESSAGE_TYPE,
  terminateServerStartupProcess,
  waitForServer
} = readinessModule;
const mainSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.cjs'), 'utf8');
const findFreePortStart = mainSource.indexOf('async function findFreePort(');
const startServerStart = mainSource.indexOf('async function startServer()');
const startServerEnd = mainSource.indexOf('function registerProtocolHandler()', startServerStart);
assert.ok(findFreePortStart >= 0 && startServerStart > findFreePortStart && startServerEnd > startServerStart);
const findFreePortSource = mainSource.slice(findFreePortStart, startServerStart);
const startServerSource = mainSource.slice(startServerStart, startServerEnd);

class FakeSource extends EventEmitter {
  pipe() {}
  unpipe() {}
  resume() {}
}

class FakeProcess extends EventEmitter {
  constructor({ killResult = true } = {}) {
    super();
    this.stdout = new FakeSource();
    this.stderr = new FakeSource();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.killResult = killResult;
    this.killSignals = [];
  }

  kill(signal) {
    this.killSignals.push(signal);
    if (!this.killResult) return false;
    this.killed = true;
    setImmediate(() => {
      this.signalCode = signal;
      this.emit('exit', null, signal);
      this.emit('close', null, signal);
    });
    return true;
  }
}

function createLogLifecycle() {
  return {
    ready: Promise.resolve(),
    startupFailure: new Promise(() => {}),
    closed: Promise.resolve(),
    attached: [],
    detached: [],
    completeCalls: 0,
    closeCalls: 0,
    writes: [],
    attachProcess(proc) {
      this.attached.push(proc);
      return true;
    },
    detachProcess(proc) {
      this.detached.push(proc);
      return true;
    },
    completeStartup() { this.completeCalls++; },
    write(message) {
      this.writes.push(message);
      return true;
    },
    async writeAndWait(message) {
      this.writes.push(message);
    },
    close() { this.closeCalls++; }
  };
}

function createHarness({
  ports,
  outcomes,
  killResults = [],
  terminate = terminateServerStartupProcess
}) {
  const remainingPorts = [...ports];
  const remainingOutcomes = [...outcomes];
  const excludedPortSnapshots = [];
  const logs = [];
  const processes = [];
  const spawnCalls = [];
  const context = {
    __dirname: path.join(process.cwd(), 'electron'),
    app: {
      isPackaged: true,
      getPath: name => name === 'logs' ? 'logs' : 'user-data'
    },
    authToken: 'stable-auth-token',
    console,
    createServerLogLifecycle: options => {
      const lifecycle = createLogLifecycle();
      lifecycle.options = options;
      logs.push(lifecycle);
      return lifecycle;
    },
    dialog: { showErrorBox: () => {} },
    findFreePort: async excludedPorts => {
      excludedPortSnapshots.push([...excludedPorts]);
      assert.ok(remainingPorts.length > 0, 'a deterministic port must remain');
      return remainingPorts.shift();
    },
    fs: { mkdirSync: () => {} },
    mainWindow: null,
    path,
    process: {
      execPath: 'electron',
      env: { APPIMAGE: 'HTTP-FreeKit.AppImage' },
      platform: 'linux'
    },
    resolveBundledServerScript,
    resolveDesktopMcpExecutable: () => 'desktop-mcp',
    spawn: (command, args, options) => {
      const proc = new FakeProcess({ killResult: killResults[processes.length] ?? true });
      const outcome = remainingOutcomes.shift();
      processes.push(proc);
      spawnCalls.push({ command, args, options, proc });
      setImmediate(() => {
        if (outcome === 'collision') {
          proc.emit('message', {
            type: SERVER_API_PORT_IN_USE_MESSAGE_TYPE,
            port: Number(options.env.API_PORT)
          });
        } else if (outcome === 'ready') {
          proc.emit('message', {
            type: SERVER_READY_MESSAGE_TYPE,
            port: Number(options.env.API_PORT)
          });
        } else if (outcome === 'unscoped-collision') {
          const error = new Error('some other listener collided');
          error.code = 'EADDRINUSE';
          proc.emit('error', error);
        }
      });
      return proc;
    },
    terminateServerStartupProcess: terminate,
    waitForServer
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
  return { context, excludedPortSnapshots, logs, processes, spawnCalls };
}

test('port discovery closes and skips a port used by an earlier failed attempt', async () => {
  const discoveredPorts = [8123, 8124];
  const servers = [];
  const context = {
    net: {
      createServer() {
        const server = new EventEmitter();
        server.closed = false;
        server.listen = (_port, _host, callback) => setImmediate(callback);
        server.address = () => ({ port: discoveredPorts[servers.indexOf(server)] });
        server.close = callback => {
          server.closed = true;
          setImmediate(callback);
        };
        servers.push(server);
        return server;
      }
    },
    Set
  };
  vm.createContext(context);
  vm.runInContext(`${findFreePortSource}\nglobalThis.callFindFreePort = findFreePort;`, context);

  assert.equal(await context.callFindFreePort(new Set([8123])), 8124);
  assert.equal(servers.length, 2);
  assert.deepEqual(servers.map(server => server.closed), [true, true]);
});

test('a forced release-and-rebind collision is cleaned up and retried on a new port', async () => {
  const harness = createHarness({
    ports: [8123, 8124],
    outcomes: ['collision', 'ready']
  });

  await harness.context.callStartServer();

  assert.equal(harness.spawnCalls.length, 2);
  assert.deepEqual(harness.excludedPortSnapshots, [[], [8123]]);
  assert.deepEqual(harness.spawnCalls.map(call => call.options.env.API_PORT), ['8123', '8124']);
  for (const call of harness.spawnCalls) {
    assert.equal(call.options.env.AUTH_TOKEN, 'stable-auth-token');
    assert.equal(call.options.env.ELECTRON, '1');
    assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(call.options.env.HTTP_FREEKIT_MCP_EXECUTABLE, 'desktop-mcp');
    assert.equal(call.options.env.HTTP_FREEKIT_MCP_PACKAGED_APP, '1');
    assert.equal(call.options.env.HTTP_FREEKIT_MCP_REMOUNTING_APP, '1');
    assert.equal(call.options.env.HTTP_FREEKIT_MCP_DESCRIPTOR_PATH,
      path.join('user-data', 'mcp-runtime.json'));
    assert.deepEqual(Array.from(call.options.stdio), ['ignore', 'pipe', 'pipe', 'ipc']);
  }
  assert.deepEqual(harness.processes[0].killSignals, ['SIGKILL']);
  assert.equal(harness.logs.length, 1);
  assert.equal(harness.logs[0].closeCalls, 0);
  assert.equal(harness.logs[0].completeCalls, 1);
  assert.deepEqual(harness.logs[0].detached, [harness.processes[0]]);
  assert.match(harness.logs[0].options.initialMessage, /port 8123/);
  const retryMessages = harness.logs[0].writes.filter(message => message.includes('Server starting'));
  assert.equal(retryMessages.length, 1);
  assert.match(retryMessages[0], /port 8124/);
  assert.match(harness.logs[0].writes[0], /Server exited/);
  const state = harness.context.serverState();
  assert.equal(state.apiPort, 8124);
  assert.equal(state.serverProcess, harness.processes[1]);
  assert.equal(state.serverReady, true);
});

test('repeated collisions exhaust the bounded retries without leaving failed children or logs', async () => {
  const harness = createHarness({
    ports: [8123, 8124, 8125],
    outcomes: ['collision', 'collision', 'collision']
  });

  await assert.rejects(harness.context.callStartServer(), error => {
    assert.equal(error.code, 'EADDRINUSE');
    assert.equal(error.apiPort, 8125);
    return true;
  });

  assert.equal(harness.spawnCalls.length, 3);
  assert.deepEqual(harness.excludedPortSnapshots, [[], [8123], [8123, 8124]]);
  assert.deepEqual(harness.processes.map(proc => proc.killSignals), [
    ['SIGKILL'], ['SIGKILL'], ['SIGKILL']
  ]);
  assert.equal(harness.logs.length, 1);
  assert.equal(harness.logs[0].closeCalls, 1);
  assert.deepEqual(harness.logs[0].detached, harness.processes);
  assert.match(harness.logs[0].options.initialMessage, /port 8123/);
  assert.deepEqual(
    harness.logs[0].writes
      .filter(message => message.includes('Server starting'))
      .map(message => /port (\d+)/.exec(message)?.[1]),
    ['8124', '8125']
  );
  const state = harness.context.serverState();
  assert.equal(state.apiPort, 8125);
  assert.equal(state.serverProcess, null);
  assert.equal(state.serverReady, false);
});

test('an unkillable collided child stays tracked and prevents a parallel retry', async () => {
  const harness = createHarness({
    ports: [8123, 8124],
    outcomes: ['collision', 'ready'],
    killResults: [false],
    terminate: proc => terminateServerStartupProcess(proc, 10)
  });

  await assert.rejects(harness.context.callStartServer(), error => {
    assert.equal(error.code, 'EADDRINUSE');
    assert.equal(error.apiPort, 8123);
    return true;
  });

  assert.equal(harness.spawnCalls.length, 1);
  assert.deepEqual(harness.processes[0].killSignals, ['SIGKILL']);
  assert.equal(harness.logs[0].closeCalls, 1);
  const state = harness.context.serverState();
  assert.equal(state.apiPort, 8123);
  assert.equal(state.serverProcess, harness.processes[0]);
  assert.equal(state.serverReady, false);
});

test('an unscoped EADDRINUSE failure is cleaned up without retrying the API port', async () => {
  const harness = createHarness({
    ports: [8123, 8124],
    outcomes: ['unscoped-collision', 'ready']
  });

  await assert.rejects(harness.context.callStartServer(), error => {
    assert.equal(error.code, 'EADDRINUSE');
    assert.equal(error.apiPort, undefined);
    return true;
  });

  assert.equal(harness.spawnCalls.length, 1);
  assert.deepEqual(harness.processes[0].killSignals, ['SIGKILL']);
  assert.equal(harness.logs[0].closeCalls, 1);
  const state = harness.context.serverState();
  assert.equal(state.serverProcess, null);
  assert.equal(state.serverReady, false);
});
