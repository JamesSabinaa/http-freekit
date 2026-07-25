import assert from 'node:assert/strict';
import test from 'node:test';

import { InterceptorManager } from '../src/interceptors/interceptor-manager.js';

function createManager(interceptor) {
  const manager = Object.create(InterceptorManager.prototype);
  manager.interceptors = new Map([[interceptor.id, interceptor]]);
  manager.operationsInProgress = new Map();
  return manager;
}

test('manager rejects overlapping activation requests for one interceptor', async () => {
  let finishActivation;
  const activation = new Promise(resolve => { finishActivation = resolve; });
  let activationCount = 0;
  const interceptor = {
    id: 'test',
    name: 'Test interceptor',
    isActivable: async () => true,
    activate: async () => {
      activationCount++;
      await activation;
      return { success: true };
    }
  };
  const manager = createManager(interceptor);

  const first = manager.activate('test', 8080);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    manager.activate('test', 8080),
    error => error.code === 'INTERCEPTOR_OPERATION_IN_PROGRESS'
  );
  assert.equal(activationCount, 1);
  finishActivation();
  await first;
  assert.equal(manager.operationsInProgress.size, 0);
});

test('manager blocks Stop while activation is still pending', async () => {
  let finishActivation;
  const activation = new Promise(resolve => { finishActivation = resolve; });
  let deactivateCount = 0;
  const interceptor = {
    id: 'test',
    name: 'Test interceptor',
    isActivable: async () => true,
    activate: () => activation,
    deactivate: async () => { deactivateCount++; }
  };
  const manager = createManager(interceptor);

  const first = manager.activate('test', 8080);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    manager.deactivate('test'),
    error => error.code === 'INTERCEPTOR_OPERATION_IN_PROGRESS'
  );
  assert.equal(deactivateCount, 0);
  finishActivation({ success: true });
  await first;
});
