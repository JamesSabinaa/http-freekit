import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import { trafficToHar } from '../../src/api/har-converter.js';

function requestJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
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

function nativeRecord(id, overrides = {}) {
  return {
    id,
    timestamp: Date.now(),
    method: 'POST',
    url: 'http://binary.test/',
    ...overrides
  };
}

function harEntry(postData) {
  return {
    startedDateTime: new Date().toISOString(),
    time: 0,
    request: {
      method: 'POST',
      url: 'http://binary.test/',
      httpVersion: 'HTTP/1.1',
      headers: [],
      bodySize: 3,
      postData
    },
    response: {
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      headers: [],
      bodySize: 0,
      content: { text: '', mimeType: 'text/plain', size: 0 }
    }
  };
}

test('traffic imports reject malformed base64 provenance atomically and preserve valid bytes', async t => {
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
  const port = server.address().port;

  for (const requestBody of [
    'AQID',
    'data:application/octet-stream;base64,AQ=',
    'data:application/octet-stream;BASE64,AQID',
    'data:application/octet-stream;base64,AQID\n'
  ]) {
    const invalid = await requestJson(port, '/api/traffic/import', {
      requests: [
        nativeRecord('would-be-valid'),
        nativeRecord('invalid-binary', { requestBody, requestBodyEncoding: 'base64' })
      ]
    });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.body.error, /canonical base64 data URI/);
    assert.deepEqual(api.trafficLog, []);
  }

  const invalidHar = await requestJson(port, '/api/traffic/import-har', {
    log: { entries: [harEntry({
      mimeType: 'application/octet-stream',
      text: 'AQ=',
      encoding: 'base64'
    })] }
  });
  assert.equal(invalidHar.statusCode, 400);
  assert.match(invalidHar.body.error, /canonical base64 data URI/);
  assert.deepEqual(api.trafficLog, []);

  const valid = await requestJson(port, '/api/traffic/import', {
    requests: [nativeRecord('valid-binary', {
      requestBody: 'data:application/octet-stream;base64,AQID',
      requestBodyEncoding: 'base64'
    })]
  });
  assert.equal(valid.statusCode, 200);
  const har = trafficToHar(api.trafficLog, { maskSensitive: false });
  assert.equal(har.log.entries[0].request.postData.text, 'AQID');
  assert.equal(har.log.entries[0].request.postData.encoding, 'base64');
});
