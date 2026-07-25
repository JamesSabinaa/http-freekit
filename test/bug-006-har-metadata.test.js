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
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.end(payload);
  });
}

test('HAR round trip preserves cookies, form parameters, MIME types, and protocol', async (t) => {
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
  const requestCookies = [{ name: 'request-cookie', value: 'one', path: '/' }];
  const responseCookies = [{ name: 'response-cookie', value: 'two', httpOnly: true }];
  const params = [{ name: 'field', value: 'value' }, { name: 'file', fileName: 'sample.txt' }];
  const har = {
    log: {
      entries: [{
        startedDateTime: '2026-01-01T00:00:00.000Z',
        time: 1,
        request: {
          method: 'POST',
          url: 'https://example.test/form',
          httpVersion: 'HTTP/2',
          cookies: requestCookies,
          headers: [],
          postData: { mimeType: 'multipart/form-data', params }
        },
        response: {
          status: 204,
          statusText: 'No Content',
          httpVersion: 'HTTP/2',
          cookies: responseCookies,
          headers: [],
          content: { mimeType: 'application/custom', text: '' }
        }
      }]
    }
  };

  assert.equal(await postJson(server.address().port, har), 200);
  assert.equal(api.trafficLog[0].protocol, 'h2');

  const exported = trafficToHar(api.trafficLog, { maskSensitive: false }).log.entries[0];
  assert.equal(exported.request.httpVersion, 'HTTP/2');
  assert.equal(exported.response.httpVersion, 'HTTP/2');
  assert.deepEqual(exported.request.cookies, requestCookies);
  assert.deepEqual(exported.response.cookies, responseCookies);
  assert.equal(exported.request.postData.mimeType, 'multipart/form-data');
  assert.deepEqual(exported.request.postData.params, params);
  assert.equal(exported.response.content.mimeType, 'application/custom');
});
