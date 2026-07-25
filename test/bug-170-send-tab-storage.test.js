import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const helpersStart = source.indexOf('function cloneSendFormFields');
const helpersEnd = source.indexOf('function createEmptySendTab', helpersStart);
const restoreEnd = source.indexOf('function loadSendTabState', helpersEnd);
assert.notEqual(helpersStart, -1);
assert.notEqual(helpersEnd, -1);
assert.notEqual(restoreEnd, -1);

function loadNormalizationContext() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(helpersStart, helpersEnd), context);
  return context;
}

function restoreTabs(savedTabs, savedActive = null, addTab = false) {
  const context = {
    __addTab: addTab,
    safeLocalStorageGet(key) {
      if (key === 'http-freekit-send-tabs') return savedTabs;
      if (key === 'http-freekit-send-active') return savedActive;
      return null;
    }
  };
  vm.createContext(context);
  vm.runInContext(`
    let sendTabs = [{ id: 'tab-1', method: 'GET', url: '', headers: [], body: '' }];
    let activeSendTab = 'tab-1';
    let sendTabCounter = 1;
    ${source.slice(helpersStart, restoreEnd)}
    restoreSendTabs();
    const createdTab = __addTab ? createEmptySendTab() : null;
    __result = { sendTabs, activeSendTab, sendTabCounter, createdTab };
  `, context);
  return JSON.parse(JSON.stringify(context.__result));
}

test('stored Send tabs normalize malformed collections without discarding valid fields', () => {
  const context = loadNormalizationContext();
  const normalized = JSON.parse(JSON.stringify(context.normalizeStoredSendTabs([
    null,
    {
      id: 'tab-7',
      method: 'POST',
      url: 'https://example.test/upload',
      headers: { 'X-Test': ['one', 'two'] },
      body: 'payload',
      bodyType: 'multipart',
      bodyFormat: 'json',
      urlEncodedFields: { stale: true },
      multipartFields: [null, { key: 'upload', type: 'file', fileName: 'a.txt' }],
      multipartBoundary: 'saved-boundary'
    },
    { id: 'tab-7', headers: 'invalid', bodyType: 'invalid' },
    { headers: [{ key: 42, value: null }, null] }
  ])));

  assert.equal(normalized.length, 3);
  assert.deepEqual(normalized[0], {
    id: 'tab-7',
    method: 'POST',
    url: 'https://example.test/upload',
    headers: [
      { key: 'X-Test', value: 'one', enabled: true },
      { key: 'X-Test', value: 'two', enabled: true }
    ],
    body: 'payload',
    bodyType: 'multipart',
    bodyFormat: 'json',
    urlEncodedFields: [],
    multipartFields: [{
      key: 'upload', value: '', enabled: true, type: 'file', fileName: 'a.txt', fileType: ''
    }],
    multipartBoundary: 'saved-boundary',
    response: null
  });
  assert.notEqual(normalized[1].id, 'tab-7');
  assert.notEqual(normalized[2].id, normalized[1].id);
  assert.deepEqual(normalized[1].headers, []);
  assert.equal(normalized[1].bodyType, 'raw');
  assert.deepEqual(normalized[2].headers, [{ key: '42', value: '', enabled: true }]);
});

test('restore repairs the reported object-shaped headers and preserves active selection', () => {
  const result = restoreTabs(JSON.stringify([
    { id: 'tab-1', headers: {} },
    { id: 'tab-2', method: 'PATCH', url: 'https://example.test', headers: [] }
  ]), 'tab-2');

  assert.deepEqual(result.sendTabs[0].headers, []);
  assert.equal(result.sendTabs[1].method, 'PATCH');
  assert.equal(result.sendTabs[1].url, 'https://example.test');
  assert.equal(result.activeSendTab, 'tab-2');
  assert.equal(result.sendTabCounter, 2);
});

test('live tab normalization retains selected multipart files and response state', () => {
  const context = loadNormalizationContext();
  const file = { name: 'payload.bin', type: 'application/octet-stream', arrayBuffer() {} };
  const response = { statusCode: 200, headersHtml: '<span>trusted live render</span>' };
  const normalized = context.normalizeSendTab({
    id: 'tab-1',
    multipartFields: [{ key: 'upload', type: 'file', file }],
    response
  }, 'tab-1');

  assert.equal(normalized.multipartFields[0].file, file);
  assert.equal(normalized.response, response);
});

test('stored tabs discard untrusted response markup and object payloads', () => {
  const storedResponse = {
    statusMessage: { toString: '<img src=x onerror=alert(1)>' },
    headersHtml: '<img src=x onerror=alert(1)>',
    body: { nested: true },
    responseHeaders: { '__proto__': { polluted: true } }
  };
  const result = restoreTabs(JSON.stringify([{
    id: 'tab-1',
    method: 'POST',
    body: 'valid request body',
    response: storedResponse
  }]));

  assert.equal(result.sendTabs[0].response, null);
  assert.equal(result.sendTabs[0].method, 'POST');
  assert.equal(result.sendTabs[0].body, 'valid request body');
});

test('unsafe and duplicate IDs normalize to finite unique IDs and cannot poison new tabs', () => {
  const unsafeNumericId = `tab-${Number.MAX_SAFE_INTEGER + 1}`;
  const result = restoreTabs(JSON.stringify([
    { id: 'tab-Infinity', body: 'infinity' },
    { id: unsafeNumericId, body: 'unsafe integer' },
    { id: 'tab-01', body: 'noncanonical' },
    { id: `tab-${Number.MAX_SAFE_INTEGER}`, body: 'largest safe integer' },
    { id: 'tab-7', body: 'valid' },
    { id: 'tab-7', body: 'duplicate' },
    { id: '<img src=x>', body: 'markup' }
  ]), 'tab-Infinity', true);

  const ids = result.sendTabs.map(tab => tab.id);
  assert.equal(new Set(ids).size, ids.length);
  ids.forEach(id => assert.match(id, /^tab-[1-9]\d*$/));
  assert.equal(Number.isSafeInteger(result.sendTabCounter), true);
  assert.match(result.createdTab.id, /^tab-[1-9]\d*$/);
  assert.equal(ids.includes(result.createdTab.id), false);
  assert.equal(result.activeSendTab, result.sendTabs[0].id);
});

test('normalized IDs and tab content remain stable across repeated reloads', () => {
  const first = restoreTabs(JSON.stringify([
    { id: 'tab-Infinity', method: 'PATCH', url: 'https://one.example' },
    { id: 'tab-4', body: 'kept' },
    { id: 'tab-4', headers: { 'X-Test': 'value' } }
  ]));
  const second = restoreTabs(JSON.stringify(first.sendTabs), first.activeSendTab);

  assert.deepEqual(second.sendTabs, first.sendTabs);
  assert.equal(second.activeSendTab, first.activeSendTab);
  assert.equal(second.sendTabCounter, first.sendTabCounter);
});

test('restore falls back to the default tab for corrupt or unusable storage', () => {
  assert.deepEqual(restoreTabs('{invalid').sendTabs, [
    { id: 'tab-1', method: 'GET', url: '', headers: [], body: '' }
  ]);
  assert.deepEqual(restoreTabs(JSON.stringify([null, [], 'stale'])).sendTabs, [
    { id: 'tab-1', method: 'GET', url: '', headers: [], body: '' }
  ]);
});
