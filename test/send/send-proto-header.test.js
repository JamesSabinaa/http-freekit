import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../../src/api/api-server.js';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const editorStart = rendererSource.indexOf('let sendHeadersList = []');
const editorEnd = rendererSource.indexOf('// ============ SEND TAB MANAGEMENT', editorStart);
assert.notEqual(editorStart, -1);
assert.notEqual(editorEnd, -1);

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
  return { serialized: hidden.value, headers: JSON.parse(hidden.value) };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1');
    server.once('listening', () => resolve(server.address().port));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function postJson(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/send',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

function rawHeaderValues(rawHeaders, name) {
  const values = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index].toLowerCase() === name.toLowerCase()) values.push(rawHeaders[index + 1]);
  }
  return values;
}

const headerRows = [
  { key: '__proto__', value: 'kept', enabled: true },
  { key: 'X-Test', value: 'one', enabled: true },
  { key: 'x-test', value: 'two', enabled: true },
  { key: 'X-Ordinary', value: 'unchanged', enabled: true },
  { key: 'X-Disabled', value: 'omitted', enabled: false }
];

test('Send header editor serializes __proto__ as an own header without changing row behavior', () => {
  const originalRows = structuredClone(headerRows);
  const { serialized, headers } = serializeHeaderRows(headerRows);

  assert.equal(Object.hasOwn(headers, '__proto__'), true);
  assert.equal(headers.__proto__, 'kept');
  assert.deepEqual(headers['X-Test'], ['one', 'two']);
  assert.equal(headers['X-Ordinary'], 'unchanged');
  assert.equal(Object.hasOwn(headers, 'X-Disabled'), false);
  assert.match(serialized, /"__proto__":"kept"/);
  assert.deepEqual(headerRows, originalRows);
});

test('Send API emits __proto__ and unchanged ordinary/repeated headers on the wire', async t => {
  let resolveRawHeaders;
  let originHits = 0;
  const rawHeadersReceived = new Promise(resolve => { resolveRawHeaders = resolve; });
  const origin = http.createServer((request, response) => {
    originHits++;
    resolveRawHeaders(request.rawHeaders);
    response.end('ok');
  });
  const originPort = await listen(origin);
  t.after(() => close(origin));

  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null);
  const apiServer = http.createServer(api.app);
  const apiPort = await listen(apiServer);
  t.after(() => close(apiServer));

  const { headers } = serializeHeaderRows(headerRows);
  const response = await postJson(apiPort, {
    url: `http://127.0.0.1:${originPort}/echo`,
    method: 'GET',
    headers
  });
  const rawHeaders = await rawHeadersReceived;

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.statusCode, 200);
  assert.deepEqual(rawHeaderValues(rawHeaders, '__proto__'), ['kept']);
  assert.deepEqual(rawHeaderValues(rawHeaders, 'x-test'), ['one', 'two']);
  assert.deepEqual(rawHeaderValues(rawHeaders, 'x-ordinary'), ['unchanged']);
  assert.deepEqual(rawHeaderValues(rawHeaders, 'x-disabled'), []);

  const invalid = await postJson(apiPort, {
    url: `http://127.0.0.1:${originPort}/rejected`,
    method: 'GET',
    headers: { 'Invalid Header Name': 'rejected' }
  });
  assert.equal(invalid.statusCode, 500);
  assert.match(invalid.body.error, /invalid header name/i);
  assert.equal(originHits, 1);
});
