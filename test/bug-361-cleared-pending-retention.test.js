import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';

function createApi(options = {}) {
  return new ApiServer({ matchApiSpec: () => null }, null, null, options);
}

function pending(id) {
  return { id, method: 'GET', path: '/', host: 'pending.test', _pending: true };
}

test('bounded tombstones suppress retained completions and surface evicted ones consistently', () => {
  let now = 1_000;
  const api = createApi({
    maxClearedPendingTrafficIds: 3,
    clearedPendingTrafficTtlMs: 60_000,
    clearedPendingTrafficNow: () => now
  });
  const broadcasts = [];
  api._broadcast = event => broadcasts.push(event);

  for (let index = 1; index <= 5; index++) {
    api.onTrafficEvent(pending(`pending-${index}`));
    api._clearTraffic();
    now++;
  }

  assert.deepEqual([...api._clearedPendingTrafficIds.keys()], [
    'pending-3',
    'pending-4',
    'pending-5'
  ]);
  broadcasts.length = 0;
  for (const id of ['pending-1', 'pending-5']) {
    api.onTrafficEvent({
      id,
      method: 'GET',
      path: '/',
      host: 'pending.test',
      statusCode: 200,
      _update: true
    });
  }
  assert.deepEqual(api.trafficLog.map(request => request.id), ['pending-1']);
  assert.deepEqual(broadcasts.map(event => event.type), ['request']);
  assert.equal(broadcasts[0].data.id, 'pending-1');
  assert.equal(api._clearedPendingTrafficIds.has('pending-5'), false);
});

test('abandoned cleared pending request tombstones expire', t => {
  let monotonicNow = 1_000;
  let wallNow = 5_000;
  t.mock.method(Date, 'now', () => wallNow);
  const api = createApi({
    maxClearedPendingTrafficIds: 10,
    clearedPendingTrafficTtlMs: 50,
    clearedPendingTrafficNow: () => monotonicNow
  });
  const broadcasts = [];
  api._broadcast = event => broadcasts.push(event);
  api.onTrafficEvent(pending('abandoned'));
  api._clearTraffic();
  assert.equal(api._clearedPendingTrafficIds.has('abandoned'), true);

  wallNow -= 1_000;
  monotonicNow += 50;
  api._pruneClearedPendingTrafficIds();
  assert.equal(api._clearedPendingTrafficIds.has('abandoned'), false);

  broadcasts.length = 0;
  api.onTrafficEvent({
    id: 'abandoned',
    method: 'GET',
    path: '/',
    host: 'pending.test',
    statusCode: 200,
    _update: true
  });
  assert.deepEqual(api.trafficLog.map(request => request.id), ['abandoned']);
  assert.deepEqual(broadcasts.map(event => event.type), ['request']);
  assert.equal(broadcasts[0].data.id, 'abandoned');
});
