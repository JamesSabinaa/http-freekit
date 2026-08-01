import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';

function createApiServer() {
  return new ApiServer({
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  }, null, null);
}

test('a completion cannot restore a pending request removed by Clear Traffic', () => {
  const api = createApiServer();
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);

  api.onTrafficEvent({ id: 'slow', _pending: true, method: 'GET' });
  api._clearTraffic();
  api.onTrafficEvent({ id: 'slow', _update: true, method: 'GET', statusCode: 200 });

  assert.deepEqual(api.trafficLog, []);
  assert.deepEqual(broadcasts.map(message => message.type), ['request', 'traffic-cleared']);
});

test('a missing completion is still retained when its pending row was only evicted', () => {
  const api = createApiServer();
  api.maxTrafficLog = 1;

  api.onTrafficEvent({ id: 'slow', _pending: true });
  api.onTrafficEvent({ id: 'newer' });
  api.onTrafficEvent({ id: 'slow', _update: true, statusCode: 200 });

  assert.deepEqual(api.trafficLog, [{ id: 'slow', statusCode: 200 }]);
});
