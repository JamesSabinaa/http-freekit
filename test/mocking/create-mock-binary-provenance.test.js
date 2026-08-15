import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ProxyServer } from '../../src/proxy/proxy-server.js';
import { normalizeHarEntries } from '../../src/ui/har-import.js';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const createMockStart = rendererSource.indexOf('function copyResponseHeadersForMock(');
const createMockEnd = rendererSource.indexOf('// --- Header context menu', createMockStart);
assert.ok(createMockStart >= 0 && createMockEnd > createMockStart);
const createMockSource = rendererSource.slice(createMockStart, createMockEnd);

function baseCapture(overrides = {}) {
  return {
    id: 'capture-1',
    trafficLifecycleId: 'lifecycle-1',
    protocol: 'http',
    method: 'POST',
    url: 'http://mock-origin.example.test/api/items',
    host: 'mock-origin.example.test',
    path: '/api/items',
    requestHeaders: { 'content-type': 'text/plain' },
    requestBody: 'ordinary request',
    statusCode: 201,
    responseHeaders: { 'content-type': 'text/plain', 'x-captured': 'yes' },
    responseBody: 'ordinary response',
    ...overrides
  };
}

function normalizeNativeCapture({ binarySide, empty = false }) {
  const proxy = new ProxyServer(null);
  const binaryBytes = empty ? Buffer.alloc(0) : Buffer.from([0x00, 0x01, 0xfe, 0xff]);
  const capture = baseCapture({
    requestBody: binarySide === 'request'
      ? proxy._safeBodyString(binaryBytes, undefined, 'application/octet-stream')
      : proxy._safeBodyString(Buffer.from('ordinary request'), undefined, 'text/plain'),
    responseBody: binarySide === 'response'
      ? proxy._safeBodyString(binaryBytes, undefined, 'application/octet-stream')
      : proxy._safeBodyString(Buffer.from('ordinary response'), undefined, 'text/plain')
  });
  proxy._normalizeCapturedBodies(capture);
  return capture;
}

function normalizeHarCapture(binarySide, { empty = false } = {}) {
  const binaryText = empty ? '' : Buffer.from([0x00, 0x01, 0xfe, 0xff]).toString('base64');
  const entry = {
    startedDateTime: '2026-01-01T00:00:00.000Z',
    time: 4,
    request: {
      method: 'POST',
      url: 'http://mock-origin.example.test/api/items',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'Content-Type', value: 'text/plain' }],
      bodySize: binarySide === 'request' ? (empty ? 0 : 4) : 16,
      postData: binarySide === 'request'
        ? {
            mimeType: 'application/octet-stream',
            text: binaryText,
            encoding: 'base64'
          }
        : { mimeType: 'text/plain', text: 'ordinary request' }
    },
    response: {
      status: 201,
      statusText: 'Created',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'Content-Type', value: 'text/plain' }],
      bodySize: binarySide === 'response' ? (empty ? 0 : 4) : 17,
      content: binarySide === 'response'
        ? {
            mimeType: 'application/octet-stream',
            size: empty ? 0 : 4,
            text: binaryText,
            encoding: 'base64'
          }
        : { mimeType: 'text/plain', size: 17, text: 'ordinary response' }
    }
  };
  return normalizeHarEntries({ log: { version: '1.2', entries: [entry] } }, {
    createId: () => 'har-capture-1'
  })[0];
}

function createHarness(request) {
  const effects = {
    queueCalls: 0,
    fetches: [],
    loads: 0,
    navigations: 0,
    edits: 0,
    timers: 0,
    toasts: []
  };
  const collection = [{ id: 'existing-rule' }];
  const drafts = new Map([['existing-rule', { title: 'unchanged draft' }]]);
  let submission;
  const context = {
    API_BASE: '',
    document: {
      querySelector: () => ({ dataset: { panel: 'mock' } }),
      querySelectorAll: () => []
    },
    editMockRule: () => { effects.edits++; },
    fetch: async (url, options) => {
      effects.fetches.push({ url, options });
      submission = JSON.parse(options.body);
      return { ok: true, json: async () => ({ rule: { id: 'created-rule' } }) };
    },
    loadMockRules: async () => { effects.loads++; },
    mockCollectionMutationCount: 0,
    mockResetInProgress: false,
    mockRevertInProgress: false,
    mockSaveInProgress: false,
    selectedRequestId: request.id,
    setTimeout: callback => {
      effects.timers++;
      callback();
    },
    switchPanel: () => { effects.navigations++; },
    toast: (message, type) => effects.toasts.push({ message, type }),
    trafficActionRequest: (requestId, trafficLifecycleId) =>
      requestId === request.id &&
      (trafficLifecycleId === undefined || trafficLifecycleId === request.trafficLifecycleId)
        ? request
        : null,
    _queueMockCollectionMutation: mutation => {
      effects.queueCalls++;
      return mutation();
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${createMockSource}
    globalThis.createMockFromRequestForTest = createMockFromRequest;
  `, context);

  return {
    collection,
    context,
    drafts,
    effects,
    get submission() { return submission; },
    run: () => context.createMockFromRequestForTest(request.id, request.trafficLifecycleId)
  };
}

async function assertRejectedWithoutMutation(request, side, messagePattern = /binary or unsupported encoding/) {
  const beforeRequest = JSON.stringify(request);
  const harness = createHarness(request);
  const beforeCollection = structuredClone(harness.collection);
  const beforeDrafts = structuredClone(Array.from(harness.drafts.entries()));

  assert.equal(await harness.run(), undefined);
  assert.equal(harness.effects.queueCalls, 0);
  assert.deepEqual(harness.effects.fetches, []);
  assert.equal(harness.effects.loads, 0);
  assert.equal(harness.effects.navigations, 0);
  assert.equal(harness.effects.edits, 0);
  assert.equal(harness.effects.timers, 0);
  assert.equal(harness.submission, undefined);
  assert.equal(harness.context.selectedRequestId, request.id);
  assert.deepEqual(harness.collection, beforeCollection);
  assert.deepEqual(Array.from(harness.drafts.entries()), beforeDrafts);
  assert.equal(JSON.stringify(request), beforeRequest);
  assert.equal(harness.effects.toasts.length, 1);
  assert.equal(harness.effects.toasts[0].type, 'error');
  assert.match(harness.effects.toasts[0].message, new RegExp(`${side} body`));
  assert.match(harness.effects.toasts[0].message, messagePattern);
  assert.match(harness.effects.toasts[0].message, /Create a byte-aware rule manually instead/);
}

test('Create Mock rejects proxy-normalized binary request and response bodies independently', async () => {
  for (const side of ['request', 'response']) {
    const capture = normalizeNativeCapture({ binarySide: side });

    assert.equal(capture[`${side}BodyEncoding`], 'base64');
    assert.match(capture[`${side}Body`], /^data:application\/octet-stream;base64,/);
    assert.equal(capture[`${side === 'request' ? 'response' : 'request'}BodyEncoding`], 'utf8');
    await assertRejectedWithoutMutation(capture, side);
  }
});

test('Create Mock rejects renderer HAR base64 request and response provenance independently', async () => {
  for (const [side, options] of [['request', {}], ['response', { empty: true }]]) {
    const imported = normalizeHarCapture(side, options);

    assert.equal(imported[`${side}BodyEncoding`], 'base64');
    assert.match(imported[`${side}Body`], /^data:application\/octet-stream;base64,/);
    assert.equal(imported[`${side === 'request' ? 'response' : 'request'}BodyEncoding`], 'utf8');
    await assertRejectedWithoutMutation(imported, side);
  }
});

test('Create Mock rejects unsupported encoding metadata without inspecting the display string', async () => {
  const capture = baseCapture({
    requestBody: 'ordinary-looking text',
    requestBodyEncoding: 'hex',
    responseBodyEncoding: 'utf8'
  });

  await assertRejectedWithoutMutation(capture, 'request');
});

test('Create Mock keeps the incomplete-capture rejection distinct from binary provenance', async () => {
  const capture = normalizeNativeCapture({ binarySide: 'request' });
  capture.requestBodyTruncated = true;
  const harness = createHarness(capture);

  assert.equal(await harness.run(), undefined);
  assert.equal(harness.effects.queueCalls, 0);
  assert.deepEqual(harness.effects.fetches, []);
  assert.deepEqual(harness.effects.toasts, [{
    message: 'Cannot create a mock because this exchange contains an incomplete body capture.',
    type: 'error'
  }]);
});

async function assertTextDerivation(request, expectedBodyMatcher) {
  const harness = createHarness(request);

  await harness.run();
  assert.equal(harness.effects.queueCalls, 1);
  assert.equal(harness.effects.fetches.length, 1);
  assert.equal(harness.effects.fetches[0].url, '/api/mock-rules');
  assert.equal(harness.effects.loads, 1);
  assert.equal(harness.effects.navigations, 1);
  assert.equal(harness.effects.edits, 1);
  assert.deepEqual(harness.effects.toasts, [{
    message: 'Mock rule created from exchange',
    type: 'success'
  }]);

  const submission = harness.submission;
  const bodyMatchers = submission.matchers.filter(matcher =>
    matcher.type === 'json-body-includes' || matcher.type === 'body-contains'
  );
  assert.deepEqual(bodyMatchers, expectedBodyMatcher ? [expectedBodyMatcher] : []);
  assert.equal(submission.action.body, request.responseBody || '');
  assert.equal(submission._originalRequestBody, request.requestBody || '');
  assert.equal(submission._originalResponseBody, request.responseBody || '');

  const runtime = new ProxyServer(null);
  const stored = runtime.addMockRule(structuredClone(submission));
  assert.equal(
    runtime._findMockRule(request.method, request.url, request.requestHeaders, request.requestBody),
    stored
  );
  assert.equal(stored.action.body, request.responseBody || '');
}

test('Create Mock preserves zero-length, legacy, and explicit UTF-8 text derivation', async () => {
  const zeroLength = normalizeNativeCapture({ binarySide: 'request', empty: true });
  zeroLength.responseBody = '';
  zeroLength.responseBodyEncoding = 'utf8';
  assert.equal(zeroLength.requestBody, '');
  assert.equal(zeroLength.requestBodyEncoding, 'utf8');
  await assertTextDerivation(zeroLength, null);

  await assertTextDerivation(baseCapture({
    requestBody: '{"kind":"ordinary"}',
    requestBodyEncoding: 'utf8',
    responseBody: 'created',
    responseBodyEncoding: 'utf8'
  }), { type: 'json-body-includes', value: '{"kind":"ordinary"}' });

  const literalDataUri = 'data:application/octet-stream;base64,AAH+/w==';
  await assertTextDerivation(baseCapture({
    requestBody: literalDataUri,
    requestBodyEncoding: 'utf8',
    responseBody: literalDataUri,
    responseBodyEncoding: 'utf8'
  }), { type: 'body-contains', value: literalDataUri });

  const legacyPlaceholderText = '[Binary data: this is literal UTF-8 text]';
  await assertTextDerivation(baseCapture({
    requestBody: legacyPlaceholderText,
    responseBody: 'legacy response'
  }), { type: 'body-contains', value: legacyPlaceholderText });
});
