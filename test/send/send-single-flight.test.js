import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { normalizeSendUrl } from '../../src/ui/send-url.js';

function createSendHarness() {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = source.indexOf('async function sendRequest()');
  const end = source.indexOf('// ============ CONFIG', start);
  assert.ok(start >= 0 && end > start, 'Send functions must be present in app.js');

  const fetchCalls = [];
  const loadingStates = [];
  const toasts = [];
  const elements = {
    sendMethod: { value: 'GET' },
    sendUrl: { value: 'https://example.test/slow' },
    sendHeaders: { value: '' }
  };
  const context = {
    AbortController,
    API_BASE: 'http://127.0.0.1:8080',
    normalizeSendUrl,
    activeSendTab: 'tab-1',
    sendAbortControllers: new Map(),
    document: { getElementById: id => elements[id] },
    prepareSendRequestPayload: async () => ({ body: '', bodyEncoding: 'utf8' }),
    assertSendManagementRequestSize() {},
    setSendLoading: loading => loadingStates.push(loading),
    toast: (...args) => toasts.push(args),
    fetch: (url, options) => {
      fetchCalls.push({ url, options });
      return new Promise((resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (options.signal.aborted) {
          rejectAbort();
        } else {
          options.signal.addEventListener('abort', rejectAbort, { once: true });
        }
      });
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    ${source.slice(start, end)}
    globalThis.callSendRequest = sendRequest;
    globalThis.callAbortSendRequest = abortSendRequest;
    globalThis.getCurrentSendAbort = (tabId = activeSendTab) => sendAbortControllers.get(tabId) || null;
    globalThis.setActiveSendTab = tabId => { activeSendTab = tabId; };
  `, context);

  return { context, fetchCalls, loadingStates, toasts };
}

test('Send remains single-flight across programmatic and keyboard-style invocations', async () => {
  const { context, fetchCalls, loadingStates } = createSendHarness();

  const first = context.callSendRequest();
  const duplicate = context.callSendRequest();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(fetchCalls.length, 1);
  assert.deepEqual(loadingStates, [true]);
  await duplicate;

  context.callAbortSendRequest();
  const duringAbort = context.callSendRequest();
  assert.equal(fetchCalls.length, 1);
  assert.equal(context.getCurrentSendAbort().signal.aborted, true);

  await Promise.all([first, duringAbort]);
  assert.equal(context.getCurrentSendAbort(), null);
  assert.deepEqual(loadingStates, [true, false]);
});

test('different Send tabs own independent requests and abort controllers', async () => {
  const { context, fetchCalls } = createSendHarness();

  const first = context.callSendRequest();
  context.setActiveSendTab('tab-2');
  const second = context.callSendRequest();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(fetchCalls.length, 2);
  const firstController = context.getCurrentSendAbort('tab-1');
  const secondController = context.getCurrentSendAbort('tab-2');
  assert.notEqual(firstController, secondController);

  context.callAbortSendRequest();
  assert.equal(secondController.signal.aborted, true);
  assert.equal(firstController.signal.aborted, false);

  context.setActiveSendTab('tab-1');
  context.callAbortSendRequest();
  await Promise.all([first, second]);
  assert.equal(context.getCurrentSendAbort('tab-1'), null);
  assert.equal(context.getCurrentSendAbort('tab-2'), null);
});

test('Abort keeps ownership until settlement and reports only the first abort', async () => {
  const { context, toasts } = createSendHarness();

  const request = context.callSendRequest();
  await new Promise(resolve => setImmediate(resolve));
  const controller = context.getCurrentSendAbort();

  context.callAbortSendRequest();
  context.callAbortSendRequest();

  assert.equal(context.getCurrentSendAbort(), controller);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(toasts, [['Request aborted', 'success']]);

  await request;
  assert.equal(context.getCurrentSendAbort(), null);
});
