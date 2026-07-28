import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';

function createApi(options = {}) {
  return new ApiServer({ matchApiSpec: () => null }, null, null, options);
}

function pending(id) {
  return { id, method: 'GET', path: '/', host: 'pending.test', _pending: true };
}

test('cleared pending request tombstones are bounded and still suppress completions', () => {
  const api = createApi({
    maxClearedPendingTrafficIds: 3,
    clearedPendingTrafficTtlMs: 60_000
  });
  api._broadcast = () => {};

  for (let index = 1; index <= 5; index++) {
    api.onTrafficEvent(pending(`pending-${index}`));
    api._clearTraffic();
  }

  assert.deepEqual([...api._clearedPendingTrafficIds.keys()], [
    'pending-3',
    'pending-4',
    'pending-5'
  ]);
  api.onTrafficEvent({
    id: 'pending-5',
    method: 'GET',
    path: '/',
    host: 'pending.test',
    statusCode: 200,
    _update: true
  });
  assert.equal(api.trafficLog.length, 0);
  assert.equal(api._clearedPendingTrafficIds.has('pending-5'), false);
});

test('abandoned cleared pending request tombstones expire', t => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const api = createApi({
    maxClearedPendingTrafficIds: 10,
    clearedPendingTrafficTtlMs: 50
  });
  api._broadcast = () => {};
  api.onTrafficEvent(pending('abandoned'));
  api._clearTraffic();
  assert.equal(api._clearedPendingTrafficIds.has('abandoned'), true);

  now += 51;
  api._pruneClearedPendingTrafficIds();
  assert.equal(api._clearedPendingTrafficIds.has('abandoned'), false);
});
