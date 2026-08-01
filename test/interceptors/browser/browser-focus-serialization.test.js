import assert from 'node:assert/strict';
import test from 'node:test';

import { InterceptorManager } from '../../../src/interceptors/interceptor-manager.js';

function deferred() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}

function managerWith(...interceptors) {
  const manager = Object.create(InterceptorManager.prototype);
  manager.interceptors = new Map();
  manager.operationsInProgress = new Map();
  manager.statusOperations = new Map();
  manager.closing = false;
  manager._initializationPromise = Promise.resolve(false);
  for (const interceptor of interceptors) manager._register(interceptor);
  return manager;
}

function browser(id, overrides = {}) {
  return {
    id,
    name: id,
    active: true,
    async isActive() { return this.active; },
    async needsDeactivation() { return this.active; },
    async focus() { return { success: true }; },
    async deactivate() { this.active = false; },
    toJSON() { return { id: this.id, name: this.name, active: this.active }; },
    ...overrides
  };
}

function assertOperationInProgress(err) {
  assert.equal(err?.code, 'INTERCEPTOR_OPERATION_IN_PROGRESS');
  return true;
}

test('a held browser Focus excludes Stop for the same lifecycle but not another browser', async () => {
  const focusStarted = deferred();
  const releaseFocus = deferred();
  const chrome = browser('chrome', {
    async focus() {
      focusStarted.resolve();
      await releaseFocus.promise;
      return { success: true };
    }
  });
  const firefox = browser('firefox');
  const manager = managerWith(chrome, firefox);

  const focusing = manager.focus('chrome');
  await focusStarted.promise;

  await assert.rejects(manager.deactivate('chrome'), assertOperationInProgress);
  assert.deepEqual(await manager.focus('firefox'), { success: true });
  assert.equal(chrome.active, true);

  releaseFocus.resolve();
  assert.deepEqual(await focusing, { success: true });
  await manager.deactivate('chrome');
  assert.equal(chrome.active, false);
});

test('a held browser Stop excludes Focus until lifecycle cleanup completes', async () => {
  const stopStarted = deferred();
  const releaseStop = deferred();
  let focusCalls = 0;
  const chrome = browser('chrome', {
    async focus() {
      focusCalls += 1;
      return { success: true };
    },
    async deactivate() {
      stopStarted.resolve();
      await releaseStop.promise;
      this.active = false;
    }
  });
  const manager = managerWith(chrome);

  const stopping = manager.deactivate('chrome');
  await stopStarted.promise;

  await assert.rejects(manager.focus('chrome'), assertOperationInProgress);
  assert.equal(focusCalls, 0);

  releaseStop.resolve();
  await stopping;
  assert.equal(chrome.active, false);
});
