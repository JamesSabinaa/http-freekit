import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
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

async function waitForCapture(captures, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const capture = captures.find(predicate);
    if (capture) return capture;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for an incomplete body capture: ${JSON.stringify(captures)}`);
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

test('large interrupted prefixes export only bytes retained in the capture', () => {
  const captures = [];
  const proxy = new ProxyServer(null, { onRequest: request => captures.push(request) });
  const cases = [
    {
      id: 'interrupted-large-text',
      prefix: Buffer.alloc(1024 * 1024, 0x61),
      originalSize: 2 * 1024 * 1024,
      contentType: 'text/plain',
      expectedCapturedSize: 512 * 1024,
      expectedTextSize: 512 * 1024
    },
    {
      id: 'interrupted-large-binary',
      prefix: Buffer.alloc(3 * 1024 * 1024, 0),
      originalSize: 4 * 1024 * 1024,
      contentType: 'application/octet-stream',
      expectedCapturedSize: 0,
      expectedTextSize: 0
    }
  ];

  for (const scenario of cases) {
    const collector = proxy._createBodyCollector();
    proxy._appendBodyChunk(collector, scenario.prefix);
    const headers = {
      'content-type': scenario.contentType,
      'content-length': String(scenario.originalSize)
    };
    const body = proxy._streamedCaptureBody(
      collector,
      scenario.prefix.length,
      'Response',
      headers
    );
    proxy._emitRequest({
      id: scenario.id,
      timestamp: 0,
      method: 'GET',
      url: `http://example.test/${scenario.id}`,
      responseHeaders: headers,
      responseBody: body,
      responseBodySize: scenario.prefix.length,
      ...proxy._incompleteBodyCaptureFields(
        'response',
        body,
        headers,
        collector.length
      )
    });

    const captured = captures.at(-1);
    assert.equal(captured.responseBodyCapturedSize, scenario.expectedCapturedSize);
    assert.equal(captured.responseBodyDecodedSize, scenario.originalSize);
    const response = trafficToHar([captured], { maskSensitive: false })
      .log.entries[0].response;
    assert.equal(response.content._capturedSize, scenario.expectedCapturedSize);
    assert.equal(Buffer.byteLength(response.content.text), scenario.expectedTextSize);
  }
});

test('premature upstream responses retain small captured prefixes as incomplete', async t => {
  const origin = net.createServer(socket => {
    socket.once('data', () => {
      socket.end(
        'HTTP/1.1 200 OK\r\n' +
        'Content-Type: text/plain\r\n' +
        'Content-Length: 1000\r\n' +
        'Connection: close\r\n\r\n' +
        'partial'
      );
    });
  });
  origin.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    origin.once('listening', resolve);
    origin.once('error', reject);
  });

  const captures = [];
  const proxy = new ProxyServer(null, {
    port: 0,
    onRequest: capture => captures.push(capture)
  });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await new Promise(resolve => origin.close(resolve));
  });

  const client = net.connect(proxy.server.address().port, '127.0.0.1');
  client.on('error', () => {});
  t.after(() => client.destroy());
  await new Promise(resolve => client.once('connect', resolve));
  client.write(
    `GET http://127.0.0.1:${origin.address().port}/partial HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${origin.address().port}\r\n` +
    'Connection: close\r\n\r\n'
  );

  const captured = await waitForCapture(
    captures,
    capture => capture.path === '/partial' && !capture._pending
  );
  client.destroy();
  assert.equal(captured.responseBody, 'partial');
  assert.equal(captured.responseBodySize, 7);
  assert.equal(captured.responseBodyTruncated, true);
  assert.equal(captured.responseBodyCapturedSize, 7);
  assert.equal(captured.responseBodyDecodedSize, 1000);

  const harResponse = trafficToHar([captured], { maskSensitive: false })
    .log.entries[0].response;
  assert.equal(harResponse.content._capturedSize, 7);
  assert.equal(harResponse.content._originalSize, 1000);
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

  const unknownOriginalSize = await postJson(port, '/api/traffic/import-har', makeHar({
    _truncated: true,
    _capturedSize: 7,
    _originalSize: -1
  }));
  assert.equal(unknownOriginalSize.statusCode, 200, unknownOriginalSize.body?.error);
  assert.equal(api.trafficLog[0].responseBodyDecodedSize, -1);
  const reexported = trafficToHar(api.trafficLog, { maskSensitive: false })
    .log.entries[0].response.content;
  assert.equal(reexported._originalSize, -1);
  assert.match(reexported.comment, /original size unknown/);
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
    globalThis.unknownWarning = renderBodyCaptureWarning({
      responseBodyTruncated: true,
      responseBodyCapturedSize: 7,
      responseBodyDecodedSize: -1,
      responseBodySize: 7
    }, 'response');
    resendSelectedRequest();
    createMockFromRequest('truncated');
  `, context);

  assert.match(context.warning, /Incomplete response body: 16B of 2000B retained/);
  assert.match(context.warning, /Viewing and body search use only these captured bytes/);
  assert.match(context.unknownWarning, /7B; original size unknown retained/);
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
