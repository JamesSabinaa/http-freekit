import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import zlib from 'node:zlib';

import { ApiServer } from '../../src/api/api-server.js';
import { trafficToHar } from '../../src/api/har-converter.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';
import { normalizeHarEntries } from '../../src/ui/har-import.js';

function requestJson(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: payload === null ? {} : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: response.statusCode,
          body: text ? JSON.parse(text) : null
        });
      });
    });
    request.once('error', reject);
    request.end(payload);
  });
}

function contentDecodedRecord(id = 'decoded-roundtrip') {
  const capture = new ProxyServer(null);
  const requestText = 'decoded request body';
  const responseText = 'decoded response body';
  const record = {
    id,
    protocol: 'http',
    method: 'PROPFIND',
    url: 'http://decoded.example.test/resource',
    host: 'decoded.example.test',
    path: '/resource',
    requestHeaders: {
      'content-type': 'text/plain',
      'content-encoding': 'gzip',
      'content-length': String(zlib.gzipSync(requestText).length)
    },
    requestBody: capture._safeBodyString(
      zlib.gzipSync(requestText),
      'gzip',
      'text/plain'
    ),
    requestBodySize: zlib.gzipSync(requestText).length,
    statusCode: 200,
    statusMessage: 'OK',
    responseHeaders: {
      'content-type': 'text/plain',
      'content-encoding': 'br'
    },
    responseBody: capture._safeBodyString(
      zlib.brotliCompressSync(Buffer.from(responseText)),
      'br',
      'text/plain'
    ),
    responseBodySize: zlib.brotliCompressSync(Buffer.from(responseText)).length,
    duration: 5,
    timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
    source: 'proxy'
  };
  capture._normalizeCapturedBodies(record);
  return record;
}

async function startApi(t) {
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

test('content-decoding provenance round-trips through HAR renderer and server imports', async t => {
  const record = contentDecodedRecord();
  assert.equal(record.requestBodyContentDecoded, true);
  assert.equal(record.responseBodyContentDecoded, true);

  const har = trafficToHar([record], { maskSensitive: false });
  const entry = har.log.entries[0];
  assert.equal(entry.request.postData._contentDecoded, true);
  assert.equal(entry.response.content._contentDecoded, true);

  const rendererImported = normalizeHarEntries(har, { createId: () => 'renderer-decoded' })[0];
  assert.equal(rendererImported.requestBody, record.requestBody);
  assert.equal(rendererImported.responseBody, record.responseBody);
  assert.equal(rendererImported.requestBodyContentDecoded, true);
  assert.equal(rendererImported.responseBodyContentDecoded, true);
  assert.equal(rendererImported.method, 'PROPFIND');

  const { api, port } = await startApi(t);
  const imported = await requestJson(port, 'POST', '/api/traffic/import-har', har);
  assert.equal(imported.statusCode, 200, JSON.stringify(imported.body));
  assert.equal(api.trafficLog.length, 1);
  assert.equal(api.trafficLog[0].requestBodyContentDecoded, true);
  assert.equal(api.trafficLog[0].responseBodyContentDecoded, true);
  assert.equal(api.trafficLog[0].method, 'PROPFIND');

  const reexported = trafficToHar(api.trafficLog, { maskSensitive: false }).log.entries[0];
  assert.equal(reexported.request.postData._contentDecoded, true);
  assert.equal(reexported.response.content._contentDecoded, true);
});

test('server HAR import rejects malformed decoding provenance atomically', async t => {
  const { api, port } = await startApi(t);
  const seed = contentDecodedRecord('seed');
  const seeded = await requestJson(port, 'POST', '/api/traffic/import', { requests: [seed] });
  assert.equal(seeded.statusCode, 200);
  const before = JSON.stringify(api.trafficLog);
  const validEntry = trafficToHar([contentDecodedRecord('valid')], {
    maskSensitive: false
  }).log.entries[0];

  for (const [field, mutate] of [
    ['request.postData._contentDecoded', entry => { entry.request.postData._contentDecoded = 'yes'; }],
    ['response.content._contentDecoded', entry => { entry.response.content._contentDecoded = 1; }]
  ]) {
    const first = structuredClone(validEntry);
    first.request.url = `http://first-${field.length}.example.test/`;
    const invalid = structuredClone(validEntry);
    invalid.request.url = `http://invalid-${field.length}.example.test/`;
    mutate(invalid);

    const response = await requestJson(port, 'POST', '/api/traffic/import-har', {
      log: { version: '1.2', entries: [first, invalid] }
    });
    assert.equal(response.statusCode, 400, field);
    assert.match(response.body.error, /_contentDecoded must be a boolean/, field);
    assert.equal(JSON.stringify(api.trafficLog), before, field);
  }
});

test('JSON traffic import validates and exports decoding provenance booleans', async t => {
  const { api, port } = await startApi(t);
  const record = contentDecodedRecord('json-decoded');
  const imported = await requestJson(port, 'POST', '/api/traffic/import', { requests: [record] });
  assert.equal(imported.statusCode, 200);
  assert.equal(api.trafficLog[0].requestBodyContentDecoded, true);
  assert.equal(api.trafficLog[0].responseBodyContentDecoded, true);

  const exported = await requestJson(port, 'GET', '/api/traffic/export');
  assert.equal(exported.statusCode, 200);
  const exportedRecord = exported.body.requests.find(request => request.id === record.id);
  assert.equal(exportedRecord.requestBodyContentDecoded, true);
  assert.equal(exportedRecord.responseBodyContentDecoded, true);

  const before = JSON.stringify(api.trafficLog);
  for (const field of ['requestBodyContentDecoded', 'responseBodyContentDecoded']) {
    const invalid = {
      ...contentDecodedRecord(`invalid-${field}`),
      [field]: 'yes'
    };
    const response = await requestJson(port, 'POST', '/api/traffic/import', {
      requests: [invalid]
    });
    assert.equal(response.statusCode, 400, field);
    assert.match(response.body.error, new RegExp(`${field} must be a boolean`), field);
    assert.equal(JSON.stringify(api.trafficLog), before, field);
  }
});

test('empty decoded request bodies retain HAR provenance without fake text', () => {
  const proxy = new ProxyServer(null);
  const record = contentDecodedRecord('decoded-empty');
  record.requestBody = proxy._safeBodyString(
    zlib.gzipSync(Buffer.alloc(0)),
    'gzip',
    'text/plain'
  );
  proxy._normalizeCapturedBodies(record);

  assert.equal(record.requestBody, '');
  assert.equal(record.requestBodyContentDecoded, true);
  const postData = trafficToHar([record], { maskSensitive: false }).log.entries[0].request.postData;
  assert.equal(postData._contentDecoded, true);
  assert.equal(Object.hasOwn(postData, 'text'), false);

  const imported = normalizeHarEntries({
    log: { entries: [{
      startedDateTime: '2026-01-01T00:00:00.000Z',
      request: {
        method: 'POST',
        url: 'http://decoded.example.test/empty',
        headers: [],
        postData
      },
      response: { status: 204, headers: [], content: { text: '' } }
    }] }
  }, { createId: () => 'empty-import' })[0];
  assert.equal(imported.requestBody, '');
  assert.equal(imported.requestBodyContentDecoded, true);
});
