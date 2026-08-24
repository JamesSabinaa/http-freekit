import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { normalizeSendUrl } from '../../src/ui/send-url.js';

const source = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must be present`);
  return source.slice(start, end);
}

const sendRequestSource = extract('async function sendRequest()', 'function abortSendRequest()');
const curlReplacementSource = extract('function inferCurlSendBodyFormat(', 'function switchSendTab(');

function input(value) {
  const attributes = new Map();
  return {
    value,
    validityMessage: '',
    focused: false,
    setCustomValidity(message) { this.validityMessage = message; },
    setAttribute(name, attributeValue) { attributes.set(name, attributeValue); },
    removeAttribute(name) { attributes.delete(name); },
    focus() { this.focused = true; },
    hasAttribute(name) { return attributes.has(name); }
  };
}

function createDirectSendHarness(url) {
  const urlInput = input(url);
  const methodInput = input('GET');
  const headersInput = input('');
  const toasts = [];
  const requests = [];
  let payloadPreparations = 0;
  const elements = { sendUrl: urlInput, sendMethod: methodInput, sendHeaders: headersInput };
  const context = {
    activeSendTab: 'tab-1',
    sendAbortControllers: new Map(),
    normalizeSendUrl,
    document: { getElementById: id => elements[id] || null },
    toast: (message, type) => toasts.push({ message, type }),
    setSendLoading() {},
    async prepareSendRequestPayload() {
      payloadPreparations++;
      return { body: '', bodyEncoding: 'utf8', displayBody: '', byteLength: 0 };
    },
    assertSendManagementRequestSize() {},
    async fetch(endpoint, options) {
      requests.push({ endpoint, body: JSON.parse(options.body) });
      const aborted = new Error('stop after request capture');
      aborted.name = 'AbortError';
      throw aborted;
    },
    API_BASE: 'http://127.0.0.1:9000',
    AbortController
  };
  vm.createContext(context);
  vm.runInContext(`${sendRequestSource}; globalThis.runSend = sendRequest;`, context);
  return {
    run: () => context.runSend(),
    urlInput,
    toasts,
    requests,
    get payloadPreparations() { return payloadPreparations; }
  };
}

test('direct Send rejects malformed, schemeless, and unsupported destinations before payload work', async () => {
  for (const destination of [
    'example.test/path',
    'http://[broken',
    'ftp://example.test/file',
    'http://localhost:0/'
  ]) {
    const harness = createDirectSendHarness(destination);
    await harness.run();

    assert.equal(harness.payloadPreparations, 0, destination);
    assert.equal(harness.requests.length, 0, destination);
    assert.equal(harness.urlInput.focused, true, destination);
    assert.equal(harness.urlInput.hasAttribute('aria-invalid'), true, destination);
    assert.match(
      harness.urlInput.validityMessage,
      /HTTP|HTTPS|valid absolute|Unsupported Send URL protocol|port/i,
      destination
    );
    assert.equal(harness.toasts.at(-1)?.type, 'error', destination);
  }
});

test('direct Send clears URL errors and submits the canonical absolute HTTP destination', async () => {
  const harness = createDirectSendHarness('  https://example.test  ');
  harness.urlInput.setCustomValidity('stale');
  harness.urlInput.setAttribute('aria-invalid', 'true');

  await harness.run();

  assert.equal(harness.payloadPreparations, 1);
  assert.equal(harness.urlInput.validityMessage, '');
  assert.equal(harness.urlInput.hasAttribute('aria-invalid'), false);
  assert.equal(harness.requests[0].body.url, 'https://example.test/');
  assert.deepEqual(harness.toasts, []);
});

test('cURL replacement validates its parsed destination before changing Send state', () => {
  const original = { id: 'tab-1', method: 'GET', url: 'https://original.test/', headers: [] };
  const toasts = [];
  const context = {
    sendTabs: [original],
    activeSendTab: 'tab-1',
    normalizeSendUrl,
    normalizeSendHeaderRows: () => [],
    loadSendTabState() {},
    persistSendTabs() {},
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(`
    ${curlReplacementSource}
    globalThis.replaceFromCurl = replaceActiveSendTabFromCurl;
    globalThis.currentTab = () => sendTabs[0];
  `, context);

  assert.equal(context.replaceFromCurl({ method: 'GET', url: 'file:///tmp/data' }), null);
  assert.equal(context.currentTab(), original);
  assert.match(toasts.at(-1)?.message, /Cannot import cURL command.*(?:HTTP or HTTPS|Unsupported Send URL protocol)/);

  const replacement = context.replaceFromCurl({ method: 'GET', url: 'http://example.test' });
  assert.equal(replacement.url, 'http://example.test/');
  assert.equal(context.currentTab().url, 'http://example.test/');
});
