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

function exact() {
  return {
    id: 'large-import',
    trafficLifecycleId: 'life-1',
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
    togglePinRequest() {},
    deleteSelectedRequest() {},
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
    ${contextMenuSource}
    globalThis.setRequests = value => { requests = value; };
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

  await items.find(item => item.label === 'Copy URL').action();
  await items.find(item => item.label === 'Copy as cURL').action();

  assert.equal(harness.clipboard[0], exact().url);
  assert.deepEqual(JSON.parse(harness.clipboard[1]), {
    method: exact().method,
    url: exact().url,
    headers: exact().requestHeaders,
    body: exact().requestBody,
    encoding: 'utf8',
    decoded: true
  });
  assert.equal(harness.calls.length, 0);
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
