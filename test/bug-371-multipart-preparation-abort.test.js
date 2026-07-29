import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function between(startMarker, endMarker, fromIndex = 0) {
  const start = source.indexOf(startMarker, fromIndex);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must be present`);
  return source.slice(start, end);
}

const multipartSource = between('function serializeUrlEncodedFields(', '// ============ SEND HEADERS KEY-VALUE EDITOR');
const payloadStart = source.indexOf('function findHeaderKey(headers, name)', source.indexOf('function setSendLoading('));
const payloadSource = between('function findHeaderKey(headers, name)', 'async function sendRequest()', payloadStart);
const sendSource = between('async function sendRequest()', '// ============ CONFIG', payloadStart);

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

function createHarness({ firstRead }) {
  const state = {
    bodyType: 'multipart',
    rawBody: 'raw body',
    fileReads: 0,
    loading: [],
    toasts: [],
    fetchCalls: []
  };
  const fields = [{
    key: 'upload',
    type: 'file',
    enabled: true,
    file: {
      name: 'held.bin',
      type: 'application/octet-stream',
      arrayBuffer() {
        state.fileReads++;
        return state.fileReads === 1
          ? firstRead
          : Promise.resolve(Uint8Array.from([1, 2, 3]).buffer);
      }
    }
  }];
  const elements = {
    sendMethod: { value: 'POST' },
    sendUrl: { value: 'https://example.test/upload' },
    sendHeaders: { value: '{}' },
    'panel-send': { classList: { contains: name => name === 'active' } }
  };
  const context = {
    AbortController,
    API_BASE: 'http://127.0.0.1:8080',
    TextEncoder,
    Uint8Array,
    URLSearchParams,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    document: { getElementById: id => elements[id] || null },
    getSendBodyType: () => state.bodyType,
    getSendBodyValue: () => state.rawBody,
    formatToContentType: () => 'text/plain',
    createMultipartBoundary: () => 'generated-boundary',
    setSendLoading: value => state.loading.push(value),
    toast: (...args) => state.toasts.push(args),
    fetch: (url, options) => {
      state.fetchCalls.push({ url, options });
      return new Promise((resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error('fetch aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (options.signal.aborted) rejectAbort();
        else options.signal.addEventListener('abort', rejectAbort, { once: true });
      });
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    let sendUrlEncodedFields = [];
    let sendMultipartFields = globalThis.__fields;
    let sendMultipartBoundary = '';
    let currentSendAbort = null;
    let activeSendTab = 'tab-1';
    ${multipartSource}
    ${payloadSource}
    ${sendSource}
    globalThis.abortApi = {
      send: sendRequest,
      abort: abortSendRequest,
      escape: handleSendEscapeShortcut,
      current: () => currentSendAbort,
      prepare: prepareSendRequestPayload,
      setBodyType(value) { globalThis.__state.bodyType = value; },
      setRawBody(value) { globalThis.__state.rawBody = value; },
      setUrlEncodedFields(value) { sendUrlEncodedFields = value; },
      setMultipartFields(value) { sendMultipartFields = value; },
      setBoundary(value) { sendMultipartBoundary = value; }
    };
  `, Object.assign(context, { __fields: fields, __state: state }));
  return { api: context.abortApi, context, state };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await flush();
  }
  assert.fail(message);
}

test('Abort promptly settles a held multipart read and preserves single-flight ownership', async () => {
  let rejectFirstRead;
  const heldRead = new Promise((_resolve, reject) => { rejectFirstRead = reject; });
  const harness = createHarness({ firstRead: heldRead });

  const first = harness.api.send();
  await waitFor(() => harness.state.fileReads === 1, 'multipart file read did not start');
  const firstController = harness.api.current();
  assert.deepEqual(harness.state.loading, [true]);

  assert.equal(harness.api.abort(), true);
  const duplicateDuringAbort = harness.api.send();
  assert.equal(harness.api.current(), firstController);
  assert.equal(firstController.signal.aborted, true);
  assert.equal(harness.state.fetchCalls.length, 0);

  const settledPromptly = await Promise.race([
    first.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 100))
  ]);
  assert.equal(settledPromptly, true);
  await duplicateDuringAbort;
  assert.equal(harness.api.current(), null);
  assert.deepEqual(harness.state.loading, [true, false]);
  assert.deepEqual(harness.state.toasts, [['Request aborted', 'success']]);

  rejectFirstRead(new Error('late file read rejection'));
  await flush();
  await flush();
  assert.equal(harness.state.fetchCalls.length, 0);

  const next = harness.api.send();
  await waitFor(() => harness.state.fetchCalls.length === 1, 'next Send did not reach fetch');
  const nextController = harness.api.current();
  const duplicateAtFetch = harness.api.send();
  assert.equal(harness.state.fetchCalls.length, 1);
  let preventCalls = 0;
  assert.equal(harness.api.escape({ preventDefault: () => { preventCalls++; } }), true);
  assert.equal(preventCalls, 1);
  assert.equal(nextController.signal.aborted, true);

  await Promise.all([next, duplicateAtFetch]);
  assert.equal(harness.api.current(), null);
  assert.deepEqual(harness.state.loading, [true, false, true, false]);
  assert.deepEqual(harness.state.toasts, [
    ['Request aborted', 'success'],
    ['Request aborted', 'success']
  ]);
});

test('late multipart file resolution after Abort is consumed without fetching', async () => {
  let resolveFirstRead;
  const heldRead = new Promise(resolve => { resolveFirstRead = resolve; });
  const harness = createHarness({ firstRead: heldRead });

  const request = harness.api.send();
  await waitFor(() => harness.state.fileReads === 1, 'multipart file read did not start');
  harness.api.abort();
  await request;
  resolveFirstRead(Uint8Array.from([9, 8, 7]).buffer);
  await flush();

  assert.equal(harness.state.fetchCalls.length, 0);
  assert.equal(harness.api.current(), null);
  assert.deepEqual(harness.state.loading, [true, false]);
});

test('normal multipart, URL-encoded, and raw payload bytes remain unchanged', async () => {
  const harness = createHarness({ firstRead: Promise.resolve(new ArrayBuffer(0)) });
  const boundary = 'stable-boundary';
  const fileBytes = Uint8Array.from([0x00, 0x7f, 0x80, 0xff]);
  harness.api.setBoundary(boundary);
  harness.api.setMultipartFields([
    { key: 'text', type: 'text', value: 'hello', enabled: true },
    {
      key: 'upload',
      type: 'file',
      enabled: true,
      file: {
        name: 'bytes.bin',
        type: 'application/octet-stream',
        arrayBuffer: async () => fileBytes.buffer
      }
    }
  ]);
  const multipartHeaders = {};
  const multipart = await harness.api.prepare(multipartHeaders, new AbortController().signal);
  const expected = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nhello\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="upload"; filename="bytes.bin"\r\n`),
    Buffer.from('Content-Type: application/octet-stream\r\n\r\n'),
    Buffer.from(fileBytes),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  assert.deepEqual(Buffer.from(multipart.body, 'base64'), expected);
  assert.equal(multipart.bodyEncoding, 'base64');
  assert.equal(multipart.byteLength, expected.length);
  assert.equal(multipartHeaders['Content-Type'], `multipart/form-data; boundary=${boundary}`);

  harness.api.setBodyType('urlencoded');
  harness.api.setUrlEncodedFields([
    { key: 'one', value: 'hello world', enabled: true },
    { key: 'one', value: 'two', enabled: true },
    { key: 'skip', value: 'hidden', enabled: false }
  ]);
  const urlEncodedHeaders = {};
  const urlEncoded = await harness.api.prepare(urlEncodedHeaders, new AbortController().signal);
  assert.equal(urlEncoded.body, 'one=hello+world&one=two');
  assert.equal(urlEncoded.bodyEncoding, 'utf8');
  assert.equal(urlEncodedHeaders['Content-Type'], 'application/x-www-form-urlencoded');

  harness.api.setBodyType('raw');
  harness.api.setRawBody('raw \u2603 body');
  const rawHeaders = {};
  const raw = await harness.api.prepare(rawHeaders, new AbortController().signal);
  assert.equal(raw.body, 'raw \u2603 body');
  assert.equal(raw.bodyEncoding, 'utf8');
  assert.equal(raw.byteLength, Buffer.byteLength('raw \u2603 body'));
  assert.equal(rawHeaders['Content-Type'], 'text/plain');
});
