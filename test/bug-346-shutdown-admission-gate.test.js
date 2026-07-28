import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';
import {
  INTERCEPTOR_MANAGER_CLOSING_ERROR_CODE,
  INTERCEPTOR_MANAGER_CLOSING_ERROR_MESSAGE,
  InterceptorManager
} from '../src/interceptors/interceptor-manager.js';

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createManager(interceptors, { register = false } = {}) {
  const manager = Object.create(InterceptorManager.prototype);
  manager.interceptors = new Map();
  manager.operationsInProgress = new Map();
  manager.statusOperations = new Map();
  manager.closing = false;
  manager.onStatusChange = null;
  for (const interceptor of interceptors) {
    if (register) manager._register(interceptor);
    else manager.interceptors.set(interceptor.id, interceptor);
  }
  return manager;
}

function statefulInterceptor(id, { active = false, cleanupPending = false } = {}) {
  return {
    id,
    name: `Test ${id}`,
    active,
    cleanupPending,
    isActivable: async () => true,
    async isActive() { return this.active; },
    async needsDeactivation() { return this.active || this.cleanupPending; },
    toJSON() {
      return {
        id: this.id,
        name: this.name,
        active: this.active,
        cleanupPending: this.cleanupPending
      };
    },
    async activate() {
      this.active = true;
      return { success: true };
    },
    async deactivate() {
      this.active = false;
      this.cleanupPending = false;
    },
    async openUrl(url) { return { success: true, url }; },
    async focus() { return { focused: true }; }
  };
}

function assertClosingError(error) {
  assert.equal(error.code, INTERCEPTOR_MANAGER_CLOSING_ERROR_CODE);
  assert.equal(error.message, INTERCEPTOR_MANAGER_CLOSING_ERROR_MESSAGE);
  return true;
}

test('shutdown rejects activation for an interceptor whose cleanup turn has passed', async () => {
  const first = statefulInterceptor('first', { active: true });
  const second = statefulInterceptor('second', { active: true });
  const secondStarted = deferred();
  const releaseSecond = deferred();
  let firstCleanups = 0;
  let firstActivations = 0;
  first.deactivate = async () => {
    firstCleanups += 1;
    first.active = false;
  };
  first.activate = async () => {
    firstActivations += 1;
    first.active = true;
    return { success: true };
  };
  second.deactivate = async () => {
    secondStarted.resolve();
    await releaseSecond.promise;
    second.active = false;
  };
  const manager = createManager([first, second]);

  const shutdown = manager.deactivateAll();
  await secondStarted.promise;

  assert.equal(manager.closing, true);
  assert.equal(firstCleanups, 1);
  await assert.rejects(manager.activate('first', 8080), assertClosingError);
  assert.equal(firstActivations, 0);

  releaseSecond.resolve();
  await shutdown;

  assert.equal(first.active, false);
  assert.equal(second.active, false);
  assert.equal(manager.operationsInProgress.size, 0);
});

test('an operation admitted before closing is drained and its resulting ownership is cleaned', async () => {
  const interceptor = statefulInterceptor('electron');
  const activationStarted = deferred();
  const releaseActivation = deferred();
  const events = [];
  let cleanupCalls = 0;
  interceptor.activate = async () => {
    activationStarted.resolve();
    await releaseActivation.promise;
    interceptor.active = true;
    interceptor.onStatusChange({ ...interceptor.toJSON(), reason: 'active' });
    return { success: true };
  };
  interceptor.deactivate = async () => {
    cleanupCalls += 1;
    interceptor.active = false;
    interceptor.onStatusChange({ ...interceptor.toJSON(), reason: 'inactive' });
  };
  const manager = createManager([interceptor], { register: true });
  manager.onStatusChange = event => events.push(event);

  const activation = manager.activate('electron', 8080);
  await activationStarted.promise;
  const shutdown = manager.deactivateAll();

  assert.equal(manager.closing, true);
  assert.equal(cleanupCalls, 0);
  releaseActivation.resolve();
  await activation;
  await shutdown;

  assert.equal(cleanupCalls, 1);
  assert.equal(interceptor.active, false);
  assert.deepEqual(events.map(event => [event.active, event.reason]), [
    [true, 'active'],
    [false, 'inactive']
  ]);
});

test('closing rejects every external operation before interceptor lookup or busy checks', async () => {
  const manager = Object.create(InterceptorManager.prototype);
  manager.closing = true;
  manager.operationsInProgress = new Map([['unknown', Promise.resolve()]]);
  manager.interceptors = {
    get() {
      assert.fail('closing admission must fail before interceptor lookup');
    }
  };

  for (const operation of [
    manager.activate('unknown', 8080),
    manager.deactivate('unknown'),
    manager.openUrl('unknown', 8080, 'https://example.com'),
    manager.focus('unknown')
  ]) {
    await assert.rejects(operation, assertClosingError);
  }
});

test('exclusive admission checks closing before busy while shutdown bypass retains exclusivity', async () => {
  const interceptor = statefulInterceptor('known');
  const manager = createManager([interceptor]);
  manager.beginShutdown();
  manager.operationsInProgress.set('known', Promise.resolve());

  await assert.rejects(
    manager._runExclusive('known', interceptor, () => assert.fail('must not run')),
    assertClosingError
  );
  await assert.rejects(
    manager._runExclusive(
      'known',
      interceptor,
      () => assert.fail('busy shutdown operation must not run'),
      { allowWhileClosing: true }
    ),
    error => error.code === 'INTERCEPTOR_OPERATION_IN_PROGRESS'
  );

  manager.operationsInProgress.clear();
  let internalRuns = 0;
  await manager._runExclusive(
    'known',
    interceptor,
    async () => { internalRuns += 1; },
    { allowWhileClosing: true }
  );
  assert.equal(internalRuns, 1);
});

test('closing keeps interceptor metadata readable', async () => {
  const interceptor = statefulInterceptor('readable', { active: true });
  const manager = createManager([interceptor]);
  manager.beginShutdown();
  manager.beginShutdown();

  assert.equal(manager.closing, true);
  assert.deepEqual(await manager.getAll(), [{
    id: 'readable',
    name: 'Test readable',
    active: true,
    cleanupPending: false,
    activable: true
  }]);
});

test('shutdown uses its internal Stop admission for cleanup-only ownership', async () => {
  const interceptor = statefulInterceptor('cleanup-only', { cleanupPending: true });
  let cleanupCalls = 0;
  interceptor.deactivate = async () => {
    cleanupCalls += 1;
    interceptor.cleanupPending = false;
  };
  const manager = createManager([interceptor]);

  await manager.deactivateAll();
  await manager.deactivateAll();

  assert.equal(manager.closing, true);
  assert.equal(cleanupCalls, 1);
  assert.equal(interceptor.cleanupPending, false);
});

test('repeated shutdown retries failures without reopening or duplicating successful status', async t => {
  t.mock.method(console, 'error', () => {});
  const interceptor = statefulInterceptor('retry', { active: true });
  const events = [];
  let attempts = 0;
  interceptor.deactivate = async () => {
    attempts += 1;
    if (attempts === 1) {
      interceptor.onStatusChange({ ...interceptor.toJSON(), reason: 'stop-failed' });
      throw new Error('cleanup failed');
    }
    interceptor.active = false;
    interceptor.onStatusChange({ ...interceptor.toJSON(), reason: 'inactive' });
  };
  const manager = createManager([interceptor], { register: true });
  manager.onStatusChange = event => events.push(event);

  await manager.deactivateAll();
  assert.equal(interceptor.active, true);
  assert.equal(manager.closing, true);

  await manager.deactivateAll();
  await manager.deactivateAll();

  assert.equal(attempts, 2);
  assert.equal(interceptor.active, false);
  assert.equal(manager.closing, true);
  assert.deepEqual(events.map(event => [event.active, event.reason]), [
    [true, 'stop-failed'],
    [false, 'inactive']
  ]);
  await assert.rejects(manager.deactivate('retry'), assertClosingError);
});

function requestJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ url: 'https://example.com' });
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

test('all interceptor operation routes map closing to 503, busy to 409, and ordinary Open errors to 400', async t => {
  let operationError;
  const interceptors = {
    onStatusChange: null,
    getAll: async () => [],
    activate: async () => { throw operationError; },
    deactivate: async () => { throw operationError; },
    focus: async () => { throw operationError; },
    openUrl: async () => { throw operationError; }
  };
  const proxy = {
    port: 8080,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, interceptors);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const routes = [
    '/api/interceptors/test/activate',
    '/api/interceptors/test/deactivate',
    '/api/interceptors/test/focus',
    '/api/interceptors/test/open'
  ];

  operationError = new Error(INTERCEPTOR_MANAGER_CLOSING_ERROR_MESSAGE);
  operationError.code = INTERCEPTOR_MANAGER_CLOSING_ERROR_CODE;
  for (const route of routes) {
    const response = await requestJson(port, route);
    assert.equal(response.statusCode, 503, route);
    assert.equal(response.body.error, INTERCEPTOR_MANAGER_CLOSING_ERROR_MESSAGE, route);
  }

  operationError = new Error('operation already in progress');
  operationError.code = 'INTERCEPTOR_OPERATION_IN_PROGRESS';
  for (const route of routes) {
    assert.equal((await requestJson(port, route)).statusCode, 409, route);
  }

  operationError = new Error('invalid browser URL');
  const ordinaryOpen = await requestJson(port, '/api/interceptors/test/open');
  assert.equal(ordinaryOpen.statusCode, 400);
  assert.equal(ordinaryOpen.body.error, 'invalid browser URL');
});

test('application closes interceptor admissions at the first synchronous shutdown step', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'index.js'), 'utf8');
  const shutdownStart = source.indexOf('const shutdown = (exitCode = 0) => {');
  const shutdownEnd = source.indexOf('api.setShutdownHandler(shutdown)', shutdownStart);
  const shutdownSource = source.slice(shutdownStart, shutdownEnd);
  const promiseStart = shutdownSource.indexOf('shutdownPromise = (async () => {');
  const beginShutdown = shutdownSource.indexOf('interceptors.beginShutdown()', promiseStart);
  const firstAwait = shutdownSource.indexOf('await ', promiseStart);

  assert.ok(promiseStart >= 0);
  assert.ok(beginShutdown > promiseStart);
  assert.ok(beginShutdown < firstAwait);
});
