import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../../../src/api/api-server.js';
import { InterceptorManager } from '../../../src/interceptors/interceptor-manager.js';

function createManager(interceptors) {
  const manager = Object.create(InterceptorManager.prototype);
  manager.interceptors = new Map();
  manager.operationsInProgress = new Map();
  manager.statusOperations = new Map();
  manager.onStatusChange = null;
  for (const interceptor of interceptors) manager._register(interceptor);
  return manager;
}

function statefulInterceptor(id, { emitsStatus = false } = {}) {
  return {
    id,
    name: `Test ${id}`,
    type: id,
    active: false,
    isActivable: async () => true,
    async isActive() { return this.active; },
    toJSON() {
      return { id: this.id, name: this.name, type: this.type, active: this.active };
    },
    async activate() {
      this.active = true;
      if (emitsStatus) {
        this.onStatusChange({ ...this.toJSON(), reason: 'active' });
      }
      return { success: true };
    },
    async deactivate() {
      this.active = false;
      if (emitsStatus) {
        this.onStatusChange({ ...this.toJSON(), reason: 'exited' });
        this.onStatusChange({ ...this.toJSON(), reason: 'inactive' });
      }
    }
  };
}

function requestJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 2 }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end('{}');
  });
}

test('manager broadcasts callback-free interceptor state transitions', async () => {
  const ids = ['android-adb', 'jvm', 'system-proxy', 'docker'];
  const interceptors = ids.map(id => statefulInterceptor(id));
  const manager = createManager(interceptors);
  const events = [];
  manager.onStatusChange = event => events.push(event);

  for (const id of ids) {
    await manager.activate(id, 8080);
    await manager.deactivate(id);
  }

  assert.deepEqual(
    events.map(event => [event.id, event.active, event.reason]),
    ids.flatMap(id => [[id, true, 'active'], [id, false, 'inactive']])
  );
});

test('manager coalesces lifecycle callbacks from browser, Electron, and terminal interceptors', async () => {
  const ids = ['chrome', 'existing-chrome', 'electron', 'fresh-terminal'];
  const interceptors = ids.map(id => statefulInterceptor(id, { emitsStatus: true }));
  const manager = createManager(interceptors);
  const events = [];
  manager.onStatusChange = event => events.push(event);

  for (const id of ids) {
    await manager.activate(id, 8080);
    await manager.deactivate(id);
  }

  assert.deepEqual(
    events.map(event => [event.id, event.active, event.reason]),
    ids.flatMap(id => [[id, true, 'active'], [id, false, 'inactive']])
  );
});

test('manager ignores metadata, no-op, partial aggregate, and failed successful transitions', async () => {
  const metadataIds = ['android-adb', 'jvm', 'docker', 'electron', 'existing-terminal'];
  const metadataInterceptors = metadataIds.map(id => ({
    ...statefulInterceptor(id),
    async activate() {
      return { success: true, metadata: { selectionOrInstructionsRequired: true } };
    }
  }));
  let targets = 0;
  const aggregate = {
    ...statefulInterceptor('aggregate'),
    async isActive() { return targets > 0; },
    async activate() { targets++; return { success: true }; },
    async deactivate() { if (targets > 0) targets--; }
  };
  const failed = {
    ...statefulInterceptor('failed'),
    async activate() {
      this.active = true;
      this.onStatusChange({ ...this.toJSON() });
      return { success: false, error: 'activation failed' };
    }
  };
  const manager = createManager([...metadataInterceptors, aggregate, failed]);
  const events = [];
  manager.onStatusChange = event => events.push(event);

  for (const id of metadataIds) await manager.activate(id, 8080);
  await manager.deactivate('existing-terminal');
  await manager.activate('aggregate', 8080);
  await manager.activate('aggregate', 8080);
  await manager.deactivate('aggregate');
  await manager.deactivate('aggregate');
  await manager.activate('failed', 8080);

  assert.deepEqual(events.map(event => [event.id, event.active]), [
    ['aggregate', true],
    ['aggregate', false]
  ]);
});

test('manager preserves failure diagnostics without reporting a successful transition', async () => {
  const interceptor = statefulInterceptor('electron');
  interceptor.active = true;
  interceptor.deactivate = async function deactivate() {
    this.onStatusChange({ ...this.toJSON(), reason: 'stop-failed', error: 'still running' });
    throw new Error('Stop can be retried');
  };
  const manager = createManager([interceptor]);
  const events = [];
  manager.onStatusChange = event => events.push(event);

  await assert.rejects(manager.deactivate('electron'), /Stop can be retried/);

  assert.deepEqual(events.map(event => [event.active, event.reason]), [
    [true, 'stop-failed']
  ]);
});

test('API status channel broadcasts manager-synthesized transitions', async t => {
  const interceptor = statefulInterceptor('system-proxy');
  const manager = createManager([interceptor]);
  const proxy = { port: 8080, mockRules: [] };
  const api = new ApiServer(proxy, null, manager);
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);
  const server = http.createServer(api.app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  assert.equal(
    (await requestJson(port, '/api/interceptors/system-proxy/activate')).statusCode,
    200
  );
  assert.equal(
    (await requestJson(port, '/api/interceptors/system-proxy/deactivate')).statusCode,
    200
  );

  assert.deepEqual(broadcasts, [
    {
      type: 'interceptor-status',
      data: {
        id: 'system-proxy',
        name: 'Test system-proxy',
        type: 'system-proxy',
        active: true,
        reason: 'active'
      }
    },
    {
      type: 'interceptor-status',
      data: {
        id: 'system-proxy',
        name: 'Test system-proxy',
        type: 'system-proxy',
        active: false,
        reason: 'inactive'
      }
    }
  ]);
});
