import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
const wsParentKeyStart = source.indexOf('function isWebSocketConnection(');
const wsParentKeyEnd = source.indexOf('// ============ VIRTUAL SCROLL STATE', wsParentKeyStart);
const restoreStart = source.indexOf('function trimTrafficRows(');
const restoreEnd = source.indexOf('const appliedTrafficClearIds', restoreStart);
const trafficStart = source.indexOf('function addRequest(');
const trafficEnd = source.indexOf('function parseFilters(', trafficStart);
assert.ok(restoreStart >= 0 && restoreEnd > restoreStart);
assert.ok(trafficStart >= 0 && trafficEnd > trafficStart);
assert.ok(wsParentKeyStart >= 0 && wsParentKeyEnd > wsParentKeyStart);

function request(id, extra = {}) {
  return { id, method: 'GET', ...extra };
}

function serverRows(count = 10_000) {
  return Array.from({ length: count }, (_, index) => request(`server-${index}`));
}

function createHarness(initialRequests = [], selectedRequestId = null) {
  let filterCalls = 0;
  const closeCalls = [];
  const shown = [];
  const context = {
    requests: structuredClone(initialRequests),
    filteredRequests: [],
    selectedRequestId,
    requestCounter: initialRequests.length,
    wsFramesByParent: Object.create(null),
    wsExpandedConnections: new Set(),
    sortField: null,
    sortDirection: 'desc',
    hideTunnelRequests: false,
    filterSafeFonts: false,
    document: {
      getElementById(id) {
        if (id === 'searchInput') return { value: '' };
        return null;
      }
    },
    closeDetail(renderSelection) {
      closeCalls.push(renderSelection);
      context.selectedRequestId = null;
    },
    showDetail(value) { shown.push(value); },
    renderTraffic() {
      filterCalls++;
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${source.slice(wsParentKeyStart, wsParentKeyEnd)}
    ${source.slice(restoreStart, restoreEnd)}
    ${source.slice(trafficStart, trafficEnd)}
    globalThis.restore = restoreTrafficDump;
    globalThis.add = addRequest;
    globalThis.ids = () => requests.map(value => value.id);
    globalThis.filteredIds = () => filteredRequests.map(value => value.id);
    globalThis.frameIndex = () => Object.fromEntries(
      Object.entries(wsFramesByParent).map(([parentId, frames]) => [
        parentId,
        frames.map(frame => frame.id)
      ])
    );
  `, context);

  return {
    context,
    closeCalls,
    shown,
    get filterCalls() { return filterCalls; }
  };
}

test('a full server dump plus one local pin remains exactly capped', () => {
  const pin = request('local-pin', { pinned: true, _rendererOnly: true });
  const harness = createHarness([pin]);

  harness.context.restore(serverRows());

  assert.equal(harness.context.requests.length, 10_000);
  assert.equal(harness.context.requests[0].id, 'server-1');
  assert.equal(harness.context.requests.at(-1).id, pin.id);
  assert.equal(harness.context.requestCounter, 10_000);
  assert.equal(harness.filterCalls, 1);
});

test('repeated reconnect dumps are stable and never duplicate local pins', () => {
  const pin = request('local-pin', { pinned: true, _rendererOnly: true });
  const dump = serverRows();
  const harness = createHarness([pin]);

  harness.context.restore(dump);
  const firstIds = Array.from(harness.context.ids());
  harness.context.restore(dump);

  assert.deepEqual(Array.from(harness.context.ids()), firstIds);
  assert.equal(harness.context.requests.filter(value => value.id === pin.id).length, 1);
  assert.equal(harness.context.requests.length, 10_000);
  assert.equal(harness.filterCalls, 2);
});

test('a dump deduplicates pre-existing local pins using their newest instances', () => {
  const pins = [
    request('pin-a', { pinned: true, _rendererOnly: true, version: 'old' }),
    request('pin-b', { pinned: true, _rendererOnly: true }),
    request('pin-a', { pinned: true, _rendererOnly: true, version: 'new' })
  ];
  const harness = createHarness(pins);

  harness.context.restore([]);

  assert.deepEqual(Array.from(harness.context.ids()), ['pin-b', 'pin-a']);
  assert.equal(harness.context.requests[1].version, 'new');
});

test('appended local pins survive by evicting the oldest combined server rows', () => {
  const pins = [
    request('pin-a', { pinned: true, _rendererOnly: true }),
    request('pin-b', { pinned: true, _rendererOnly: true })
  ];
  const harness = createHarness(pins);

  harness.context.restore(serverRows(9_999));

  assert.equal(harness.context.requests.length, 10_000);
  assert.equal(harness.context.requests[0].id, 'server-1');
  assert.deepEqual(Array.from(harness.context.ids()).slice(-2), ['pin-a', 'pin-b']);
});

test('renderer-only pins are capped when they alone exceed the limit', () => {
  const pins = Array.from({ length: 10_001 }, (_, index) =>
    request(`pin-${index}`, { pinned: true, _rendererOnly: true })
  );
  const harness = createHarness(pins);

  harness.context.restore([]);

  assert.equal(harness.context.requests.length, 10_000);
  assert.equal(harness.context.requests[0].id, 'pin-1');
  assert.equal(harness.context.requests.at(-1).id, 'pin-10000');
});

test('dump eviction closes selected detail before the capped filter render', () => {
  const pin = request('local-pin', { pinned: true, _rendererOnly: true });
  const harness = createHarness([pin], 'server-0');

  harness.context.restore(serverRows());

  assert.equal(harness.context.requests.some(value => value.id === 'server-0'), false);
  assert.equal(harness.context.selectedRequestId, null);
  assert.deepEqual(harness.closeCalls, [false]);
  assert.deepEqual(harness.shown, []);
  assert.equal(harness.filterCalls, 1);
});

test('adding to oversized state removes the full excess and rebuilds frame indexes', () => {
  const oversized = Array.from({ length: 10_005 }, (_, index) => request(`old-${index}`));
  oversized[0] = request('evicted-frame', { protocol: 'ws-frame', parentId: 'evicted-parent' });
  oversized[6] = request('kept-frame', { protocol: 'ws-frame', parentId: 'kept-parent' });
  const harness = createHarness(oversized, 'evicted-frame');
  const added = request('new-frame', { protocol: 'ws-frame', parentId: 'new-parent' });

  harness.context.add(added);

  assert.equal(harness.context.requests.length, 10_000);
  assert.equal(harness.context.requests[0].id, 'old-4');
  assert.equal(harness.context.requests.includes(added), false);
  assert.equal(added._index, 10_006);
  assert.equal(harness.context.requestCounter, 10_006);
  assert.equal(harness.context.selectedRequestId, null);
  assert.deepEqual(harness.closeCalls, [false]);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.frameIndex())), {});
  assert.equal(harness.context.filteredRequests.length, 10_000);
  assert.equal(harness.filterCalls, 1);
});

test('ordinary under-cap adds retain rows, selection, and frame indexing', () => {
  const existing = [request('selected'), request('other')];
  const harness = createHarness(existing, 'selected');
  const frame = request('frame', { protocol: 'ws-frame', parentId: 'socket' });

  harness.context.add(frame);

  assert.deepEqual(Array.from(harness.context.ids()), ['selected', 'other', 'frame']);
  assert.equal(harness.context.requestCounter, 3);
  assert.equal(frame._index, 3);
  assert.equal(harness.context.selectedRequestId, 'selected');
  assert.deepEqual(harness.closeCalls, []);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.frameIndex())), {
    socket: ['frame']
  });
  assert.deepEqual(Array.from(harness.context.filteredIds()), ['selected', 'other']);
  assert.equal(harness.filterCalls, 1);
});

test('a frame flood evicts old frames without removing its WebSocket parent', () => {
  const parent = request('socket', { protocol: 'ws', statusCode: 101 });
  const frames = Array.from({ length: 9_999 }, (_, index) => request(`frame-${index}`, {
    protocol: 'ws-frame',
    parentId: parent.id
  }));
  const harness = createHarness([parent, ...frames]);
  const newestFrame = request('frame-new', { protocol: 'ws-frame', parentId: parent.id });

  harness.context.add(newestFrame);

  assert.equal(harness.context.requests.length, 10_000);
  assert.equal(harness.context.requests[0].id, parent.id);
  assert.equal(harness.context.requests.some(request => request.id === 'frame-0'), false);
  assert.equal(harness.context.requests.at(-1), newestFrame);
  assert.equal(harness.context.filteredRequests.length, 1);
  assert.deepEqual(Array.from(harness.context.filteredIds()), [parent.id]);
  assert.equal(harness.context.frameIndex()[parent.id].length, 9_999);
});
