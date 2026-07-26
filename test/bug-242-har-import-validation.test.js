import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';
import { trafficToHar } from '../src/api/har-converter.js';

function postBody(port, body) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/traffic/import-har',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: response.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    request.once('error', reject);
    request.end(payload);
  });
}

async function createApi(t) {
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { api, port: server.address().port };
}

function harEntry(overrides = {}) {
  const entry = {
    startedDateTime: '2026-01-01T00:00:00.000Z',
    time: 12.5,
    request: {
      method: 'GET',
      url: 'https://example.test/resource',
      httpVersion: 'HTTP/2',
      headers: []
    },
    response: {
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/2',
      headers: [],
      content: { mimeType: 'text/plain', text: 'ok', size: 2 }
    }
  };
  return {
    ...entry,
    ...overrides,
    request: { ...entry.request, ...overrides.request },
    response: {
      ...entry.response,
      ...overrides.response,
      content: { ...entry.response.content, ...overrides.response?.content }
    }
  };
}

function har(entries) {
  return { log: { version: '1.2', entries } };
}

test('a malformed entry rejects a multi-entry HAR without mutating traffic', async t => {
  const { api, port } = await createApi(t);
  const existing = {
    id: 'existing',
    timestamp: 0,
    method: 'GET',
    url: 'https://existing.test/'
  };
  api.trafficLog.push(existing);
  api.maxTrafficLog = 1;
  let broadcastCount = 0;
  api._broadcast = () => { broadcastCount += 1; };

  const response = await postBody(port, har([
    harEntry({ request: { url: 'https://example.test/valid' } }),
    harEntry({ request: { method: { unsafe: true }, url: 'https://example.test/invalid' } })
  ]));

  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /requests\[1\]\.method must be a string/);
  assert.deepEqual(api.trafficLog, [existing]);
  assert.equal(broadcastCount, 0);
});

test('HAR import rejects non-finite and out-of-range mapped numbers', async t => {
  const { api, port } = await createApi(t);
  const nonFiniteJson = JSON.stringify(har([harEntry({ time: 1 })]))
    .replace('"time":1', '"time":1e400');

  const nonFinite = await postBody(port, nonFiniteJson);
  assert.equal(nonFinite.statusCode, 400);
  assert.match(nonFinite.body.error, /duration must be a finite number/);

  const negativeDuration = await postBody(port, har([harEntry({ time: -1 })]));
  assert.equal(negativeDuration.statusCode, 400);
  assert.match(negativeDuration.body.error, /duration must be non-negative/);

  const invalidStatus = await postBody(port, har([harEntry({ response: { status: 1000 } })]));
  assert.equal(invalidStatus.statusCode, 400);
  assert.match(invalidStatus.body.error, /statusCode must be 0 or an integer from 100 to 999/);
  assert.deepEqual(api.trafficLog, []);
});

test('valid rich HAR entries retain normalization, metadata, bodies, and generated IDs', async t => {
  const { api, port } = await createApi(t);
  t.mock.method(crypto, 'randomUUID', () => 'stable-har-id');
  const requestCookies = [{ name: 'request-cookie', value: 'one', path: '/' }];
  const responseCookies = [{ name: 'response-cookie', value: 'two', httpOnly: true }];
  const params = [{ name: 'field', value: 'value' }];

  const response = await postBody(port, har([harEntry({
    request: {
      method: 'POST',
      bodySize: -1,
      cookies: requestCookies,
      headers: [
        { name: 'X-Repeated', value: 'one' },
        { name: 'X-Repeated', value: 'two' }
      ],
      postData: {
        mimeType: 'application/octet-stream',
        text: 'AQID',
        encoding: 'base64',
        params
      }
    },
    response: {
      bodySize: -1,
      cookies: responseCookies,
      headers: [
        { name: 'Set-Cookie', value: 'a=1' },
        { name: 'Set-Cookie', value: 'b=2' }
      ],
      content: {
        mimeType: 'application/octet-stream',
        text: 'BAUG',
        encoding: 'base64',
        size: -1
      }
    }
  })]));

  assert.equal(response.statusCode, 200, response.body?.error);
  assert.equal(response.body.imported, 1);
  assert.equal(api.trafficLog[0].id, 'stable-har-id');
  assert.equal(api.trafficLog[0].protocol, 'h2');
  assert.equal(api.trafficLog[0].requestBodySize, 0);
  assert.equal(api.trafficLog[0].responseBodySize, 0);
  assert.deepEqual(api.trafficLog[0].requestHeaders['x-repeated'], ['one', 'two']);
  assert.deepEqual(api.trafficLog[0].responseHeaders['set-cookie'], ['a=1', 'b=2']);
  assert.equal(api.trafficLog[0].requestBody, 'data:application/octet-stream;base64,AQID');
  assert.equal(api.trafficLog[0].responseBody, 'data:application/octet-stream;base64,BAUG');

  const exported = trafficToHar(api.trafficLog, { maskSensitive: false }).log.entries[0];
  assert.deepEqual(exported.request.cookies, requestCookies);
  assert.deepEqual(exported.response.cookies, responseCookies);
  assert.deepEqual(exported.request.postData.params, params);
  assert.equal(exported.request.postData.encoding, 'base64');
  assert.equal(exported.response.content.encoding, 'base64');
});
