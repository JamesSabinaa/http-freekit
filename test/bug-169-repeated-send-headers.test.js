import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../src/api/api-server.js';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const editorStart = rendererSource.indexOf('let sendHeadersList = []');
const editorEnd = rendererSource.indexOf('// Load headers from JSON string', editorStart);
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
  return JSON.parse(hidden.value);
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
