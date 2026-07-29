import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../src/api/api-server.js';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const editorStart = rendererSource.indexOf('let sendHeadersList = []');
const editorEnd = rendererSource.indexOf('// ============ SEND TAB MANAGEMENT', editorStart);
const normalizeStart = rendererSource.indexOf('function normalizeSendHeaderRows(');
const normalizeEnd = rendererSource.indexOf('function parseSendTabId(', normalizeStart);
const curlStart = rendererSource.indexOf('function encodeCurlComponent(');
const curlEnd = rendererSource.indexOf('// ============ SEND REQUEST', curlStart);
assert.notEqual(editorStart, -1);
assert.notEqual(editorEnd, -1);
assert.notEqual(normalizeStart, -1);
assert.notEqual(normalizeEnd, -1);
assert.notEqual(curlStart, -1);
assert.notEqual(curlEnd, -1);

function serializeHeaderRows(rows) {
  const hidden = { value: '' };
  const context = {
    __rows: rows,
    document: { getElementById: id => id === 'sendHeaders' ? hidden : null }
  };
  vm.createContext(context);
  vm.runInContext(
    `${rendererSource.slice(editorStart, editorEnd)}\nsendHeadersList = __rows; syncSendHeadersToHidden();`,
    context
  );
  return JSON.parse(hidden.value);
}

function loadHeaderRows(headers) {
  const hidden = { value: '' };
  const rows = { innerHTML: '' };
  const context = {
    document: {
      getElementById(id) {
        if (id === 'sendHeaders') return hidden;
        if (id === 'sendHeaderRows') return rows;
        return null;
      }
    },
    esc: value => String(value)
  };
  vm.createContext(context);
  vm.runInContext(`
    ${rendererSource.slice(normalizeStart, normalizeEnd)}
    ${rendererSource.slice(editorStart, editorEnd)}
    loadSendHeadersFromJson(${JSON.stringify(JSON.stringify(headers))});
    __rows = sendHeadersList;
  `, context);
  return JSON.parse(JSON.stringify(context.__rows));
}

function parseCurl(command) {
  const context = {
    TextEncoder,
    btoa: value => Buffer.from(value, 'binary').toString('base64')
  };
  vm.createContext(context);
  vm.runInContext(rendererSource.slice(curlStart, curlEnd), context);
  return JSON.parse(JSON.stringify(context.parseCurlCommand(command)));
}

test('Send serializes repeated enabled header rows into ordered arrays', () => {
  const headers = serializeHeaderRows([
    { key: 'X-Test', value: 'one', enabled: true },
    { key: 'x-test', value: 'two', enabled: true },
    { key: 'X-Test', value: 'disabled', enabled: false },
    { key: 'X-Other', value: 'only', enabled: true }
  ]);

  assert.deepEqual(headers, {
    'X-Test': ['one', 'two'],
    'X-Other': 'only'
  });
});

test('Send backend emits serialized arrays as repeated request headers', async t => {
  let resolveRequest;
  const received = new Promise(resolve => { resolveRequest = resolve; });
  const origin = http.createServer((request, response) => {
    resolveRequest(request.rawHeaders);
    response.end('ok');
  });
  await new Promise((resolve, reject) => {
    origin.once('error', reject);
    origin.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => origin.close(resolve)));

  const headers = serializeHeaderRows([
    { key: 'X-Test', value: 'one', enabled: true },
    { key: 'X-Test', value: 'two', enabled: true }
  ]);
  const response = ApiServer.prototype._sendRequest.call(
    {},
    `http://127.0.0.1:${origin.address().port}/echo`,
    'GET',
    headers,
    ''
  );

  const rawHeaders = await received;
  const values = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === 'x-test') values.push(rawHeaders[index + 1]);
  }

  assert.deepEqual(values, ['one', 'two']);
  assert.equal((await response).statusCode, 200);
});

test('cURL import keeps repeated headers ordered through editor loading', () => {
  const parsed = parseCurl(
    "curl https://example.test -H 'X-Test: one' -H 'X-Test: two' -H 'x-single: only'"
  );

  assert.deepEqual(parsed.headers, {
    'X-Test': ['one', 'two'],
    'x-single': 'only'
  });
  const rows = loadHeaderRows(parsed.headers);
  assert.deepEqual(rows, [
    { key: 'X-Test', value: 'one', enabled: true },
    { key: 'X-Test', value: 'two', enabled: true },
    { key: 'x-single', value: 'only', enabled: true }
  ]);
  assert.deepEqual(serializeHeaderRows(rows), parsed.headers);

  const explicitContentType = parseCurl(
    "curl https://example.test -d '{}' -H 'content-type: application/json'"
  );
  assert.equal(explicitContentType.headers['content-type'], 'application/json');
  assert.equal(Object.keys(explicitContentType.headers).length, 1);

  assert.equal(
    parseCurl("curl https://example.test -A option -H 'User-Agent: explicit'").headers['User-Agent'],
    'explicit'
  );
  assert.equal(
    parseCurl("curl https://example.test -H 'User-Agent: explicit' -A option").headers['User-Agent'],
    'option'
  );
});

test('resend expands captured header arrays into repeated editor rows', () => {
  const resendStart = rendererSource.indexOf('function resendSelectedRequest(');
  const resendEnd = rendererSource.indexOf('// Track collapsed state', resendStart);
  const allocatorStart = rendererSource.indexOf('function parseSendTabId(');
  const allocatorEnd = rendererSource.indexOf('function createEmptySendTab(', allocatorStart);
  assert.notEqual(allocatorStart, -1);
  assert.notEqual(allocatorEnd, -1);
  let loadedTab;
  const context = {
    selectedRequestId: 'request-1',
    selectedRequestLifecycleId: null,
    requests: [{
      id: 'request-1',
      method: 'GET',
      url: 'https://example.test/',
      requestHeaders: {
        Host: 'example.test',
        'X-Test': ['one', 'two'],
        'X-Single': 'only'
      },
      requestBody: ''
    }],
    sendTabs: [],
    sendTabCounter: 1,
    activeSendTab: 'tab-1',
    saveSendTabState() {},
    document: { querySelector: () => null },
    loadSendTabState: tab => { loadedTab = tab; },
    renderSendTabs() {},
    toast() {}
  };
  context.trafficActionRequest = requestId =>
    context.requests.find(request => request.id === requestId) || null;
  vm.createContext(context);
  vm.runInContext(`
    ${rendererSource.slice(allocatorStart, allocatorEnd)}
    ${rendererSource.slice(resendStart, resendEnd)}
    resendSelectedRequest();
  `, context);

  assert.deepEqual(JSON.parse(JSON.stringify(loadedTab.headers)), [
    { key: 'X-Test', value: 'one', enabled: true },
    { key: 'X-Test', value: 'two', enabled: true },
    { key: 'X-Single', value: 'only', enabled: true }
  ]);
});
