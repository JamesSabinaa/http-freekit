import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { ApiServer } from '../src/api/api-server.js';
import { trafficToHar } from '../src/api/har-converter.js';

function postJson(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/traffic/import-har',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end(payload);
  });
}

test('HAR import and export preserve base64 bodies and duplicate headers', async (t) => {
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
  const literalRequestBody = 'data:text/plain;base64,SGVsbG8=';
  const literalResponseBody = 'data:text/plain;base64,V29ybGQ=';
  const har = {
    log: {
      entries: [{
        startedDateTime: '2026-01-01T00:00:00.000Z',
        time: 5,
        request: {
          method: 'POST',
          url: 'https://example.test/binary',
          headers: [
            { name: 'Content-Type', value: 'application/octet-stream' },
            { name: 'X-Value', value: 'one' },
            { name: 'X-Value', value: 'two' }
          ],
          postData: { mimeType: 'application/octet-stream', text: 'AQID', encoding: 'base64' }
        },
        response: {
          status: 200,
          statusText: 'OK',
          headers: [
            { name: 'Content-Type', value: 'application/octet-stream' },
            { name: 'Set-Cookie', value: 'a=1; Path=/' },
            { name: 'Set-Cookie', value: 'b=2; Path=/' }
          ],
          content: { mimeType: 'application/octet-stream', text: 'BAUG', encoding: 'base64', size: 3 }
        }
      }, {
        startedDateTime: '2026-01-01T00:00:01.000Z',
        time: 2,
        request: {
          method: 'POST',
          url: 'https://example.test/literal',
          headers: [{ name: 'Content-Type', value: 'text/plain' }],
          postData: { mimeType: 'text/plain', text: literalRequestBody }
        },
        response: {
          status: 200,
          statusText: 'OK',
          headers: [{ name: 'Content-Type', value: 'text/plain' }],
          content: {
            mimeType: 'text/plain',
            text: literalResponseBody,
            size: Buffer.byteLength(literalResponseBody)
          }
        }
      }]
    }
  };

  const response = await postJson(port, har);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(api.trafficLog[0].requestHeaders['x-value'], ['one', 'two']);
  assert.deepEqual(api.trafficLog[0].responseHeaders['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
  assert.equal(api.trafficLog[0].requestBody, 'data:application/octet-stream;base64,AQID');
  assert.equal(api.trafficLog[0].responseBody, 'data:application/octet-stream;base64,BAUG');
  assert.equal(api.trafficLog[0].requestBodyEncoding, 'base64');
  assert.equal(api.trafficLog[0].responseBodyEncoding, 'base64');
  assert.equal(api.trafficLog[1].requestBody, literalRequestBody);
  assert.equal(api.trafficLog[1].responseBody, literalResponseBody);
  assert.equal(api.trafficLog[1].requestBodyEncoding, 'utf8');
  assert.equal(api.trafficLog[1].responseBodyEncoding, 'utf8');

  const exportedEntries = trafficToHar(api.trafficLog, { maskSensitive: false }).log.entries;
  const exported = exportedEntries[0];
  assert.deepEqual(exported.request.headers.filter(header => header.name === 'x-value'), [
    { name: 'x-value', value: 'one' },
    { name: 'x-value', value: 'two' }
  ]);
  assert.deepEqual(exported.response.headers.filter(header => header.name === 'set-cookie'), [
    { name: 'set-cookie', value: 'a=1; Path=/' },
    { name: 'set-cookie', value: 'b=2; Path=/' }
  ]);
  assert.deepEqual(exported.request.postData, {
    mimeType: 'application/octet-stream',
    text: 'AQID',
    encoding: 'base64'
  });
  assert.equal(exported.response.content.text, 'BAUG');
  assert.equal(exported.response.content.encoding, 'base64');
  assert.equal(exportedEntries[1].request.postData.text, literalRequestBody);
  assert.equal(Object.hasOwn(exportedEntries[1].request.postData, 'encoding'), false);
  assert.equal(exportedEntries[1].response.content.text, literalResponseBody);
  assert.equal(Object.hasOwn(exportedEntries[1].response.content, 'encoding'), false);
});
