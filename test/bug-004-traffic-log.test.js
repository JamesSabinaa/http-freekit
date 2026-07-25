import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiServer } from '../src/api/api-server.js';

function createApiServer() {
  return new ApiServer({
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  }, null, null);
}

test('late traffic updates cannot grow the traffic log beyond its maximum', () => {
  const api = createApiServer();
  api.maxTrafficLog = 2;
  api.trafficLog = [{ id: 'oldest' }, { id: 'newer' }];

  api.onTrafficEvent({ id: 'late', _update: true });

  assert.deepEqual(api.trafficLog.map(request => request.id), ['newer', 'late']);
});
