import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

function createRestoreHarness(currentRequests, selectedRequestId) {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = source.indexOf('function mergeTrafficDumpPins(');
  const end = source.indexOf('function connectWebSocket()', start);
  assert.ok(start >= 0 && end > start, 'traffic dump restoration functions must be present');

  const detailPanel = {};
  const rendered = [];
  const pinStates = [];
  let filterCalls = 0;
  let closeCalls = 0;
  const context = {
    requests: currentRequests,
    requestCounter: currentRequests.length,
    selectedRequestId,
    applyFilter: () => { filterCalls++; },
    closeDetail: () => { closeCalls++; },
    showDetail: request => {
      detailPanel._request = request;
      pinStates.push(!!request.pinned);
      rendered.push(request);
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${source.slice(start, end)}
    globalThis.callRestoreTrafficDump = restoreTrafficDump;
  `, context);

  return {
    context,
    detailPanel,
    rendered,
    pinStates,
    get filterCalls() { return filterCalls; },
    get closeCalls() { return closeCalls; }
  };
}

test('traffic dump preserves pins by ID while replacing server-owned fields', () => {
  const harness = createRestoreHarness([
    { id: 'keep', method: 'GET', stale: 'remove-me', pinned: true },
    { id: 'unpinned', method: 'GET' },
    { id: 'removed-pin', pinned: true }
  ], 'keep');

  harness.context.callRestoreTrafficDump([
    { id: 'keep', method: 'POST', statusCode: 201, pinned: false },
    { id: 'unpinned', method: 'PATCH', pinned: true },
    { id: 'new', method: 'GET' }
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.requests)), [
    { id: 'keep', method: 'POST', statusCode: 201, pinned: true },
    { id: 'unpinned', method: 'PATCH' },
    { id: 'new', method: 'GET' }
  ]);
  assert.equal(harness.context.requestCounter, 3);
  assert.equal(harness.filterCalls, 1);
  assert.equal(harness.closeCalls, 0);
  assert.equal(harness.detailPanel._request, harness.context.requests[0]);
  assert.equal(harness.rendered[0], harness.context.requests[0]);
  assert.deepEqual(harness.pinStates, [true]);
});

test('traffic dump removes missing pinned requests and closes their selection', () => {
  const harness = createRestoreHarness([
    { id: 'removed-pin', method: 'GET', pinned: true }
  ], 'removed-pin');

  harness.context.callRestoreTrafficDump([{ id: 'server-only', method: 'GET' }]);

  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.requests)), [
    { id: 'server-only', method: 'GET' }
  ]);
  assert.equal(harness.filterCalls, 1);
  assert.equal(harness.closeCalls, 1);
  assert.equal(harness.detailPanel._request, undefined);
  assert.deepEqual(harness.rendered, []);
});
