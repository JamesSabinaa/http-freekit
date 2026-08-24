import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import {
  INVALID_SEND_URL_CODE,
  normalizeSendUrl
} from '../../src/ui/send-url.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
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
        contentType: response.headers['content-type'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

test('shared Send URL validation rejects malformed, unsupported, and zero-port targets', () => {
  for (const value of [
    undefined,
    null,
    '',
    '   ',
    'relative/path',
    'http:example.test/path',
    'http:/example.test/path',
    String.raw`http:\\example.test\path`,
    'http:///example.test/path',
    'http://[::1',
    'ftp://example.test/file',
    'http://example.test:0/path',
    'https://example.test:65536/path',
    'http://-invalid.example/path'
  ]) {
    assert.throws(
      () => normalizeSendUrl(value),
      error => error.code === INVALID_SEND_URL_CODE,
      String(value)
    );
  }

  assert.equal(normalizeSendUrl('https://example.test/path').href,
    'https://example.test/path');
  assert.equal(normalizeSendUrl('localhost:3000/path', { inferHttp: true }).href,
    'http://localhost:3000/path');
});

test('Send API classifies every invalid URL as a stable JSON 400', async t => {
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null);
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));

  for (const url of [
    undefined,
    null,
    42,
    {},
    '',
    'relative/path',
    'http:127.0.0.1/path',
    'http:/127.0.0.1/path',
    String.raw`http:\\127.0.0.1\path`,
    'http:///127.0.0.1/path',
    'http://[::1',
    'file:///tmp/request',
    'ftp://127.0.0.1/file',
    'http://127.0.0.1:0/path',
    'http://127.0.0.1:65536/path'
  ]) {
    const response = await postJson(port, { url, method: 'GET' });
    assert.equal(response.statusCode, 400, JSON.stringify(url));
    assert.match(response.contentType, /^application\/json\b/);
    assert.equal(response.body.code, INVALID_SEND_URL_CODE);
    assert.equal(typeof response.body.error, 'string');
  }
});
