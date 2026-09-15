import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createUpdateInstallPreparation } = require('../../electron/update-install-preparation.cjs');
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('canceling during cleanup waits for it before restoring the backend', async () => {
  const pending = deferred();
  const events = [];
  const preparation = createUpdateInstallPreparation({
    prepareRenderer: async () => true,
    shutdownServer: async () => { events.push('shutdown'); await pending.promise; return { cleanupComplete: true }; },
    restoreBackend: async () => { events.push('restore'); },
    setBusy: value => events.push(`busy:${value}`),
    onPrepared: value => events.push(`prepared:${value}`)
  });
  const first = preparation.prepare();
  const duplicate = preparation.prepare();
  await Promise.resolve();
  const recovery = preparation.recover();
  assert.equal(preparation.recover(), recovery);
  assert.equal(events.includes('restore'), false);
  pending.resolve();
  assert.equal(await first, true);
  assert.equal(await duplicate, true);
  await recovery;
  assert.equal(events.filter(event => event === 'shutdown').length, 1);
  assert.deepEqual(events.slice(-3), ['prepared:false', 'restore', 'busy:false']);
  assert.equal(preparation.busy, false);
});

test('backend recovery errors retain both failure causes and release the busy state', async () => {
  let busy = false;
  const preparation = createUpdateInstallPreparation({
    prepareRenderer: async () => true,
    shutdownServer: async () => { throw new Error('cleanup failed'); },
    restoreBackend: async () => { throw new Error('backend restart failed'); },
    setBusy: value => { busy = value; },
    onPrepared() {}
  });
  await assert.rejects(preparation.prepare(), /cleanup failed.*backend restart failed/);
  assert.equal(busy, false);
  assert.equal(preparation.busy, false);
  await assert.rejects(preparation.recover(), /backend restart failed/);
  assert.equal(preparation.busy, false);
});

test('main preflight preserves services on cleanup failure and reconnects a restarted backend', async () => {
  const source = fs.readFileSync('electron/main.cjs', 'utf8');
  const start = source.indexOf('const updateInstallPreparation =');
  const end = source.indexOf('function restoreWindowAfterFailedQuit(', start);
  assert.ok(start >= 0 && end > start);
  const events = [];
  let cleanupFails = true;
  const context = vm.createContext({
    console,
    createUpdateInstallPreparation,
    mainWindow: { isDestroyed: () => false,
      setEnabled: enabled => events.push(`enabled:${enabled}`),
      loadURL: async url => events.push(url) },
    prepareRendererForQuit: async () => true,
    serverProcess: {}, apiPort: 8000, authToken: 'test-token',
    quitCleanupPromise: null, quitCleanupComplete: false,
    updateInstallPrepared: false, updateInstallQuitStarted: false, isShuttingDown: false,
    shutdownServer: async () => {
      if (cleanupFails) throw new Error('restore proxy failed');
      context.serverProcess = null;
      return { cleanupComplete: true };
    },
    startServer: async () => { events.push('start'); context.serverProcess = {}; context.apiPort = 8001; },
    createWindow: () => assert.fail('surviving window must be retained'),
    dialog: { showErrorBox: () => assert.fail('unexpected recovery error') }
  });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.preparation = updateInstallPreparation;', context);
  await assert.rejects(context.prepareUpdateInstall(), /restore proxy failed/);
  assert.equal(context.updateInstallPrepared, false);
  assert.equal(context.isShuttingDown, false);
  assert.deepEqual(events, ['enabled:false', 'enabled:true']);
  cleanupFails = false;
  assert.equal(await context.prepareUpdateInstall(), true);
  assert.equal(context.updateInstallPrepared, true);
  assert.equal(context.isShuttingDown, true);
  await context.preparation.recover();
  assert.equal(context.updateInstallPrepared, false);
  assert.equal(context.isShuttingDown, false);
  assert.deepEqual(events.slice(-3), ['start', 'http://127.0.0.1:8001/?authToken=test-token', 'enabled:true']);
  context.quitCleanupPromise = Promise.resolve();
  assert.equal(await context.prepareUpdateInstall(), false);
});
