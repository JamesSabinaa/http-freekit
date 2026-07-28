import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function functionSource(name, nextMarker) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, `${name} must be present`);
  return source.slice(start, end);
}

const addRequestSource = functionSource('addRequest', 'function isTunnelRequest');
const trimTrafficRowsSource = functionSource(
  'trimTrafficRows',
  'function mergeServerTrafficRequest'
);
const wsParentKeySource = functionSource(
  'wsConnectionKey',
  '// ============ VIRTUAL SCROLL STATE'
);
const activeDescendantSource = functionSource('updateTrafficActiveDescendant', 'function selectRequest');
const closeDetailSource = functionSource('closeDetail', '// ============ DETAIL FOOTER ACTIONS ============');

function createHarness(selectedIndex) {
  const requests = Array.from({ length: 10_000 }, (_, index) => ({
    id: `request-${index}`,
    method: 'GET'
  }));
  const selected = requests[selectedIndex];
  const attributes = new Map([['aria-activedescendant', `row-${selected.id}`]]);
  const elements = {
    detailPanel: { _request: selected },
    detailEmptyState: { style: { display: 'none' } },
    detailActive: { style: { display: 'flex' } },
    trafficGrid: {
      setAttribute(name, value) {
        attributes.set(name, value);
      },
      removeAttribute(name) {
        attributes.delete(name);
      }
    },
    trafficBody: { contains: () => false }
  };
  const location = { hash: `#/view/${selected.id}` };
  const historyCalls = [];
  let filterCalls = 0;
  let directVirtualRenders = 0;
  const context = {
    requests,
    selectedRequestId: selected.id,
    selectedRequestLifecycleId: null,
    requestCounter: requests.length,
    wsFramesByParent: {},
    vsForceRender: false,
    document: { getElementById: id => elements[id] || null },
    window: { location },
    history: {
      replaceState(state, title, hash) {
        historyCalls.push({ state, title, hash });
        location.hash = hash;
      }
    },
    applyFilter: () => { filterCalls++; },
    renderVirtualRows: () => { directVirtualRenders++; }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${wsParentKeySource}
    ${trimTrafficRowsSource}
    ${addRequestSource}
    ${activeDescendantSource}
    ${closeDetailSource}
    globalThis.callAddRequest = addRequest;
  `, context);

  return {
    context,
    selected,
    elements,
    attributes,
    historyCalls,
    get filterCalls() { return filterCalls; },
    get directVirtualRenders() { return directVirtualRenders; }
  };
}

test('capacity eviction closes an evicted selected request coherently', () => {
  const harness = createHarness(0);
  const added = { id: 'new-request', protocol: 'http', method: 'GET' };

  harness.context.callAddRequest(added);

  assert.equal(harness.context.requests.length, 10_000);
  assert.equal(harness.context.requests.some(request => request.id === harness.selected.id), false);
  assert.equal(harness.context.requests.at(-1), added);
  assert.equal(harness.context.selectedRequestId, null);
  assert.equal(harness.elements.detailPanel._request, null);
  assert.equal(harness.elements.detailEmptyState.style.display, 'flex');
  assert.equal(harness.elements.detailActive.style.display, 'none');
  assert.equal(harness.attributes.has('aria-activedescendant'), false);
  assert.equal(harness.context.window.location.hash, '#/view');
  assert.deepEqual(harness.historyCalls, [{ state: null, title: '', hash: '#/view' }]);
  assert.equal(harness.filterCalls, 1);
  assert.equal(harness.directVirtualRenders, 0);
  assert.equal(harness.context.wsFramesByParent['socket-1'], undefined);
});

test('capacity eviction keeps retained selected request details open', () => {
  const harness = createHarness(5_000);
  const frame = { id: 'new-frame', protocol: 'ws-frame', parentId: 'socket-1' };

  harness.context.callAddRequest(frame);

  assert.equal(harness.context.requests.length, 10_000);
  assert.equal(harness.context.requests[0].id, 'request-0');
  assert.equal(harness.context.requests.includes(frame), false);
  assert.equal(harness.context.requests.includes(harness.selected), true);
  assert.equal(harness.context.selectedRequestId, harness.selected.id);
  assert.equal(harness.elements.detailPanel._request, harness.selected);
  assert.equal(harness.elements.detailEmptyState.style.display, 'none');
  assert.equal(harness.elements.detailActive.style.display, 'flex');
  assert.equal(harness.attributes.get('aria-activedescendant'), `row-${harness.selected.id}`);
  assert.equal(harness.context.window.location.hash, `#/view/${harness.selected.id}`);
  assert.deepEqual(harness.historyCalls, []);
  assert.equal(harness.filterCalls, 1);
  assert.equal(harness.directVirtualRenders, 0);
  assert.equal(harness.context.wsFramesByParent['socket-1'], undefined);
});
