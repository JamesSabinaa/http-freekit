import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../src/api/api-server.js';
import { trafficToHar } from '../src/api/har-converter.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const rendererStyles = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'styles.css'), 'utf8');

function postJson(port, pathname, body) {
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

async function createApi(t) {
  const proxy = new ProxyServer(null);
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

test('large text captures retain bounded previews and export explicit HAR truncation metadata', () => {
  let captured;
  const proxy = new ProxyServer(null, { onRequest: request => { captured = request; } });
  const body = Buffer.alloc(1024 * 1024, 0x61);

  proxy._emitRequest({
    id: 'large-text',
    timestamp: 0,
    method: 'GET',
    url: 'http://example.test/',
    responseHeaders: { 'content-type': 'text/plain' },
    responseBody: proxy._safeBodyString(body, undefined, 'text/plain'),
    responseBodySize: body.length
  });

  assert.equal(Buffer.byteLength(captured.responseBody), 512 * 1024);
  assert.equal(captured.responseBodyTruncated, true);
  assert.equal(captured.responseBodyCapturedSize, 512 * 1024);
  assert.equal(captured.responseBodyDecodedSize, body.length);

  const response = trafficToHar([captured], { maskSensitive: false }).log.entries[0].response;
  assert.equal(Buffer.byteLength(response.content.text), 512 * 1024);
  assert.equal(response.content.size, 512 * 1024);
  assert.equal(response.bodySize, body.length);
  assert.equal(response.content._truncated, true);
  assert.equal(response.content._capturedSize, 512 * 1024);
  assert.equal(response.content._originalSize, body.length);
  assert.match(response.content.comment, /524288 of 1048576 bytes retained/);
});

test('omitted large binary captures are not exported as fake HAR body text', () => {
  let captured;
  const proxy = new ProxyServer(null, { onRequest: request => { captured = request; } });
  const body = Buffer.alloc(2 * 1024 * 1024, 0);

  proxy._emitRequest({
    id: 'large-binary',
    timestamp: 0,
    method: 'GET',
    url: 'http://example.test/',
    responseHeaders: { 'content-type': 'application/octet-stream' },
    responseBody: proxy._safeBodyString(body, undefined, 'application/octet-stream'),
    responseBodySize: body.length
  });

  assert.equal(captured.responseBody, `[Binary data: ${body.length} bytes]`);
  assert.equal(captured.responseBodyTruncated, true);
  assert.equal(captured.responseBodyCapturedSize, 0);

  const response = trafficToHar([captured], { maskSensitive: false }).log.entries[0].response;
  assert.equal(response.content.text, '');
  assert.equal(response.content.size, 0);
  assert.equal(response.bodySize, body.length);
  assert.equal(response.content._truncated, true);
  assert.equal(response.content._capturedSize, 0);
  assert.equal(response.content._originalSize, body.length);
});

test('server HAR import preserves request and response truncation across re-export', async t => {
  const { api, port } = await createApi(t);
  const source = {
    id: 'truncated-round-trip',
    timestamp: Date.parse('2026-01-01T00:00:00.000Z'),
    method: 'POST',
    url: 'https://example.test/upload',
    requestHeaders: { 'content-type': 'text/plain' },
    requestBody: 'request preview',
    requestBodyEncoding: 'utf8',
    requestBodySize: 1000,
    requestBodyTruncated: true,
    requestBodyCapturedSize: 15,
    requestBodyDecodedSize: 1000,
    statusCode: 200,
    statusMessage: 'OK',
    responseHeaders: { 'content-type': 'text/plain' },
    responseBody: 'response preview',
    responseBodyEncoding: 'utf8',
    responseBodySize: 2000,
    responseBodyTruncated: true,
    responseBodyCapturedSize: 16,
    responseBodyDecodedSize: 2000,
    duration: 1
  };
  const har = trafficToHar([source], { maskSensitive: false });

  const result = await postJson(port, '/api/traffic/import-har', har);

  assert.equal(result.statusCode, 200, result.body?.error);
  const imported = api.trafficLog[0];
  assert.equal(imported.requestBodyTruncated, true);
  assert.equal(imported.requestBodyCapturedSize, 15);
  assert.equal(imported.requestBodyDecodedSize, 1000);
  assert.equal(imported.responseBodyTruncated, true);
  assert.equal(imported.responseBodyCapturedSize, 16);
  assert.equal(imported.responseBodyDecodedSize, 2000);

  const reexported = trafficToHar([imported], { maskSensitive: false }).log.entries[0];
  assert.deepEqual(
    {
      truncated: reexported.request.postData._truncated,
      captured: reexported.request.postData._capturedSize,
      original: reexported.request.postData._originalSize
    },
    { truncated: true, captured: 15, original: 1000 }
  );
  assert.deepEqual(
    {
      truncated: reexported.response.content._truncated,
      captured: reexported.response.content._capturedSize,
      original: reexported.response.content._originalSize,
      size: reexported.response.content.size
    },
    { truncated: true, captured: 16, original: 2000, size: 16 }
  );
});

test('server HAR import rejects malformed truncation extensions', async t => {
  const { api, port } = await createApi(t);
  const makeHar = truncation => ({
    log: {
      entries: [{
        startedDateTime: '2026-01-01T00:00:00.000Z',
        time: 1,
        request: {
          method: 'GET',
          url: 'https://example.test/',
          headers: [],
          bodySize: 0
        },
        response: {
          status: 200,
          statusText: 'OK',
          headers: [],
          bodySize: 10,
          content: { text: 'preview', size: 7, ...truncation }
        }
      }]
    }
  });

  const nonBoolean = await postJson(port, '/api/traffic/import-har', makeHar({
    _truncated: 'yes',
    _capturedSize: 7,
    _originalSize: 10
  }));
  const inverted = await postJson(port, '/api/traffic/import-har', makeHar({
    _truncated: true,
    _capturedSize: 11,
    _originalSize: 10
  }));

  assert.equal(nonBoolean.statusCode, 400);
  assert.match(nonBoolean.body.error, /_truncated must be a boolean/);
  assert.equal(inverted.statusCode, 400);
  assert.match(inverted.body.error, /_capturedSize cannot exceed _originalSize/);
  assert.deepEqual(api.trafficLog, []);
});

test('renderer warns about incomplete bodies and blocks unsafe derived actions', () => {
  const warningStart = rendererSource.indexOf('function renderBodyCaptureWarning(');
  const warningEnd = rendererSource.indexOf('const content = document.getElementById', warningStart);
  const resendStart = rendererSource.indexOf('function resendSelectedRequest(');
  const resendEnd = rendererSource.indexOf('// Track collapsed state', resendStart);
  const mockStart = rendererSource.indexOf('function copyResponseHeadersForMock(');
  const mockEnd = rendererSource.indexOf('// --- Header context menu', mockStart);
  assert.ok(warningStart >= 0 && warningEnd > warningStart);
  assert.ok(resendStart >= 0 && resendEnd > resendStart);
  assert.ok(mockStart >= 0 && mockEnd > mockStart);

  const toasts = [];
  const context = {
    selectedRequestId: 'truncated',
    requests: [{
      id: 'truncated',
      requestBodyTruncated: true,
      requestBodyCapturedSize: 15,
      requestBodyDecodedSize: 1000,
      responseBodyTruncated: true,
      responseBodyCapturedSize: 16,
      responseBodyDecodedSize: 2000
    }],
    formatSize: size => `${size}B`,
    fetch: () => { throw new Error('unsafe action reached fetch'); },
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(`
    ${rendererSource.slice(warningStart, warningEnd)}
    ${rendererSource.slice(resendStart, resendEnd)}
    ${rendererSource.slice(mockStart, mockEnd)}
    globalThis.warning = renderBodyCaptureWarning(requests[0], 'response');
    resendSelectedRequest();
    createMockFromRequest('truncated');
  `, context);

  assert.match(context.warning, /Incomplete response body: 16B of 2000B retained/);
  assert.match(context.warning, /Viewing and body search use only these captured bytes/);
  assert.deepEqual(toasts, [
    {
      message: 'Cannot resend this request because its captured body is incomplete.',
      type: 'error'
    },
    {
      message: 'Cannot create a mock because this exchange contains an incomplete body capture.',
      type: 'error'
    }
  ]);
  assert.match(rendererSource, /body search covers captured bytes only/);
  assert.match(rendererSource, /class="row-truncated-body"/);
  assert.match(rendererStyles, /\.body-capture-warning\s*\{/);
});
