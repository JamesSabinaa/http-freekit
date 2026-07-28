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
      path: '/api/traffic/import',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    req.once('error', reject);
    req.end(payload);
  });
}

test('traffic import rejects records that would break HAR and MCP consumers', async (t) => {
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

  const missingTimestamp = await postJson(port, { requests: [{ id: 'x' }] });
  assert.equal(missingTimestamp.statusCode, 400);
  assert.match(missingTimestamp.body.error, /timestamp/);

  const invalidBody = await postJson(port, {
    requests: [{ id: 'x', timestamp: Date.now(), requestBody: { nested: true } }]
  });
  assert.equal(invalidBody.statusCode, 400);
  assert.match(invalidBody.body.error, /requestBody/);
  assert.deepEqual(api.trafficLog, []);

  const invalidTruncations = [
    {
      record: {
        responseBodyTruncated: true,
        responseBodyCapturedSize: 11,
        responseBodyDecodedSize: 10
      },
      error: /cannot exceed/
    },
    {
      record: {
        responseBodyTruncated: true,
        responseBodyCapturedSize: 0.5,
        responseBodyDecodedSize: 10
      },
      error: /safe integer/
    },
    {
      record: {
        responseBodyTruncated: true,
        responseBodyDecodedSize: 5
      },
      error: /responseBodyCapturedSize must be provided/
    },
    {
      record: { responseBodyCapturedSize: 5 },
      error: /requires responseBodyTruncated to be true/
    }
  ];
  for (const [index, scenario] of invalidTruncations.entries()) {
    const result = await postJson(port, {
      requests: [{
        id: `invalid-truncation-${index}`,
        timestamp: Date.now(),
        ...scenario.record
      }]
    });
    assert.equal(result.statusCode, 400);
    assert.match(result.body.error, scenario.error);
  }
  assert.deepEqual(api.trafficLog, []);

  const legacyTruncation = await postJson(port, {
    requests: [{
      id: 'legacy-truncated-upload',
      timestamp: Date.now(),
      requestBody: '[Request body omitted after exceeding 8 bytes]',
      requestBodySize: 17,
      requestBodyTruncated: true,
      requestBodyCapturedSize: 0
    }]
  });
  assert.equal(legacyTruncation.statusCode, 200);
  const legacyHar = trafficToHar([api.trafficLog.at(-1)], { maskSensitive: false });
  assert.equal(legacyHar.log.entries[0].request.postData._capturedSize, 0);
  assert.equal(legacyHar.log.entries[0].request.postData._originalSize, 17);

  const unknownOriginalSize = await postJson(port, {
    requests: [{
      id: 'unknown-original-size',
      timestamp: Date.now(),
      responseBody: 'x',
      responseBodyTruncated: true,
      responseBodyCapturedSize: 1,
      responseBodyDecodedSize: -1
    }]
  });
  assert.equal(unknownOriginalSize.statusCode, 200);
  const unknownHar = trafficToHar([api.trafficLog.at(-1)], { maskSensitive: false });
  assert.equal(unknownHar.log.entries[0].response.content._originalSize, -1);
  assert.match(unknownHar.log.entries[0].response.content.comment, /original size unknown/);

  const valid = await postJson(port, {
    requests: [{ id: 'valid', timestamp: Date.now(), requestBody: 'text' }]
  });
  assert.equal(valid.statusCode, 200);
  assert.equal(api.trafficLog.length, 3);
  assert.doesNotThrow(() => trafficToHar(api.trafficLog));
});
