import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'index.html'), 'utf8');

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  assert.notEqual(end, -1, `${endMarker} must exist`);
  return source.slice(start, end);
}

const identityHelpers = extract('function normalizeTrafficLifecycleId', 'function mergeServerTrafficRequest');
const generationHelpers = extract(
  'let deferredTrafficGenerationTokens = new WeakMap();',
  'function mergeTrafficDumpPins('
);
const pinState = extract('function applyTrafficPinned', 'function applyTrafficDeleted');
const deletionState = extract('function applyTrafficDeleted', 'function connectWebSocket');
const targetActions = extract('function trafficActionRequest', 'function resendSelectedRequest');
const contextMenu = extract('function showTrafficContextMenu', 'function createMockFromRequest');
const breakpointAction = extract('function createBreakpointFromRequest', 'function toast(');

function createHarness() {
  const requests = [
    {
      id: 'A', trafficGeneration: '00000000-0000-4000-8000-00000000000a',
      method: 'POST', host: 'a.example', url: 'https://a.example/path', pinned: false
    },
    {
      id: 'B', trafficGeneration: '00000000-0000-4000-8000-00000000000b',
      method: 'GET', host: 'b.example', url: 'https://b.example/path', pinned: false
    }
  ];
  const state = {
    menuItems: [],
    detailId: null,
    closeCalls: 0,
    pinButton: {
      attributes: new Map(),
      setAttribute(name, value) { this.attributes.set(name, value); }
    },
    pinIcon: { style: { transform: 'unchanged' } },
    renderCalls: 0,
    filterCalls: 0,
    fetches: [],
    toasts: [],
    breakpointReloads: 0
  };
  const context = {
    __requests: requests,
    API_BASE: '',
    document: {
      getElementById: id => id === 'pinBtn'
        ? state.pinButton
        : id === 'pinBtnIcon'
        ? state.pinIcon
        : null
    },
    navigator: { clipboard: { writeText: async () => {} } },
    generateExportSnippet: () => '',
    resendSelectedRequest() {},
    createMockFromRequest() {},
    showContextMenu: (_x, _y, items) => { state.menuItems = items; },
    selectRequest: id => {
      vm.runInContext(`selectedRequestId = ${JSON.stringify(id)}`, context);
      state.detailId = id;
    },
    renderTraffic: () => { state.renderCalls++; },
    closeDetail: () => {
      state.closeCalls++;
      state.detailId = null;
      vm.runInContext('selectedRequestId = null', context);
    },
    applyFilter: () => { state.filterCalls++; },
    confirm: () => true,
    toast: (message, type) => state.toasts.push({ message, type }),
    fetch: async (url, options) => {
      state.fetches.push({ url, options });
      const pinMatch = url.match(/^\/api\/traffic\/([^/?]+)\/pin(?:\?|$)/);
      const trafficMatch = url.match(/^\/api\/traffic\/([^?]+)/);
      return {
        ok: true,
        status: 200,
        json: async () => pinMatch
          ? {
              success: true,
              requestId: decodeURIComponent(pinMatch[1]),
              trafficLifecycleId: null,
              trafficGeneration: options.headers['X-HTTP-FreeKit-Traffic-Generation'],
              pinned: JSON.parse(options.body).pinned,
              revision: state.fetches.length
            }
          : trafficMatch
          ? {
              success: true,
              requestId: decodeURIComponent(trafficMatch[1]),
              trafficLifecycleId: null,
              trafficGeneration: options.headers['X-HTTP-FreeKit-Traffic-Generation'],
              webSocketConnection: false,
              clearRevision: 0,
              removed: 1
            }
          : { success: true }
      };
    },
    loadBreakpointRules: () => { state.breakpointReloads++; },
    mockSaveInProgress: false,
    mockRevertInProgress: false,
    mockResetInProgress: false,
    mockCollectionMutationCount: 0,
    _queueMockCollectionMutation: mutation => mutation()
  };
  context.__invokeMenuAction = label => {
    const item = state.menuItems.find(candidate => candidate.label === label);
    assert.ok(item, `menu item ${label} must exist`);
    return item.action();
  };
  vm.createContext(context);
  vm.runInContext(`
    let requests = __requests;
    let selectedRequestId = null;
    let selectedRequestLifecycleId = null;
    let captureStateSessionId = 'session-a';
    let trafficConnectionEpoch = 0;
    let trafficDumpReady = true;
    let requestCounter = requests.length;
    const appliedTrafficPinRevisions = new Map();
    const restTrafficClearReplayBarriers = new Map();
    let latestTrafficClearRevision = 0;
    let latestTrafficPinSnapshotRevision = 0;
    let breakpointRulesLoadGeneration = 0;
    const wsExpandedConnections = new Set();
    function isWebSocketConnection(request) {
      return request?.protocol === 'ws' || request?.protocol === 'wss';
    }
    function wsConnectionKey(request) {
      return JSON.stringify(['lifecycle', request.id, request.trafficLifecycleId]);
    }
    function recordTrafficClearReplayPinOverride() { return false; }
    function tombstoneTrafficClearReplayIdentity() { return false; }
    ${identityHelpers}
    ${generationHelpers}
    ${pinState}
    ${deletionState}
    ${targetActions}
    ${contextMenu}
    ${breakpointAction}
    this.contextTargetApi = {
      open(requestId) {
        showTrafficContextMenu({ preventDefault() {}, clientX: 10, clientY: 20 }, requestId);
      },
      select(requestId) { selectedRequestId = requestId; },
      selected() { return selectedRequestId; },
      invoke(label) { return __invokeMenuAction(label); },
      requestIds() { return requests.map(request => request.id); },
      deleteDefault: deleteSelectedRequest,
      pinDefault: togglePinRequest,
      breakpointDefault: createBreakpointFromRequest
    };
  `, context);
  return { context, requests, state, api: context.contextTargetApi };
}

function actionAfterSelectionMoves(harness, label) {
  harness.api.open('A');
  assert.equal(harness.api.selected(), 'A');
  harness.api.select('B');
  harness.state.detailId = 'B';
  return harness.api.invoke(label);
}

test('pin control starts unpressed and exposes the Pin action', () => {
  const pinButton = html.match(/<button\b[^>]*\bid="pinBtn"[^>]*>/)?.[0];
  assert.ok(pinButton, '#pinBtn must exist');
  assert.match(pinButton, /\baria-pressed="false"/);
  assert.match(pinButton, /\baria-label="Pin this exchange"/);
  assert.match(pinButton, /\btitle="Pin this exchange"/);
});

test('context-menu breakpoint creation keeps targeting row A after selection moves to B', async () => {
  const harness = createHarness();

  actionAfterSelectionMoves(harness, 'Create breakpoint');
  await Promise.resolve();

  assert.equal(harness.api.selected(), 'B');
  assert.equal(harness.state.detailId, 'B');
  assert.equal(harness.state.fetches.length, 1);
  assert.equal(harness.state.fetches[0].url, '/api/breakpoints');
  assert.deepEqual(JSON.parse(harness.state.fetches[0].options.body), {
    matchers: [
      { type: 'method', value: 'POST' },
      { type: 'hostname', value: 'a.example' }
    ]
  });
});

test('context-menu pin toggles row A without changing selected row B or its detail icon', async () => {
  const harness = createHarness();

  await actionAfterSelectionMoves(harness, 'Pin exchange');

  assert.equal(harness.requests[0].pinned, true);
  assert.equal(harness.requests[1].pinned, false);
  assert.equal(harness.api.selected(), 'B');
  assert.equal(harness.state.detailId, 'B');
  assert.equal(harness.state.pinIcon.style.transform, 'unchanged');
  assert.equal(harness.state.renderCalls, 1);
});

test('context-menu delete removes row A without closing selected row B details', async () => {
  const harness = createHarness();

  await actionAfterSelectionMoves(harness, 'Delete exchange');

  assert.deepEqual(harness.api.requestIds(), ['B']);
  assert.equal(harness.api.selected(), 'B');
  assert.equal(harness.state.detailId, 'B');
  assert.equal(harness.state.closeCalls, 0);
  assert.equal(harness.state.filterCalls, 1);
});

test('default selected-row pin and delete behavior remains intact', async () => {
  const pinHarness = createHarness();
  pinHarness.api.select('A');
  pinHarness.state.detailId = 'A';
  await pinHarness.api.pinDefault();
  assert.equal(pinHarness.requests[0].pinned, true);
  assert.equal(pinHarness.state.pinIcon.style.transform, 'none');
  assert.equal(pinHarness.state.pinButton.attributes.get('aria-pressed'), 'true');
  assert.equal(pinHarness.state.pinButton.attributes.get('aria-label'), 'Unpin this exchange');
  assert.equal(pinHarness.state.pinButton.attributes.get('title'), 'Unpin this exchange');

  await pinHarness.api.pinDefault();
  assert.equal(pinHarness.requests[0].pinned, undefined);
  assert.equal(pinHarness.state.pinIcon.style.transform, 'rotate(45deg)');
  assert.equal(pinHarness.state.pinButton.attributes.get('aria-pressed'), 'false');
  assert.equal(pinHarness.state.pinButton.attributes.get('aria-label'), 'Pin this exchange');
  assert.equal(pinHarness.state.pinButton.attributes.get('title'), 'Pin this exchange');

  const deleteHarness = createHarness();
  deleteHarness.api.select('A');
  deleteHarness.state.detailId = 'A';
  await deleteHarness.api.deleteDefault();
  assert.deepEqual(deleteHarness.api.requestIds(), ['B']);
  assert.equal(deleteHarness.api.selected(), null);
  assert.equal(deleteHarness.state.detailId, null);
  assert.equal(deleteHarness.state.closeCalls, 1);
});
