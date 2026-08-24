import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must be present`);
  return source.slice(start, end);
}

const selectionDetailSource = extract(
  'let trafficDetailSelectionGeneration = 0;',
  'function resolveDeferredTrafficRequest('
);

function createHarness() {
  const first = { id: 'first', trafficLifecycleId: 'life-1', _deferredTrafficDetail: true };
  const second = { id: 'second', trafficLifecycleId: 'life-2', method: 'GET' };
  const requests = [first, second];
  const shown = [];
  const pending = new Map();
  const elements = {
    detailPanel: { _request: first },
    detailEmptyState: { style: { display: 'none' } },
    detailActive: { style: { display: 'flex' } }
  };
  const context = {
    requests,
    selectedRequestId: first.id,
    selectedRequestLifecycleId: first.trafficLifecycleId,
    document: { getElementById: id => elements[id] || null },
    normalizeTrafficLifecycleId: value => value ?? null,
    currentTrafficGenerationRequest: request => requests.includes(request) ? request : null,
    isSelectedTrafficRequest: request =>
      request.id === context.selectedRequestId &&
      (request.trafficLifecycleId ?? null) === context.selectedRequestLifecycleId,
    getSelectedTrafficRequest: () => requests.find(request =>
      request.id === context.selectedRequestId &&
      (request.trafficLifecycleId ?? null) === context.selectedRequestLifecycleId
    ) || null,
    trafficRequestMatchesIdentity: (request, id, lifecycleId) =>
      request.id === id && (request.trafficLifecycleId ?? null) === (lifecycleId ?? null),
    showDetail: request => shown.push(request),
    hydrateDeferredTrafficRequest(request) {
      return new Promise(resolve => pending.set(request.id, hydrated => {
        const index = requests.indexOf(request);
        if (index !== -1) requests[index] = hydrated;
        resolve(hydrated);
      }));
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${selectionDetailSource}
    globalThis.selectionDetailApi = {
      render: renderSelectedTrafficDetail,
      select(id, lifecycleId) {
        selectedRequestId = id;
        selectedRequestLifecycleId = lifecycleId;
      }
    };
  `, context);
  return { api: context.selectionDetailApi, first, second, requests, shown, pending, elements };
}

test('deferred hydration cannot replace details for a newer selection', async () => {
  const harness = createHarness();
  const firstRender = harness.api.render(harness.first);
  assert.equal(harness.elements.detailPanel._request, null);
  assert.equal(harness.elements.detailActive.style.display, 'none');

  harness.api.select(harness.second.id, harness.second.trafficLifecycleId);
  await harness.api.render(harness.second);
  assert.equal(harness.shown.at(-1), harness.second);

  harness.pending.get(harness.first.id)({
    id: harness.first.id,
    trafficLifecycleId: harness.first.trafficLifecycleId,
    method: 'GET'
  });
  await firstRender;

  assert.deepEqual(harness.shown, [harness.second]);
});

test('the current deferred selection renders only after exact hydration completes', async () => {
  const harness = createHarness();
  const render = harness.api.render(harness.first);
  const hydrated = {
    id: harness.first.id,
    trafficLifecycleId: harness.first.trafficLifecycleId,
    method: 'POST'
  };
  harness.pending.get(harness.first.id)(hydrated);
  assert.equal(await render, hydrated);
  assert.equal(harness.shown.at(-1), hydrated);
});

test('mouse, keyboard, hash, and dump restoration all route through guarded detail rendering', () => {
  const mouse = extract('function selectRequest(', 'const deferredTrafficHydrations');
  const keyboard = extract('function selectRequestByIndex(', '// ============ WS FRAME EXPAND/COLLAPSE');
  const dump = extract('function restoreTrafficDump(', 'const appliedTrafficClearIds');
  const hash = extract('function resolvePendingTrafficView(', '// ============ WEBSOCKET FRAMES STATE');

  assert.match(mouse, /renderSelectedTrafficDetail\(req\)/);
  assert.match(keyboard, /renderSelectedTrafficDetail\(req\)/);
  assert.match(dump, /renderSelectedTrafficDetail\(currentSelection\)/);
  assert.match(hash, /selectRequest\(/);
});
