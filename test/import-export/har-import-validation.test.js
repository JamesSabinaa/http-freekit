import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import { trafficToHar } from '../../src/api/har-converter.js';

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
  assert.match(response.body.error, /log\.entries\[1\]\.request\.method must be a string/);
  assert.deepEqual(api.trafficLog, [existing]);
  assert.equal(broadcastCount, 0);
});

test('unsupported HAR URL schemes reject the entire server import', async t => {
  const { api, port } = await createApi(t);
  const existing = {
    id: 'existing',
    timestamp: 0,
    method: 'GET',
    url: 'https://existing.test/'
  };
  api.trafficLog.push(existing);
  let broadcastCount = 0;
  api._broadcast = () => { broadcastCount += 1; };

  for (const unsupportedUrl of [
    'ftp://files.example.test/archive.har',
    'file:///private/captured-request',
    'data:text/plain,captured-request'
  ]) {
    const response = await postBody(port, har([
      harEntry({ request: { url: 'https://valid-first.test/' } }),
      harEntry({ request: { url: unsupportedUrl } })
    ]));
    assert.equal(response.statusCode, 400, unsupportedUrl);
    assert.match(
      response.body.error,
      /log\.entries\[1\]\.request\.url must use the http, https, ws, or wss scheme/,
      unsupportedUrl
    );
    assert.deepEqual(api.trafficLog, [existing], unsupportedUrl);
    assert.equal(broadcastCount, 0, unsupportedUrl);
  }
});

test('REST and deep-link HAR imports atomically reject invalid request URLs', async t => {
  const { api, port } = await createApi(t);
  const existing = {
    id: 'existing',
    timestamp: 0,
    method: 'GET',
    url: 'https://existing.test/'
  };
  api.trafficLog.push(existing);
  let broadcastCount = 0;
  api._broadcast = () => { broadcastCount += 1; };

  const invalidUrls = [
    [null, /request\.url must be a string/],
    [42, /request\.url must be a string/],
    [{ unsafe: true }, /request\.url must be a string/],
    ['', /request\.url must not be empty/],
    ['/relative/request', /request\.url must be a valid absolute URL/],
    ['http://[::1', /request\.url must be a valid absolute URL/]
  ];

  for (const [url, expectedError] of invalidUrls) {
    const response = await postBody(port, har([
      harEntry({ request: { url: 'https://valid-first.test/' } }),
      harEntry({ request: { url } })
    ]));
    assert.equal(response.statusCode, 400, JSON.stringify(url));
    assert.match(response.body.error, expectedError, JSON.stringify(url));
    assert.deepEqual(api.trafficLog, [existing], JSON.stringify(url));
    assert.equal(broadcastCount, 0, JSON.stringify(url));
  }
});

test('HAR import rejects non-string request and response HTTP versions atomically', async t => {
  const { api, port } = await createApi(t);
  for (const [side, value] of [
    ['request', 0],
    ['request', null],
    ['response', { unsafe: true }]
  ]) {
    const response = await postBody(port, har([
      harEntry({ [side]: { httpVersion: value } })
    ]));
    assert.equal(response.statusCode, 400, side);
    assert.match(response.body.error, new RegExp(`${side}\\.httpVersion must be a string`), side);
    assert.deepEqual(api.trafficLog, [], side);
  }
});

test('HAR import rejects non-finite and out-of-range mapped numbers', async t => {
  const { api, port } = await createApi(t);
  const nonFiniteJson = JSON.stringify(har([harEntry({ time: 1 })]))
    .replace('"time":1', '"time":1e400');

  const nonFinite = await postBody(port, nonFiniteJson);
  assert.equal(nonFinite.statusCode, 400);
  assert.match(nonFinite.body.error, /time must be a finite number/);

  const negativeDuration = await postBody(port, har([harEntry({ time: -1 })]));
  assert.equal(negativeDuration.statusCode, 400);
  assert.match(negativeDuration.body.error, /time must be non-negative/);

  const invalidStatus = await postBody(port, har([harEntry({ response: { status: 1000 } })]));
  assert.equal(invalidStatus.statusCode, 400);
  assert.match(invalidStatus.body.error, /response\.status must be 0 or an integer from 100 to 999/);
  assert.deepEqual(api.trafficLog, []);
});

test('HAR import rejects attribute-delimiting methods but preserves valid HTTP tokens', async t => {
  const { api, port } = await createApi(t);

  for (const method of ['GET" data-audit="present', 'GET onclick=alert(1)', 'GET<svg>']) {
    const response = await postBody(port, har([harEntry({ request: { method } })]));
    assert.equal(response.statusCode, 400, method);
    assert.match(response.body.error, /method must be a valid HTTP token/, method);
  }
  assert.deepEqual(api.trafficLog, []);

  const valid = await postBody(port, har([
    harEntry({ request: { method: 'M-SEARCH' } }),
    harEntry({ request: { method: "!#$%&'*+-.^_`|~AZaz09" } })
  ]));
  assert.equal(valid.statusCode, 200, valid.body?.error);
  assert.deepEqual(api.trafficLog.map(request => request.method), [
    'M-SEARCH',
    "!#$%&'*+-.^_`|~AZaz09"
  ]);
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
  assert.equal(api.trafficLog[0].requestBodySize, -1);
  assert.equal(api.trafficLog[0].responseBodySize, -1);
  assert.equal(api.trafficLog[0].responseBodyDecodedSize, -1);
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
  assert.equal(exported.request.bodySize, -1);
  assert.equal(exported.response.bodySize, -1);
  assert.equal(exported.response.content.size, -1);
});

test('HAR import retains prototype-named headers as serializable own fields', async t => {
  const { api, port } = await createApi(t);
  const response = await postBody(port, har([harEntry({
    request: {
      headers: [
        { name: '__proto__', value: 'request-one' },
        { name: '__proto__', value: 'request-two' },
        { name: 'constructor', value: 'request-ctor' },
        { name: 'toString', value: 'request-text' }
      ]
    },
    response: {
      headers: [
        { name: '__proto__', value: 'response-proto' },
        { name: 'constructor', value: 'response-ctor' },
        { name: 'toString', value: 'response-text' }
      ]
    }
  })]));

  assert.equal(response.statusCode, 200, response.body?.error);
  const imported = api.trafficLog[0];
  assert.equal(Object.getPrototypeOf(imported.requestHeaders), null);
  assert.deepEqual(imported.requestHeaders.__proto__, ['request-one', 'request-two']);
  assert.equal(imported.requestHeaders.constructor, 'request-ctor');
  assert.equal(imported.requestHeaders.tostring, 'request-text');
  assert.equal(Object.getPrototypeOf(imported.responseHeaders), null);
  assert.equal(imported.responseHeaders.__proto__, 'response-proto');
  assert.equal(imported.responseHeaders.constructor, 'response-ctor');
  assert.equal(imported.responseHeaders.tostring, 'response-text');

  const serialized = JSON.parse(JSON.stringify(imported));
  assert.deepEqual(serialized.requestHeaders.__proto__, ['request-one', 'request-two']);
  assert.equal(serialized.responseHeaders.constructor, 'response-ctor');
});
