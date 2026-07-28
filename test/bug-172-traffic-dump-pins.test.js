import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function createRestoreHarness(currentRequests, selectedRequestId, selectedRequestLifecycleId = null) {
  const start = source.indexOf('function trimTrafficRows(');
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
    selectedRequestLifecycleId,
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

function createUpdateHarness(currentRequests, selectedRequestId, selectedRequestLifecycleId = null) {
  const start = source.indexOf('function trimTrafficRows(');
  const end = source.indexOf('// ============ TRAFFIC ============', start);
  assert.ok(start >= 0 && end > start, 'traffic update functions must be present');

  const detailPanel = {};
  const rendered = [];
  let filterCalls = 0;
  const context = {
    requests: currentRequests,
    selectedRequestId,
    selectedRequestLifecycleId,
    applyFilter: () => { filterCalls++; },
    document: {
      getElementById(id) {
        if (id === 'detailPanel') return detailPanel;
        return null;
      }
    },
    renderDetailCards: request => { rendered.push(request); }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${source.slice(start, end)}
    globalThis.callHandleWsMessage = handleWsMessage;
  `, context);

  return {
    context,
    detailPanel,
    rendered,
    get filterCalls() { return filterCalls; }
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

test('request updates preserve renderer pin membership and rebind selected details', () => {
  const harness = createUpdateHarness([
    { id: 'selected', method: 'GET', stale: 'remove-me', pinned: true },
    { id: 'unpinned', method: 'GET' }
  ], 'selected');

  harness.context.callHandleWsMessage({
    type: 'request-update',
    data: { id: 'selected', method: 'POST', statusCode: 201, pinned: false, _rendererOnly: true }
  });
  harness.context.callHandleWsMessage({
    type: 'request-update',
    data: { id: 'unpinned', method: 'PATCH', statusCode: 204, pinned: true }
  });

  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.requests)), [
    { id: 'selected', method: 'POST', statusCode: 201, pinned: true },
    { id: 'unpinned', method: 'PATCH', statusCode: 204 }
  ]);
  assert.equal(harness.filterCalls, 2);
  assert.equal(harness.detailPanel._request, harness.context.requests[0]);
  assert.equal(harness.rendered[0], harness.context.requests[0]);
});

test('request updates target the matching reused-ID lifecycle', () => {
  const oldRequest = {
    id: 'reused', trafficLifecycleId: 'old-lifecycle', path: '/old', statusCode: null
  };
  const currentRequest = {
    id: 'reused', trafficLifecycleId: 'current-lifecycle', path: '/current', statusCode: null
  };
  const harness = createUpdateHarness(
    [oldRequest, currentRequest],
    'reused',
    'current-lifecycle'
  );
  harness.detailPanel._request = currentRequest;

  harness.context.callHandleWsMessage({
    type: 'request-update',
    data: {
      id: 'reused', trafficLifecycleId: 'current-lifecycle',
      path: '/current', statusCode: 201
    }
  });
  harness.context.callHandleWsMessage({
    type: 'request-update',
    data: {
      id: 'reused', trafficLifecycleId: 'old-lifecycle',
      path: '/old', statusCode: 200
    }
  });

  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.requests)), [
    { id: 'reused', trafficLifecycleId: 'old-lifecycle', path: '/old', statusCode: 200 },
    { id: 'reused', trafficLifecycleId: 'current-lifecycle', path: '/current', statusCode: 201 }
  ]);
  assert.equal(harness.detailPanel._request, harness.context.requests[1]);
  assert.deepEqual(harness.rendered, [harness.context.requests[1]]);
  assert.equal(harness.filterCalls, 2);
});

test('traffic dump preserves duplicate-ID pins and selection by lifecycle', () => {
  const harness = createRestoreHarness([
    { id: 'reused', trafficLifecycleId: 'life-1', path: '/old-1', pinned: true },
    { id: 'reused', trafficLifecycleId: 'life-2', path: '/old-2' }
  ], 'reused', 'life-2');

  harness.context.callRestoreTrafficDump([
    { id: 'reused', trafficLifecycleId: 'life-1', path: '/new-1' },
    { id: 'reused', trafficLifecycleId: 'life-2', path: '/new-2' }
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.requests)), [
    { id: 'reused', trafficLifecycleId: 'life-1', path: '/new-1', pinned: true },
    { id: 'reused', trafficLifecycleId: 'life-2', path: '/new-2' }
  ]);
  assert.equal(harness.closeCalls, 0);
  assert.equal(harness.detailPanel._request, harness.context.requests[1]);
});

test('traffic dump retains pinned renderer-only records after authoritative server rows', () => {
  const harness = createRestoreHarness([
    { id: 'send', source: 'Send', _rendererOnly: true, pinned: true },
    { id: 'import', source: 'import', _rendererOnly: true, pinned: true },
    { id: 'local-unpinned', source: 'Send', _rendererOnly: true },
    { id: 'missing-server-pin', source: 'Chrome', pinned: true }
  ], 'import');

  harness.context.callRestoreTrafficDump([
    { id: 'server-b', method: 'POST', pinned: true, _rendererOnly: true },
    { id: 'server-a', method: 'GET' }
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.requests)), [
    { id: 'server-b', method: 'POST' },
    { id: 'server-a', method: 'GET' },
    { id: 'send', source: 'Send', _rendererOnly: true, pinned: true },
    { id: 'import', source: 'import', _rendererOnly: true, pinned: true }
  ]);
  assert.equal(harness.closeCalls, 0);
  assert.equal(harness.detailPanel._request, harness.context.requests[3]);
  assert.equal(harness.rendered[0], harness.context.requests[3]);
});
