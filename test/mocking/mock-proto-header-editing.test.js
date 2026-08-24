import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function sourceSection(startMarker, endMarker) {
  const start = rendererSource.indexOf(startMarker);
  const end = rendererSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} section must be present`);
  return rendererSource.slice(start, end);
}

const fixedAndWebhookSource = sourceSection(
  'function updateMockRespHeader(',
  'function mockRuleDraftComparable('
);
const headerEditorHelpersSource = sourceSection(
  'function mockHeaderEditorRows(',
  'function updateMockRespHeader('
);
const transformSource = sourceSection(
  'function _getTransformHeadersProp(',
  'function rerenderMockActionConfig('
);
const createMockSource = sourceSection(
  'function copyResponseHeadersForMock(',
  '// --- Header context menu'
);

function ownProtoHeaders(value, extraName = 'X-Remove', extraValue = 'remove me') {
  return JSON.parse(
    `{"__proto__":${JSON.stringify(value)},${JSON.stringify(extraName)}:${JSON.stringify(extraValue)}}`
  );
}

function assertSafeProtoHeader(headers, expected) {
  assert.equal(Object.getPrototypeOf(headers), null);
  assert.equal(Object.hasOwn(headers, '__proto__'), true);
  assert.equal(headers.__proto__, expected);
}

function createEditorHarness(action) {
  const context = {
    __draft: { action },
    document: { getElementById: () => null }
  };
  vm.createContext(context);
  vm.runInContext(`
    let mockEditDraft = globalThis.__draft;
    ${headerEditorHelpersSource}
    ${fixedAndWebhookSource}
    ${transformSource}
    globalThis.editorApi = {
      updateMockRespHeader,
      removeMockRespHeader,
      updateMockWebhookHeader,
      removeMockWebhookHeader,
      updateMockTransformHeader,
      removeMockTransformHeader,
      getDraft: () => mockEditDraft
    };
  `, context);
  return context.editorApi;
}

test('fixed-response header edits and removals preserve an own __proto__ field', () => {
  const api = createEditorHarness({
    headers: { 'X-Rename': 'fixed value', 'X-Remove': 'remove me' }
  });

  api.updateMockRespHeader(0, 'key', '__proto__', 'fixed');
  assertSafeProtoHeader(api.getDraft().action.headers, 'fixed value');

  api.updateMockRespHeader(0, 'val', 'fixed updated', 'fixed');
  api.removeMockRespHeader(1, 'fixed');

  const headers = api.getDraft().action.headers;
  assertSafeProtoHeader(headers, 'fixed updated');
  assert.equal(Object.hasOwn(headers, 'X-Remove'), false);
});

test('webhook header edits and removals preserve an imported __proto__ field', () => {
  const api = createEditorHarness({ webhookHeaders: ownProtoHeaders('webhook value') });

  api.updateMockWebhookHeader(0, 'val', 'webhook updated', 'webhook');
  api.removeMockWebhookHeader(1, 'webhook');

  const headers = api.getDraft().action.webhookHeaders;
  assertSafeProtoHeader(headers, 'webhook updated');
  assert.equal(Object.hasOwn(headers, 'X-Remove'), false);
});

test('request and response transform edits preserve an imported __proto__ field', () => {
  const api = createEditorHarness({
    headers: ownProtoHeaders('request value'),
    resHeaders: ownProtoHeaders('response value')
  });

  for (const [kind, prop, updated] of [
    ['req', 'headers', 'request updated'],
    ['res', 'resHeaders', 'response updated']
  ]) {
    api.updateMockTransformHeader(kind, 0, 'val', updated, kind);
    api.removeMockTransformHeader(kind, 1, kind);
    const headers = api.getDraft().action[prop];
    assertSafeProtoHeader(headers, updated);
    assert.equal(Object.hasOwn(headers, 'X-Remove'), false);
  }
});

test('Create Mock captures __proto__ as an own response header', async () => {
  let submission;
  const request = {
    id: 'exchange-1',
    method: 'GET',
    host: 'mock.test',
    path: '/proto',
    responseHeaders: ownProtoHeaders('captured value', 'Content-Length', '999'),
    responseBody: 'mocked',
    statusCode: 200
  };
  request.responseHeaders['X-Ordinary'] = 'preserved';
  const context = {
    API_BASE: '',
    document: { querySelector: () => null },
    editMockRule: () => {},
    fetch: async (_url, options) => {
      submission = JSON.parse(options.body);
      return { ok: true, json: async () => ({ rule: {} }) };
    },
    loadMockRules: async () => {},
    requests: [request],
    setTimeout: () => {},
    switchPanel: () => {},
    trafficActionRequest: requestId => context.requests.find(candidate => candidate.id === requestId),
    toast: () => {},
    mockSaveInProgress: false,
    mockRevertInProgress: false,
    mockResetInProgress: false,
    mockCollectionMutationCount: 0,
    _queueMockCollectionMutation: mutation => mutation()
  };
  vm.createContext(context);
  vm.runInContext(`
    ${createMockSource}
    globalThis.copyResponseHeadersForMock = copyResponseHeadersForMock;
    globalThis.createMockFromRequest = createMockFromRequest;
  `, context);

  const copied = context.copyResponseHeadersForMock(request.responseHeaders);
  assertSafeProtoHeader(copied, 'captured value');
  assert.equal(Object.hasOwn(copied, 'Content-Length'), false);
  assert.equal(copied['X-Ordinary'], 'preserved');

  await context.createMockFromRequest('exchange-1');

  assert.equal(Object.hasOwn(submission.action.headers, '__proto__'), true);
  assert.equal(submission.action.headers.__proto__, 'captured value');
  assert.equal(submission.action.headers['X-Ordinary'], 'preserved');
  assert.equal(Object.hasOwn(submission.action.headers, 'Content-Length'), false);
});
