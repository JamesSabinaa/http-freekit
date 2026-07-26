import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { runMcpStdioHost } = require('../electron/mcp-stdio-host.cjs');
const repoRoot = process.cwd();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve));
}

test('MCP Electron host exits 1 without loading the bridge when its descriptor path is missing', async () => {
  const exits = [];
  const errors = [];
  let loadCalls = 0;

  const status = await runMcpStdioHost({
    descriptorPath: '',
    loadBridge: async () => { loadCalls += 1; },
    exit: code => { exits.push(code); },
    logError: (...args) => { errors.push(args); }
  });

  assert.equal(status, 1);
  assert.deepEqual(exits, [1]);
  assert.equal(loadCalls, 0);
  assert.deepEqual(errors, [['[MCP Bridge] Runtime descriptor path is required']]);
});

test('MCP Electron host exits 1 when bridge startup rejects', async () => {
  const exits = [];
  const errors = [];
  const startupError = new Error('SSE refused');

  const status = await runMcpStdioHost({
    descriptorPath: 'C:\\runtime.json',
    loadBridge: async () => ({
      startStdioBridge: async () => { throw startupError; }
    }),
    exit: code => { exits.push(code); },
    logError: (...args) => { errors.push(args); }
  });

  assert.equal(status, 1);
  assert.deepEqual(exits, [1]);
  assert.deepEqual(errors, [['[MCP Bridge] Could not connect:', 'SSE refused']]);
});

test('MCP Electron host waits for completed transport cleanup before normal exit', async () => {
  const cleanup = deferred();
  const exits = [];
  let cleanupFinished = false;
  let startupFinished = false;
  const closed = cleanup.promise.then(result => {
    cleanupFinished = true;
    return result;
  });

  const running = runMcpStdioHost({
    descriptorPath: 'C:\\runtime.json',
    loadBridge: async () => ({
      startStdioBridge: async () => {
        startupFinished = true;
        return { closed };
      }
    }),
    exit: code => {
      assert.equal(cleanupFinished, true);
      exits.push(code);
    }
  });
  await nextTurn();

  assert.equal(startupFinished, true);
  assert.deepEqual(exits, []);
  cleanup.resolve({ error: null, transports: [{ status: 'fulfilled' }, { status: 'fulfilled' }] });

  assert.equal(await running, 0);
  assert.deepEqual(exits, [0]);
});

test('MCP Electron host exits 1 after an error-driven bridge cleanup', async () => {
  const exits = [];
  const bridgeError = new Error('stdio failed');

  const status = await runMcpStdioHost({
    descriptorPath: 'C:\\runtime.json',
    loadBridge: async () => ({
      startStdioBridge: async () => ({
        closed: Promise.resolve({ error: bridgeError, transports: [] })
      })
    }),
    exit: code => { exits.push(code); }
  });

  assert.equal(status, 1);
  assert.deepEqual(exits, [1]);
});

test('MCP Electron host exits 1 when either transport fails to close', async () => {
  const exits = [];

  const status = await runMcpStdioHost({
    descriptorPath: 'C:\\runtime.json',
    loadBridge: async () => ({
      startStdioBridge: async () => ({
        closed: Promise.resolve({
          error: null,
          transports: [
            { status: 'fulfilled', value: undefined },
            { status: 'rejected', reason: new Error('stdio close failed') }
          ]
        })
      })
    }),
    exit: code => { exits.push(code); }
  });

  assert.equal(status, 1);
  assert.deepEqual(exits, [1]);
});

test('a thrown Electron exit callback is contained and never retried', async () => {
  const errors = [];
  let exitCalls = 0;

  const status = await runMcpStdioHost({
    descriptorPath: 'C:\\runtime.json',
    loadBridge: async () => ({
      startStdioBridge: async () => ({
        closed: Promise.resolve({ error: null, transports: [] })
      })
    }),
    exit: () => {
      exitCalls += 1;
      throw new Error('exit unavailable');
    },
    logError: (...args) => { errors.push(args); }
  });

  assert.equal(status, 0);
  assert.equal(exitCalls, 1);
  assert.deepEqual(errors, [['[MCP Bridge] Could not terminate host:', 'exit unavailable']]);
});

test('repeated bridge close requests still produce one Electron exit', async () => {
  const cleanup = deferred();
  const exits = [];
  let closePromise;
  const bridge = {
    closed: cleanup.promise,
    close(error = null) {
      if (!closePromise) {
        closePromise = this.closed;
        cleanup.resolve({ error, transports: [] });
      }
      return closePromise;
    }
  };

  const running = runMcpStdioHost({
    descriptorPath: 'C:\\runtime.json',
    loadBridge: async () => ({ startStdioBridge: async () => bridge }),
    exit: code => { exits.push(code); }
  });
  await nextTurn();

  assert.strictEqual(bridge.close(), bridge.close(new Error('duplicate close')));
  assert.equal(await running, 0);
  assert.deepEqual(exits, [0]);
});

function runBootstrap({ descriptorPath, electronRuntime }) {
  const source = fs.readFileSync(path.join(repoRoot, 'electron', 'bootstrap.cjs'), 'utf8');
  const calls = { electronExits: [], hostOptions: [], mainLoads: 0 };
  const localRequire = specifier => {
    if (specifier === 'url') return require('node:url');
    if (specifier === './mcp-launch.cjs') {
      return {
        findMcpStdioDescriptor: () => descriptorPath,
        resolveBundledMcpBridgeScript: () => 'C:\\bridge.js'
      };
    }
    if (specifier === './mcp-stdio-host.cjs') {
      return {
        runMcpStdioHost: options => { calls.hostOptions.push(options); }
      };
    }
    if (specifier === './main.cjs') {
      calls.mainLoads += 1;
      return {};
    }
    if (specifier === 'electron') {
      return { app: { exit: status => { calls.electronExits.push(status); } } };
    }
    throw new Error(`Unexpected bootstrap dependency: ${specifier}`);
  };

  vm.runInNewContext(source, {
    __dirname: path.join(repoRoot, 'electron'),
    console,
    process: { versions: electronRuntime ? { electron: '42.0.0' } : {} },
    require: localRequire
  }, { filename: 'electron/bootstrap.cjs' });
  return calls;
}

test('packaged bridge bootstrap delegates its one terminal status to Electron app.exit', () => {
  const calls = runBootstrap({ descriptorPath: '', electronRuntime: true });

  assert.equal(calls.mainLoads, 0);
  assert.equal(calls.hostOptions.length, 1);
  assert.equal(calls.hostOptions[0].descriptorPath, '');
  calls.hostOptions[0].exit(1);
  assert.deepEqual(calls.electronExits, [1]);
});

test('bootstrap without the MCP flag launches the ordinary Electron main module', () => {
  const calls = runBootstrap({ descriptorPath: null, electronRuntime: true });

  assert.equal(calls.mainLoads, 1);
  assert.equal(calls.hostOptions.length, 0);
  assert.deepEqual(calls.electronExits, []);
});
