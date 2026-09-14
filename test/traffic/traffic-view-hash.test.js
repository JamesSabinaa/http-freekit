import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must be present`);
  return source.slice(start, end);
}

const hashHelpers = extract('function buildTrafficViewHash', '// ============ WEBSOCKET FRAMES STATE');
const identityHelpers = extract('function normalizeTrafficLifecycleId', 'function mergeServerTrafficRequest');
const wsMessageHandler = extract('function handleWsMessage', '// ============ TRAFFIC ============');
const rowSelection = extract('function updateTrafficActiveDescendant', 'function selectBreakpointRequest');
const keyboardSelection = extract('function selectRequestByIndex', '// ============ WS FRAME EXPAND/COLLAPSE');
const hashNavigation = extract('function navigateFromHash', "window.addEventListener('hashchange'");

const opaqueIds = [
  'ordinary-id-123',
  'id with space',
  '100% complete',
  'parent/child',
  'section#part',
  'café-雪-😀',
  'already%2Fencoded'
];

function evaluate(script, context = {}) {
  vm.createContext(context);
  vm.runInContext(script, context);
  return context;
}

test('traffic view hash helpers round-trip opaque IDs exactly once', () => {
  const context = evaluate(`${hashHelpers}
    globalThis.hashApi = {
      build: buildTrafficViewHash,
      parse: parseTrafficViewIdentityHash
    };
  `);

  for (const id of opaqueIds) {
    const hash = context.hashApi.build(id);
    assert.equal(hash, `#/view/${encodeURIComponent(id)}`);
    assert.equal(context.hashApi.parse(hash)?.requestId, id);
  }

  assert.equal(context.hashApi.build('already%2Fencoded'), '#/view/already%252Fencoded');
  assert.equal(context.hashApi.parse('#/view/already%252Fencoded')?.requestId, 'already%2Fencoded');
  const lifecycleHash = context.hashApi.build('duplicate/id', 'life 2/%');
  assert.equal(
    lifecycleHash,
    '#/view/duplicate%2Fid?trafficLifecycleId=life%202%2F%25'
  );
  assert.equal(context.hashApi.parse(lifecycleHash)?.requestId, 'duplicate/id');
  assert.equal(context.hashApi.parse(lifecycleHash)?.trafficLifecycleId, 'life 2/%');
});

test('malformed percent escapes fail parsing without throwing', () => {
  const context = evaluate(`${hashHelpers}
    globalThis.parseHash = parseTrafficViewIdentityHash;
  `);

  for (const hash of ['#/view/%', '#/view/%2', '#/view/%GG', '#/traffic', '#/view/']) {
    assert.doesNotThrow(() => context.parseHash(hash));
    assert.equal(context.parseHash(hash), null);
  }
});

function createSelectionHarness(id) {
  const request = { id };
  const historyCalls = [];
  const location = { hash: '#/traffic' };
  const context = {
    requests: [request],
    filteredRequests: [request],
    selectedRequestId: null,
    selectedRequestLifecycleId: null,
    vsForceRender: false,
    window: { location },
    history: {
      replaceState(state, title, hash) {
        historyCalls.push({ state, title, hash });
        location.hash = hash;
      }
    },
    document: { getElementById: () => null },
    renderVirtualRows() {},
    scrollRowIntoView() {},
    showDetail() {},
    currentTrafficGenerationRequest: candidate => candidate,
    closeDetail() {}
  };
  evaluate([
    hashHelpers,
    identityHelpers,
    rowSelection,
    keyboardSelection,
    `globalThis.selectionApi = {
      row(id) { selectRequest(id); },
      keyboard() { selectRequestByIndex('first'); }
    };`
  ].join('\n'), context);
  return { context, historyCalls };
}

test('row and keyboard selection encode every opaque request ID', () => {
  for (const id of opaqueIds) {
    const rowHarness = createSelectionHarness(id);
    rowHarness.context.selectionApi.row(id);
    assert.equal(rowHarness.historyCalls.at(-1)?.hash, `#/view/${encodeURIComponent(id)}`);

    const keyboardHarness = createSelectionHarness(id);
    keyboardHarness.context.selectionApi.keyboard();
    assert.equal(keyboardHarness.historyCalls.at(-1)?.hash, `#/view/${encodeURIComponent(id)}`);
  }
});

function createWsReaderHarness(hash, id, preload = true) {
  const selected = [];
  const timeouts = [];
  const noop = () => {};
  const context = {
    window: { location: { hash } },
    document: { getElementById: () => null, querySelector: () => null },
    requests: preload ? [{ id }] : [],
    captureStateSessionId: null,
    config: {},
    ws: { send: noop },
    beginTrafficDumpSync: noop,
    applyCapturePausedState: () => false,
    applyTrafficServerSessionBoundary: noop,
    setTimeout(callback, delay) {
      timeouts.push(delay);
      callback();
    },
    selectRequest: (requestId, toggle) => selected.push({ requestId, toggle }),
    loadConfig: noop,
    loadUiSettings: noop,
    loadProtobufSchemas: noop,
    loadInterceptors: noop,
    loadMockRules: () => Promise.resolve(),
    ensureDefaultMockRules: noop,
    loadBreakpointRules: noop,
    loadUpstreamProxy: noop,
    loadBottingToolsProxyProviders: noop,
    loadAutoRotateProxyOnError: noop,
    loadTlsPassthrough: noop,
    loadClientCerts: noop,
    loadTrustedCAs: noop,
    loadHttpsWhitelist: noop,
    loadHttp2Config: noop,
    loadTlsFingerprint: noop,
    loadApiSpecs: noop,
    loadMcpStatus: noop
  };
  evaluate([
    hashHelpers,
    identityHelpers,
    wsMessageHandler,
    `globalThis.readInitialHash = () => handleWsMessage({ type: 'init', proxyPort: 8000, apiPort: 8001 });
     globalThis.pendingHashApi = {
       update: updatePendingTrafficViewFromHash,
       resolve: resolvePendingTrafficView
     };`
  ].join('\n'), context);
  return { context, selected, timeouts };
}

function createNavigationHarness(hash, id) {
  const selected = [];
  const activatedPanels = [];
  const trafficPanel = { classList: { add: name => activatedPanels.push(name) } };
  const sidebar = {};
  const context = {
    window: { location: { hash } },
    requests: [{ id }],
    document: {
      querySelector: selector => selector.includes('traffic') ? sidebar : null,
      querySelectorAll: () => [{ classList: { remove() {} } }],
      getElementById: elementId => elementId === 'panel-traffic' ? trafficPanel : null
    },
    setActiveSidebarTab: element => assert.equal(element, sidebar),
    setTimeout: callback => callback(),
    selectRequest: (requestId, toggle) => selected.push({ requestId, toggle })
  };
  evaluate([
    hashHelpers,
    identityHelpers,
    hashNavigation,
    'globalThis.navigate = navigateFromHash;'
  ].join('\n'), context);
  return { activatedPanels, context, selected };
}

test('both initial WebSocket and hash-route readers decode opaque IDs before lookup', () => {
  for (const id of opaqueIds) {
    const hash = `#/view/${encodeURIComponent(id)}`;
    const wsHarness = createWsReaderHarness(hash, id);
    wsHarness.context.readInitialHash();
    assert.deepEqual(wsHarness.selected, [{ requestId: id, toggle: false }]);
    assert.deepEqual(wsHarness.timeouts, []);

    const navigationHarness = createNavigationHarness(hash, id);
    navigationHarness.context.navigate();
    assert.deepEqual(navigationHarness.selected, [{ requestId: id, toggle: false }]);
    assert.deepEqual(navigationHarness.activatedPanels, ['active']);
  }
});

test('a deep link stays pending until delayed traffic arrives and cancels on hash change', () => {
  const delayed = createWsReaderHarness('#/view/delayed-id', 'delayed-id', false);
  delayed.context.readInitialHash();
  assert.deepEqual(delayed.selected, []);
  delayed.context.requests.push({ id: 'delayed-id' });
  assert.equal(delayed.context.pendingHashApi.resolve(), true);
  assert.deepEqual(delayed.selected, [{ requestId: 'delayed-id', toggle: false }]);

  const cancelled = createWsReaderHarness('#/view/cancelled-id', 'cancelled-id', false);
  cancelled.context.readInitialHash();
  cancelled.context.window.location.hash = '#/traffic';
  cancelled.context.pendingHashApi.update('#/traffic');
  cancelled.context.requests.push({ id: 'cancelled-id' });
  assert.equal(cancelled.context.pendingHashApi.resolve(), false);
  assert.deepEqual(cancelled.selected, []);
});

test('malformed view fragments still route to Traffic and never select', () => {
  const wsHarness = createWsReaderHarness('#/view/%GG', 'unrelated');
  assert.doesNotThrow(() => wsHarness.context.readInitialHash());
  assert.deepEqual(wsHarness.selected, []);
  assert.deepEqual(wsHarness.timeouts, []);

  const navigationHarness = createNavigationHarness('#/view/%GG', 'unrelated');
  assert.doesNotThrow(() => navigationHarness.context.navigate());
  assert.deepEqual(navigationHarness.selected, []);
  assert.deepEqual(navigationHarness.activatedPanels, ['active']);
});
