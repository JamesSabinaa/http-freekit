import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import { normalizeIncomingResponseHeaders } from
  '../../src/api/incoming-response-headers.js';

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('incoming response-header normalization preserves distinct repeated values', () => {
  const distinct = normalizeIncomingResponseHeaders({
    headersDistinct: {
      'content-type': ['text/plain'],
      'set-cookie': ['session=one; Path=/', 'theme=dark; Path=/'],
      warning: ['199 example "stale"', '299 example "deprecated"']
    },
    rawHeaders: ['x-ignored', 'joined']
  });
  assert.deepEqual(plain(distinct), {
    'content-type': 'text/plain',
    'set-cookie': ['session=one; Path=/', 'theme=dark; Path=/'],
    warning: ['199 example "stale"', '299 example "deprecated"']
  });

  const raw = normalizeIncomingResponseHeaders({
    rawHeaders: ['X-Test', 'one', 'x-test', 'two', 'X-Other', 'only'],
    headers: { 'x-test': 'one, two' }
  });
  assert.deepEqual(plain(raw), {
    'X-Test': ['one', 'two'],
    'X-Other': 'only'
  });
});

test('Send returns repeated origin response headers as ordered arrays', async t => {
  const origin = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/plain');
    response.setHeader('Set-Cookie', ['session=one; Path=/', 'theme=dark; Path=/']);
    response.setHeader('Warning', ['199 example "stale"', '299 example "deprecated"']);
    response.end('ok');
  });
  await new Promise((resolve, reject) => {
    origin.once('error', reject);
    origin.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => origin.close(resolve)));

  const result = await ApiServer.prototype._sendRequest.call(
    {},
    `http://127.0.0.1:${origin.address().port}/headers`,
    'GET',
    {},
    ''
  );

  assert.equal(result.headers['content-type'], 'text/plain');
  assert.deepEqual(result.headers['set-cookie'], [
    'session=one; Path=/',
    'theme=dark; Path=/'
  ]);
  assert.deepEqual(result.headers.warning, [
    '199 example "stale"',
    '299 example "deprecated"'
  ]);
});
