import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} source must be present`);
  return source.slice(start, end);
}

const identitySource = between(
  'function normalizeTrafficLifecycleId(',
  'function isSelectedTrafficRequest('
);
const mergeSource = between(
  'function mergeServerTrafficRequest(',
  'function mergeTrafficDumpPins('
);
const hydrationSource = between(
  'const deferredTrafficHydrations = new Map();',
  'function selectBreakpointRequest('
);
const actionResolverSource = between(
  'function trafficActionRequest(',
  'const trafficPinInFlight'
);
const resendWrapperSource = between(
  'function resendSelectedRequest(',
  'function resendResolvedRequest('
);
const mockWrapperSource = between(
  'function createMockFromRequest(',
  'function createMockFromResolvedRequest('
);
const breakpointWrapperSource = between(
  'function createBreakpointFromRequest(',
  'function createBreakpointFromResolvedRequest('
);
const pinMutationSource = between(
  'const trafficPinInFlight = new Set();',
  'function updatePinIcon('
);
const deleteMutationSource = between(
  'const trafficDeleteInFlight = new Set();',
  'function isCanonicalSendBase64('
);
const contextMenuSource = between(
  'function showTrafficContextMenu(',
  'function copyResponseHeadersForMock('
);

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function summary() {
  return {
    id: 'large-import',
    trafficLifecycleId: 'life-1',
    method: 'CUSTOM-METHOD-TRUNCATED',
    url: 'https://example.test/truncated',
    _deferredTrafficDetail: true
  };
}

function exact(lifecycleId = 'life-1') {
  return {
    id: 'large-import',
    trafficLifecycleId: lifecycleId,
    method: 'CUSTOM-METHOD-THAT-WAS-NOT-TRUNCATED',
    url: 'https://example.test/the/full/path?with=query',
    requestHeaders: {
      Authorization: 'Bearer exact',
      'Content-Encoding': 'gzip'
    },
    requestBody: 'sig=%2f&space=%20&tilde=~&literal=%41',
    requestBodyEncoding: 'utf8',
    requestBodyContentDecoded: true
  };
}

function createHarness(fetchImpl) {
  const calls = [];
  const toasts = [];
  const clipboard = [];
  let menuItems = [];
  const context = {
    API_BASE: '',
    Map,
    Object,
    Promise,
    encodeURIComponent,
    fetch: (...args) => {
      calls.push(args);
      return fetchImpl(...args);
    },
    applyFilter() {},
    showDetail() {},
    closeDetail() {},
    toast: (message, type) => toasts.push({ message, type }),
    navigator: {
      clipboard: {
        writeText: async value => { clipboard.push(value); }
      }
    },
    generateExportSnippet: request => JSON.stringify({
      method: request.method,
      url: request.url,
      headers: request.requestHeaders,
      body: request.requestBody,
      encoding: request.requestBodyEncoding,
      decoded: request.requestBodyContentDecoded
    }),
    contextMenuAnchorFor: () => ({ x: 10, y: 20 }),
    showContextMenu: (_x, _y, items) => { menuItems = items; },
    selectRequest() {},
    resendResolvedRequest: request => { context.resolved.push(['resend', structuredClone(request)]); },
    createMockFromResolvedRequest: request => { context.resolved.push(['mock', structuredClone(request)]); },
    createBreakpointFromResolvedRequest: request => { context.resolved.push(['breakpoint', structuredClone(request)]); },
    identityOnly: [],
    resolved: []
  };
  vm.createContext(context);
  vm.runInContext(`
    let requests = [${JSON.stringify(summary())}];
    let selectedRequestId = 'large-import';
    let selectedRequestLifecycleId = 'life-1';
    ${identitySource}
    ${mergeSource}
    function isSelectedTrafficRequest(request) {
      return trafficRequestMatchesIdentity(
        request,
        selectedRequestId,
        selectedRequestLifecycleId
      );
    }
    ${hydrationSource}
    ${actionResolverSource}
    ${resendWrapperSource}
    ${mockWrapperSource}
    ${breakpointWrapperSource}
    function togglePinRequest(requestId, trafficLifecycleId) {
      const request = trafficActionRequest(requestId, trafficLifecycleId);
      identityOnly.push(['pin', request?.id, request?.trafficLifecycleId]);
    }
    function deleteSelectedRequest(requestId, trafficLifecycleId) {
      const request = trafficActionRequest(requestId, trafficLifecycleId);
      identityOnly.push(['delete', request?.id, request?.trafficLifecycleId]);
    }
    ${contextMenuSource}
    globalThis.setRequests = value => { requests = value; };
    globalThis.promoteWithMerge = value => {
      const current = requests[0];
      const promoted = mergeDeferredTrafficRequest(current, value);
      requests = [promoted];
      if (selectedRequestId === current.id) {
        selectedRequestLifecycleId = normalizeTrafficLifecycleId(promoted.trafficLifecycleId);
      }
      return promoted;
    };
    globalThis.startHydration = index => resolveDeferredTrafficRequest(requests[index]);
    globalThis.setSelection = (requestId, lifecycleId) => {
      selectedRequestId = requestId;
      selectedRequestLifecycleId = lifecycleId;
    };
    globalThis.getRequests = () => requests;
  `, context);
  return {
    context,
    calls,
    toasts,
    clipboard,
    menuItems: () => menuItems
  };
}

function response(body, { ok = true, status = ok ? 200 : 500 } = {}) {
  return { ok, status, json: async () => body };
}

test('concurrent content actions hydrate once and use exact deferred traffic', async () => {
  const pending = deferred();
  const harness = createHarness(() => pending.promise);

  const actions = [
    // These default-identity calls are the same path used by Ctrl+R and Ctrl+M.
    harness.context.resendSelectedRequest(),
    harness.context.createMockFromRequest(),
    harness.context.createBreakpointFromRequest('large-import', 'life-1')
  ];
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.context.resolved, []);

  pending.resolve(response(exact()));
  await Promise.all(actions);

  assert.equal(harness.calls.length, 1);
  assert.deepEqual(
    harness.context.resolved.map(([action, request]) => [action, request.method, request.url]),
    [
      ['resend', exact().method, exact().url],
      ['mock', exact().method, exact().url],
      ['breakpoint', exact().method, exact().url]
    ]
  );
  assert.ok(harness.context.resolved.every(([, request]) =>
    request.requestBody === exact().requestBody &&
    request.requestHeaders.Authorization === 'Bearer exact' &&
    request.requestBodyContentDecoded === true
  ));
});

test('an open deferred context menu resolves the row again after replacement', async () => {
  const harness = createHarness(() => assert.fail('a replaced exact row must not refetch'));
  harness.context.setRequests([{ ...summary(), trafficLifecycleId: undefined }]);
  harness.context.showTrafficContextMenu({
    preventDefault() {},
    clientX: 1,
    clientY: 2
  }, 'large-import', null, '');
  const items = harness.menuItems();
  harness.context.setRequests([exact()]);
  harness.context.setSelection('large-import', 'life-1');

  await items.find(item => item.label === 'Copy URL').action();
  await items.find(item => item.label === 'Copy as cURL').action();
  items.find(item => item.label === 'Pin exchange').action();
  items.find(item => item.label === 'Delete exchange').action();

  assert.equal(harness.clipboard[0], exact().url);
  assert.deepEqual(JSON.parse(harness.clipboard[1]), {
    method: exact().method,
    url: exact().url,
    headers: exact().requestHeaders,
    body: exact().requestBody,
    encoding: 'utf8',
    decoded: true
  });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.context.identityOnly)), [
    ['pin', 'large-import', 'life-1'],
    ['delete', 'large-import', 'life-1']
  ]);
  assert.equal(harness.calls.length, 0);
});

test('explicit-null content actions never rebind to a newer lifecycle', async () => {
  const harness = createHarness(() => assert.fail('explicit null must fail before fetch'));
  harness.context.setRequests([exact()]);
  harness.context.setSelection('large-import', 'life-1');

  let acted = false;
  const result = await harness.context.withResolvedTrafficAction(
    'large-import',
    null,
    'copy URL',
    () => { acted = true; }
  );

  assert.equal(result, null);
  assert.equal(acted, false);
  assert.equal(harness.calls.length, 0);
  assert.match(harness.toasts.at(-1).message, /no longer available/i);
});

test('deferred actions fail closed on identity mismatch and stale deletion', async () => {
  const mismatched = createHarness(async () => response({ ...exact(), trafficLifecycleId: 'other' }));
  await mismatched.context.resendSelectedRequest('large-import', 'life-1');
  assert.deepEqual(mismatched.context.resolved, []);
  assert.match(mismatched.toasts.at(-1).message, /different exchange/i);

  const pending = deferred();
  const deleted = createHarness(() => pending.promise);
  const action = deleted.context.createMockFromRequest('large-import', 'life-1');
  deleted.context.setRequests([]);
  pending.resolve(response(exact()));
  await action;
  assert.deepEqual(deleted.context.resolved, []);
  assert.match(deleted.toasts.at(-1).message, /removed while loading/i);
});

test('pending omitted-lifecycle hydration follows only an authoritative Clear promotion', async () => {
  const pending = deferred();
  const harness = createHarness(() => pending.promise);
  harness.context.setRequests([{ ...summary(), trafficLifecycleId: undefined }]);
  delete harness.context.getRequests()[0].trafficLifecycleId;
  harness.context.setSelection('large-import', null);

  const action = harness.context.resendSelectedRequest();
  assert.equal(harness.calls.length, 1);
  harness.context.promoteWithMerge(exact());
  pending.resolve(response(exact()));
  await action;

  assert.deepEqual(harness.context.resolved.map(([name, request]) => [
    name,
    request.trafficLifecycleId,
    request.url
  ]), [['resend', 'life-1', exact().url]]);
  assert.deepEqual(harness.toasts, []);
});

test('omitted and explicit-null hydration cannot self-promote from an unqualified GET', async () => {
  const omitted = createHarness(async () => response(exact()));
  omitted.context.setRequests([{ ...summary(), trafficLifecycleId: undefined }]);
  delete omitted.context.getRequests()[0].trafficLifecycleId;
  omitted.context.setSelection('large-import', null);
  await omitted.context.resendSelectedRequest();
  assert.deepEqual(omitted.context.resolved, []);
  assert.match(omitted.toasts.at(-1).message, /identity changed/i);

  const explicitNull = createHarness(async () => response(exact()));
  explicitNull.context.setRequests([{ ...summary(), trafficLifecycleId: null }]);
  explicitNull.context.setSelection('large-import', null);
  await explicitNull.context.resendSelectedRequest();
  assert.deepEqual(explicitNull.context.resolved, []);
  assert.match(explicitNull.toasts.at(-1).message, /different exchange/i);
});

test('pending hydration rejects same-identity replacements without its generation token', async () => {
  const pending = deferred();
  const harness = createHarness(() => pending.promise);
  harness.context.setRequests([{ ...summary(), trafficLifecycleId: null }]);
  harness.context.setSelection('large-import', null);

  const action = harness.context.createMockFromRequest();
  harness.context.setRequests([{ ...summary(), trafficLifecycleId: null }]);
  pending.resolve(response({ ...exact(), trafficLifecycleId: null }));
  await action;

  assert.deepEqual(harness.context.resolved, []);
  assert.match(harness.toasts.at(-1).message, /removed while loading/i);
});

test('resolved actions reject a replacement queued before their continuation', async () => {
  const pending = deferred();
  const harness = createHarness(() => pending.promise);
  const hydration = harness.context.startHydration(0);
  const replacement = hydration.then(() => {
    harness.context.setRequests([{ ...exact(), method: 'REPLACEMENT' }]);
  });
  const action = harness.context.resendSelectedRequest();

  pending.resolve(response(exact()));
  await Promise.all([replacement, action]);

  assert.deepEqual(harness.context.resolved, []);
  assert.match(harness.toasts.at(-1).message, /unavailable/i);
});

test('moved-selection omitted closures cannot target a same-ID replacement', async () => {
  const harness = createHarness(() => assert.fail('lost closures must not fetch'));
  harness.context.setRequests([{ ...summary(), trafficLifecycleId: undefined }]);
  delete harness.context.getRequests()[0].trafficLifecycleId;
  harness.context.setSelection('large-import', null);
  harness.context.showTrafficContextMenu({
    preventDefault() {}, clientX: 1, clientY: 2
  }, 'large-import', null, '');
  const items = harness.menuItems();
  harness.context.setRequests([
    exact('life-2'),
    { id: 'other', trafficLifecycleId: 'other-life', method: 'GET', url: 'https://other.test' }
  ]);
  harness.context.setSelection('other', 'other-life');

  await Promise.all([
    items.find(item => item.label === 'Resend in Send tab').action(),
    items.find(item => item.label === 'Create mock rule').action(),
    items.find(item => item.label === 'Create breakpoint').action()
  ]);

  assert.deepEqual(harness.context.resolved, []);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.toasts.filter(entry => /no longer available/i.test(entry.message)).length, 3);
});

test('exact clipboard failures are observed and reported', async () => {
  const harness = createHarness(() => assert.fail('exact clipboard actions must not fetch'));
  harness.context.setRequests([exact()]);
  harness.context.setSelection('large-import', 'life-1');
  harness.context.navigator.clipboard.writeText = async () => {
    throw new Error('clipboard denied');
  };
  harness.context.showTrafficContextMenu({
    preventDefault() {}, clientX: 1, clientY: 2
  }, 'large-import', null, 'life-1');

  await harness.menuItems().find(item => item.label === 'Copy URL').action();

  assert.match(harness.toasts.at(-1).message, /cannot copy url: clipboard denied/i);
});

function createCompactMutationHarness(kind) {
  const detail = deferred();
  const calls = [];
  const applied = [];
  const toasts = [];
  const context = {
    API_BASE: '',
    Promise,
    Object,
    encodeURIComponent,
    confirm: () => true,
    applyFilter() {},
    showDetail() {},
    closeDetail() {},
    toast: (message, type) => toasts.push({ message, type }),
    applyTrafficPinned: (...args) => applied.push(['pin', ...args]),
    applyTrafficDeleted: (...args) => applied.push(['delete', ...args]),
    fetch: (url, options = {}) => {
      calls.push([url, options]);
      if (!options.method) return detail.promise;
      if (kind === 'pin') {
        return Promise.resolve(response({
          success: true,
          requestId: 'large-import',
          trafficLifecycleId: 'life-1',
          pinned: true,
          revision: 1
        }));
      }
      return Promise.resolve(response({
        success: true,
        requestId: 'large-import',
        trafficLifecycleId: 'life-1',
        webSocketConnection: false
      }));
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    let requests = [{
      id: 'large-import',
      method: 'GET',
      url: 'https://example.test/truncated',
      _deferredTrafficDetail: true
    }];
    let selectedRequestId = 'large-import';
    let selectedRequestLifecycleId = null;
    ${identitySource}
    ${mergeSource}
    function isSelectedTrafficRequest(request) {
      return trafficRequestMatchesIdentity(request, selectedRequestId, selectedRequestLifecycleId);
    }
    ${hydrationSource}
    ${actionResolverSource}
    ${pinMutationSource}
    ${deleteMutationSource}
    globalThis.promote = value => {
      requests = [mergeDeferredTrafficRequest(requests[0], value)];
      selectedRequestLifecycleId = normalizeTrafficLifecycleId(requests[0].trafficLifecycleId);
    };
    globalThis.replaceAndMoveSelection = () => {
      requests = [
        { id: 'large-import', trafficLifecycleId: 'life-2', method: 'GET' },
        { id: 'other', trafficLifecycleId: 'other-life', method: 'GET' }
      ];
      selectedRequestId = 'other';
      selectedRequestLifecycleId = 'other-life';
    };
  `, context);
  return { context, detail, calls, applied, toasts };
}

test('compact Pin hydrates once and mutates the promoted lifecycle exactly', async () => {
  const harness = createCompactMutationHarness('pin');
  const actions = [
    harness.context.togglePinRequest(),
    harness.context.togglePinRequest()
  ];
  assert.equal(harness.calls.length, 1);
  harness.context.promote(exact());
  harness.detail.resolve(response(exact()));
  await Promise.all(actions);

  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[1][0], '/api/traffic/large-import/pin?trafficLifecycleId=life-1');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.applied)), [
    ['pin', 'large-import', 'life-1', true, 1]
  ]);
});

test('compact Delete hydrates once and mutates the promoted lifecycle exactly', async () => {
  const harness = createCompactMutationHarness('delete');
  const actions = [
    harness.context.deleteSelectedRequest(),
    harness.context.deleteSelectedRequest()
  ];
  assert.equal(harness.calls.length, 1);
  harness.context.promote(exact());
  harness.detail.resolve(response(exact()));
  await Promise.all(actions);

  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[1][0], '/api/traffic/large-import?trafficLifecycleId=life-1');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.applied)), [
    ['delete', 'large-import', 'life-1', false]
  ]);
});

test('compact Pin and Delete closures fail closed after selection and generation replacement', async () => {
  for (const [kind, invoke] of [
    ['pin', context => context.togglePinRequest('large-import', undefined)],
    ['delete', context => context.deleteSelectedRequest('large-import', undefined)]
  ]) {
    const harness = createCompactMutationHarness(kind);
    harness.context.replaceAndMoveSelection();
    await invoke(harness.context);
    assert.equal(harness.calls.length, 0);
    assert.deepEqual(harness.applied, []);
  }
});
