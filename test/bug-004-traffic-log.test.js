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

test('traffic eviction removes WebSocket frames before their inspectable parent', () => {
  const api = createApiServer();
  api.maxTrafficLog = 3;
  api.trafficLog = [
    { id: 'socket', protocol: 'ws', statusCode: 101 },
    { id: 'frame-1', protocol: 'ws-frame', parentId: 'socket' },
    { id: 'frame-2', protocol: 'ws-frame', parentId: 'socket' }
  ];

  api.onTrafficEvent({
    id: 'frame-3',
    protocol: 'ws-frame',
    parentId: 'socket',
    timestamp: Date.now()
  });

  assert.deepEqual(api.trafficLog.map(request => request.id), [
    'socket',
    'frame-2',
    'frame-3'
  ]);

  api.maxTrafficLog = 1;
  api.onTrafficEvent({
    id: 'frame-4',
    protocol: 'ws-frame',
    parentId: 'socket',
    timestamp: Date.now()
  });
  assert.deepEqual(api.trafficLog.map(request => request.id), ['socket']);
});
