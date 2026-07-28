import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { trafficToHar } from '../src/api/har-converter.js';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = rendererSource.indexOf(startMarker);
  const end = rendererSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} source must be present`);
  return rendererSource.slice(start, end);
}

const harImportSource = sourceBetween(
  'function normalizeHarBodySize(',
  '// ============ ACTIONS ============'
);
const filterSource = sourceBetween(
  'function parseFilters(',
  'function showFilterHint('
);

function validEntry() {
  return {
    startedDateTime: '2026-01-01T00:00:00.000Z',
    time: 12.5,
    request: {
      method: 'GET',
      url: 'https://example.test/resource',
      headers: [],
      bodySize: 0
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: [],
      content: { text: '', size: 0 }
    }
  };
}

function har(entries) {
  return { log: { version: '1.2', entries } };
}

function createRendererHarness() {
  const added = [];
  const inputs = [];
  const toasts = [];
  let nextId = 0;
  const context = {
    URL,
    addRequest: request => added.push(request),
    crypto: { randomUUID: () => `renderer-har-${++nextId}` },
    document: {
      createElement: () => {
        const input = { click: () => {} };
        inputs.push(input);
        return input;
      }
    },
    toast: (message, type) => toasts.push({ message, type })
  };

  vm.createContext(context);
  vm.runInContext(`
    ${filterSource}
    ${harImportSource}
    globalThis.importHarForTest = importHar;
    globalThis.matchesRawFilterForTest = (request, raw) =>
      matchesAllFilters(request, parseFilters(raw));
  `, context);

  return {
    added,
    context,
    toasts,
    async importDocument(documentOrText) {
      context.importHarForTest();
      const input = inputs.at(-1);
      const text = typeof documentOrText === 'string'
        ? documentOrText
        : JSON.stringify(documentOrText);
      await input.onchange({
        target: { files: [{ text: async () => text }] }
      });
    }
  };
}

test('renderer HAR import rejects malformed primitives and unsafe mapped field types', async () => {
  const cases = [
    ['null entry', har([null]), /log\.entries\[0\] must be an object/],
    ['numeric entry', har([7]), /log\.entries\[0\] must be an object/],
    ['null request', (() => { const value = validEntry(); value.request = null; return har([value]); })(), /request must be an object/],
    ['array response', (() => { const value = validEntry(); value.response = []; return har([value]); })(), /response must be an object/],
    ['numeric method', (() => { const value = validEntry(); value.request.method = 1; return har([value]); })(), /request\.method must be a string/],
    ['object URL', (() => { const value = validEntry(); value.request.url = { unsafe: true }; return har([value]); })(), /request\.url must be a string/],
    ['numeric header name', (() => { const value = validEntry(); value.request.headers = [{ name: 1, value: 'ok' }]; return har([value]); })(), /headers\[0\]\.name must be a string/],
    ['object header value', (() => { const value = validEntry(); value.response.headers = [{ name: 'X-Test', value: {} }]; return har([value]); })(), /headers\[0\]\.value must be a string/],
    ['numeric request body', (() => { const value = validEntry(); value.request.postData = { text: 42 }; return har([value]); })(), /postData\.text must be a string/],
    ['object response body', (() => { const value = validEntry(); value.response.content.text = {}; return har([value]); })(), /content\.text must be a string/],
    ['negative timestamp', (() => { const value = validEntry(); value.startedDateTime = '1969-12-31T23:59:59.999Z'; return har([value]); })(), /startedDateTime must be non-negative/],
    ['negative duration', (() => { const value = validEntry(); value.time = -1; return har([value]); })(), /\.time must be non-negative/],
    ['negative request size', (() => { const value = validEntry(); value.request.bodySize = -2; return har([value]); })(), /request\.bodySize must be non-negative or -1/],
    ['fractional response size', (() => { const value = validEntry(); value.response.bodySize = 1.5; return har([value]); })(), /response\.bodySize must be a safe integer/],
    ['invalid status', (() => { const value = validEntry(); value.response.status = 99; return har([value]); })(), /response\.status must be 0 or an integer from 100 to 999/],
    ['non-boolean truncation', (() => {
      const value = validEntry();
      value.response.content._truncated = 'yes';
      value.response.content._capturedSize = 0;
      value.response.content._originalSize = 1;
      return har([value]);
    })(), /content\._truncated must be a boolean/],
    ['inverted truncation sizes', (() => {
      const value = validEntry();
      value.response.content._truncated = true;
      value.response.content._capturedSize = 2;
      value.response.content._originalSize = 1;
      return har([value]);
    })(), /content\._capturedSize cannot exceed _originalSize/]
  ];

  const nonFiniteDuration = JSON.stringify(har([validEntry()])).replace('"time":12.5', '"time":1e400');
  cases.push(['non-finite duration', nonFiniteDuration, /\.time must be a finite number/]);
  const nonFiniteSize = JSON.stringify(har([validEntry()])).replace('"size":0', '"size":1e400');
  cases.push(['non-finite response size', nonFiniteSize, /content\.size must be a finite number/]);

  for (const [name, document, expectedError] of cases) {
    const harness = createRendererHarness();
    await harness.importDocument(document);
    assert.equal(harness.added.length, 0, name);
    assert.equal(harness.toasts.length, 1, name);
    assert.equal(harness.toasts[0].type, 'error', name);
    assert.match(harness.toasts[0].message, expectedError, name);
    assert.equal(harness.toasts.some(item => item.type === 'success'), false, name);
  }
});

test('an invalid second HAR entry causes no partial renderer mutation or success toast', async () => {
  const first = validEntry();
  first.request.url = 'https://valid-first.test/';
  const second = validEntry();
  second.request.url = 'https://invalid-second.test/';
  second.request.method = 2;
  const harness = createRendererHarness();

  await harness.importDocument(har([first, second]));

  assert.deepEqual(harness.added, []);
  assert.deepEqual(harness.toasts.map(item => item.type), ['error']);
  assert.match(harness.toasts[0].message, /log\.entries\[1\]\.request\.method must be a string/);
  assert.doesNotMatch(harness.toasts[0].message, /Imported 1 request/);
});

test('valid rich HAR import preserves duplicates, base64 bodies, sizes, and safe search fields', async () => {
  const rich = validEntry();
  rich.time = 25.5;
  rich.request = {
    method: 'POST',
    url: 'https://rich-token.example/upload?part=one',
    httpVersion: 'HTTP/2',
    bodySize: 4,
    cookies: [{ name: 'request-cookie', value: 'one' }],
    headers: [
      { name: 'X-Repeated', value: 'one' },
      { name: 'x-repeated', value: 'two' }
    ],
    postData: {
      mimeType: 'application/octet-stream',
      text: ' AQID\n',
      encoding: 'base64',
      params: [{ name: 'field', value: 'value' }]
    }
  };
  rich.response = {
    status: 201,
    statusText: 'Created',
    httpVersion: 'HTTP/2',
    bodySize: 6,
    cookies: [{ name: 'response-cookie', value: 'two' }],
    headers: [
      { name: 'Set-Cookie', value: 'a=1' },
      { name: 'set-cookie', value: 'b=2' }
    ],
    content: {
      mimeType: 'application/octet-stream',
      text: ' BAUG\r\n',
      encoding: 'BASE64',
      size: 6
    }
  };
  const unknownSizes = validEntry();
  unknownSizes.request.bodySize = -1;
  unknownSizes.response.bodySize = -1;
  unknownSizes.response.content.size = -1;
  unknownSizes.request.url = 'http://size-default.example/';
  const harness = createRendererHarness();

  await harness.importDocument(har([rich, unknownSizes]));

  assert.equal(harness.added.length, 2);
  assert.deepEqual(harness.toasts, [{
    message: 'Imported 2 requests from HAR',
    type: 'success'
  }]);
  const imported = harness.added[0];
  assert.equal(imported.id, 'renderer-har-1');
  assert.equal(imported.protocol, 'h2');
  assert.equal(imported.method, 'POST');
  assert.equal(imported.host, 'rich-token.example');
  assert.equal(imported.path, '/upload?part=one');
  assert.deepEqual(Array.from(imported.requestHeaders['x-repeated']), ['one', 'two']);
  assert.deepEqual(Array.from(imported.responseHeaders['set-cookie']), ['a=1', 'b=2']);
  assert.equal(imported.requestBody, 'data:application/octet-stream;base64,AQID');
  assert.equal(imported.responseBody, 'data:application/octet-stream;base64,BAUG');
  assert.equal(imported.requestBodyEncoding, 'base64');
  assert.equal(imported.responseBodyEncoding, 'base64');
  assert.equal(imported.requestBodySize, 4);
  assert.equal(imported.responseBodySize, 6);
  assert.equal(imported.responseBodyDecodedSize, 6);
  assert.equal(imported.duration, 25.5);
  assert.equal(imported.timestamp, Date.parse(rich.startedDateTime));
  assert.equal(imported.requestHttpVersion, 'HTTP/2');
  assert.equal(imported.responseHttpVersion, 'HTTP/2');
  assert.equal(imported.requestPostDataMimeType, 'application/octet-stream');
  assert.equal(imported.responseContentMimeType, 'application/octet-stream');
  assert.equal(harness.added[1].requestBodySize, -1);
  assert.equal(harness.added[1].responseBodySize, -1);
  assert.equal(harness.added[1].responseBodyDecodedSize, -1);

  const reexported = trafficToHar([imported], { maskSensitive: false }).log.entries[0];
  assert.equal(reexported.request.postData.text, 'AQID');
  assert.equal(reexported.request.postData.encoding, 'base64');
  assert.equal(reexported.response.content.text, 'BAUG');
  assert.equal(reexported.response.content.encoding, 'base64');

  assert.doesNotThrow(() => harness.context.matchesRawFilterForTest(imported, 'method:post'));
  assert.equal(harness.context.matchesRawFilterForTest(imported, 'method:post'), true);
  assert.equal(harness.context.matchesRawFilterForTest(imported, 'rich-token'), true);
  assert.equal(harness.context.matchesRawFilterForTest(imported, 'header:x-repeated=two'), true);
});

test('visible HAR import preserves literal data-URI request and response text', async () => {
  const requestText = 'data:text/plain;base64,SGVsbG8=';
  const responseText = 'data:text/plain;base64,V29ybGQ=';
  const entry = validEntry();
  entry.request.postData = { mimeType: 'text/plain', text: requestText };
  entry.response.content = {
    mimeType: 'text/plain',
    text: responseText,
    size: Buffer.byteLength(responseText)
  };
  const harness = createRendererHarness();

  await harness.importDocument(har([entry]));

  assert.equal(harness.added.length, 1);
  const imported = harness.added[0];
  assert.equal(imported.requestBody, requestText);
  assert.equal(imported.requestBodyEncoding, 'utf8');
  assert.equal(imported.responseBody, responseText);
  assert.equal(imported.responseBodyEncoding, 'utf8');

  const exported = trafficToHar([imported], { maskSensitive: false }).log.entries[0];
  assert.equal(exported.request.postData.text, requestText);
  assert.equal(Object.hasOwn(exported.request.postData, 'encoding'), false);
  assert.equal(exported.response.content.text, responseText);
  assert.equal(Object.hasOwn(exported.response.content, 'encoding'), false);
});

test('renderer HAR import preserves truncation metadata across re-export', async () => {
  const entry = validEntry();
  entry.request.method = 'POST';
  entry.request.bodySize = 1000;
  entry.request.postData = {
    mimeType: 'text/plain',
    text: 'request preview',
    _truncated: true,
    _capturedSize: 15,
    _originalSize: 1000
  };
  entry.response.bodySize = 2000;
  entry.response.content = {
    mimeType: 'text/plain',
    text: 'response preview',
    size: 16,
    _truncated: true,
    _capturedSize: 16,
    _originalSize: 2000
  };
  const harness = createRendererHarness();

  await harness.importDocument(har([entry]));

  assert.equal(harness.added.length, 1);
  const imported = harness.added[0];
  assert.equal(imported.requestBodyTruncated, true);
  assert.equal(imported.requestBodyCapturedSize, 15);
  assert.equal(imported.requestBodyDecodedSize, 1000);
  assert.equal(imported.responseBodyTruncated, true);
  assert.equal(imported.responseBodyCapturedSize, 16);
  assert.equal(imported.responseBodyDecodedSize, 2000);

  const reexported = trafficToHar([imported], { maskSensitive: false }).log.entries[0];
  assert.deepEqual(
    JSON.parse(JSON.stringify({
      request: {
        truncated: reexported.request.postData._truncated,
        captured: reexported.request.postData._capturedSize,
        original: reexported.request.postData._originalSize
      },
      response: {
        truncated: reexported.response.content._truncated,
        captured: reexported.response.content._capturedSize,
        original: reexported.response.content._originalSize,
        size: reexported.response.content.size
      }
    })),
    {
      request: { truncated: true, captured: 15, original: 1000 },
      response: { truncated: true, captured: 16, original: 2000, size: 16 }
    }
  );
});

test('renderer HAR import preserves an unknown original truncation size', async () => {
  const entry = validEntry();
  entry.response.bodySize = -1;
  entry.response.content = {
    mimeType: 'text/plain',
    text: 'partial',
    size: 7,
    _truncated: true,
    _capturedSize: 7,
    _originalSize: -1
  };
  const harness = createRendererHarness();

  await harness.importDocument(har([entry]));

  assert.equal(harness.added.length, 1);
  assert.equal(harness.added[0].responseBodyTruncated, true);
  assert.equal(harness.added[0].responseBodyCapturedSize, 7);
  assert.equal(harness.added[0].responseBodyDecodedSize, -1);
  const reexported = trafficToHar(harness.added, { maskSensitive: false })
    .log.entries[0].response.content;
  assert.equal(reexported._originalSize, -1);
  assert.match(reexported.comment, /original size unknown/);
});
