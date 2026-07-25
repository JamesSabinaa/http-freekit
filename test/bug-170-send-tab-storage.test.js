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

function restoreTabs(savedTabs, savedActive = null) {
  const context = {
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
    __result = { sendTabs, activeSendTab, sendTabCounter };
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

test('live tab normalization retains selected multipart files', () => {
  const context = loadNormalizationContext();
  const file = { name: 'payload.bin', type: 'application/octet-stream', arrayBuffer() {} };
  const normalized = context.normalizeStoredSendTab({
    id: 'tab-1',
    multipartFields: [{ key: 'upload', type: 'file', file }]
  }, 'tab-1');

  assert.equal(normalized.multipartFields[0].file, file);
});

test('restore falls back to the default tab for corrupt or unusable storage', () => {
  assert.deepEqual(restoreTabs('{invalid').sendTabs, [
    { id: 'tab-1', method: 'GET', url: '', headers: [], body: '' }
  ]);
  assert.deepEqual(restoreTabs(JSON.stringify([null, [], 'stale'])).sendTabs, [
    { id: 'tab-1', method: 'GET', url: '', headers: [], body: '' }
  ]);
});
