import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { ApiServer } from '../../src/api/api-server.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = fs.readFileSync(path.join(repoRoot, 'src/ui/app.js'), 'utf8');
const dumpApplyStart = app.indexOf('function beginTrafficDumpSync(');
const dumpApplyEnd = app.indexOf('function recordTrafficClearReplayPinOverride(', dumpApplyStart);
assert.notEqual(dumpApplyStart, -1);
assert.notEqual(dumpApplyEnd, -1);

function createApiServer() {
  return new ApiServer({
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  }, null, null);
}

test('WebSocket initialization requests the existing traffic log', () => {
  assert.match(app, /case 'init':[\s\S]*?type: 'get-traffic',[\s\S]*?limit: msg\.trafficLimit/);
});

test('traffic dump returns all retained requests when initialized with the log limit', () => {
  const api = createApiServer();
  api.maxTrafficLog = 2;
  api.trafficLog = [{ id: 'older' }, { id: 'newer' }];
  let response;

  const client = {
    readyState: 1,
    bufferedAmount: 0,
    send(message, callback) {
      response = JSON.parse(message);
      callback();
    }
  };
  api.clients.add(client);
  api._handleWsMessage(client, {
    type: 'get-traffic',
    limit: api.maxTrafficLog
  });

  assert.equal(response.type, 'traffic-dump');
  assert.equal(response.sessionId, api.captureStateSessionId);
  assert.deepEqual(
    response.requests.map(({ trafficGeneration, ...request }) => request),
    api.trafficLog
  );
  assert.ok(response.requests.every((request, index) =>
    /^[0-9a-f-]{36}$/i.test(request.trafficGeneration) &&
    request.trafficGeneration === api._ensureTrafficGeneration(api.trafficLog[index])
  ));
  assert.ok(api.trafficLog.every(request =>
    !Object.hasOwn(request, 'trafficGeneration')
  ));
});

test('renderer assembles one session-bound traffic dump atomically and rejects stale chunks', () => {
  const restored = [];
  const context = { restored };
  vm.createContext(context);
  vm.runInContext(`
    let captureStateSessionId = 'session-a';
    let trafficConnectionEpoch = 0;
    let trafficDumpReady = false;
    const pendingTrafficDumpChunks = new Map();
    const appliedTrafficDumpIds = new Set();
    function restoreTrafficDump(requests) {
      restored.push(requests.map(request => ({ ...request })));
    }
    ${app.slice(dumpApplyStart, dumpApplyEnd)}
    globalThis.snapshot = () => ({
      trafficConnectionEpoch,
      trafficDumpReady,
      pending: pendingTrafficDumpChunks.size
    });
    globalThis.setSession = value => { captureStateSessionId = value; };
  `, context);

  context.beginTrafficDumpSync();
  assert.equal(context.applyTrafficDumpMessage({
    type: 'traffic-dump', sessionId: 'session-a', dumpId: 'dump-a',
    chunkIndex: 1, chunkCount: 2, requests: [{ id: 'second' }]
  }), false);
  assert.equal(context.applyTrafficDumpMessage({
    type: 'traffic-dump', sessionId: 'session-a', dumpId: 'dump-a',
    chunkIndex: 0, chunkCount: 2, requests: [{ id: 'first' }]
  }), false);
  assert.equal(context.applyTrafficDumpMessage({
    type: 'traffic-dump', sessionId: 'session-a', dumpId: 'dump-a',
    chunkIndex: 0, chunkCount: 2, requests: [{ id: 'duplicate' }]
  }), false);
  assert.equal(context.applyTrafficDumpMessage({
    type: 'traffic-dump', sessionId: 'session-a', dumpId: 'dump-a',
    chunkIndex: 1, chunkCount: 3, requests: [{ id: 'mixed' }]
  }), false);
  assert.equal(restored.length, 0);
  assert.equal(context.applyTrafficDumpMessage({
    type: 'traffic-dump', sessionId: 'session-a', dumpId: 'dump-a',
    chunkIndex: 1, chunkCount: 2, requests: [{ id: 'second' }]
  }), true);

  assert.deepEqual(JSON.parse(JSON.stringify(restored)), [
    [{ id: 'first' }, { id: 'second' }]
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.snapshot())), {
    trafficConnectionEpoch: 1,
    trafficDumpReady: true,
    pending: 0
  });
  assert.equal(context.applyTrafficDumpMessage({
    type: 'traffic-dump', sessionId: 'session-a', dumpId: 'dump-a',
    chunkIndex: 0, chunkCount: 2, requests: []
  }), false);

  context.beginTrafficDumpSync();
  context.setSession('session-b');
  assert.equal(context.applyTrafficDumpMessage({
    type: 'traffic-dump', sessionId: 'session-a', dumpId: 'stale',
    chunkIndex: 0, chunkCount: 1, requests: [{ id: 'stale' }]
  }), false);
  assert.equal(context.applyTrafficDumpMessage({
    type: 'traffic-dump', sessionId: 'session-b', dumpId: '',
    chunkIndex: 0, chunkCount: 1, requests: []
  }), false);
  assert.equal(restored.length, 1);
});
