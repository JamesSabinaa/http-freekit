import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../src/api/api-server.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const createMockStart = rendererSource.indexOf('function copyResponseHeadersForMock(');
const createMockEnd = rendererSource.indexOf('// --- Header context menu', createMockStart);
assert.ok(createMockStart >= 0 && createMockEnd > createMockStart, 'Create Mock functions must be present');
const createMockSource = rendererSource.slice(createMockStart, createMockEnd);

const cookies = [
  'session=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/',
  'theme=dark; Path=/'
];

function buildRendererSubmission() {
  const responseHeaders = {
    'Set-Cookie': [...cookies],
    'X-Scalar': 'preserved',
    Connection: 'keep-alive',
    'Transfer-Encoding': 'chunked',
    'Content-Encoding': 'gzip',
    'Content-Length': '999'
  };
  let submission;
  const context = {
    API_BASE: '',
    console,
    document: { querySelector: () => null },
    editMockRule: () => {},
    fetch: (_url, options) => {
      submission = JSON.parse(options.body);
      return Promise.resolve({ json: async () => ({ rule: {} }) });
    },
    loadMockRules: async () => {},
    requests: [{
      id: 'exchange-1',
      method: 'GET',
      host: 'mock.test',
      path: '/cookies?ignored=yes',
      responseHeaders,
      responseBody: 'mocked',
      statusCode: 200
    }],
    setTimeout: () => {},
    switchPanel: () => {},
    trafficActionRequest: requestId => context.requests.find(request => request.id === requestId),
    toast: () => {}
  };
  vm.createContext(context);
  vm.runInContext(`
    ${createMockSource}
    globalThis.copyResponseHeadersForMock = copyResponseHeadersForMock;
    globalThis.createMockFromRequest = createMockFromRequest;
  `, context);

  const copiedHeaders = context.copyResponseHeadersForMock(responseHeaders);
  context.createMockFromRequest('exchange-1');
  return { copiedHeaders, responseHeaders, submission };
}

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
        resolve({ statusCode: response.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    request.once('error', reject);
    request.end(payload || undefined);
  });
}

async function startApi(t, proxy) {
  const api = new ApiServer(proxy, null, null);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

function requestThroughProxy(port) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: 'http://mock.test/cookies',
      headers: { host: 'mock.test', connection: 'close' }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        rawHeaders: response.rawHeaders,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

test('renderer Create Mock preserves repeated response headers in independent arrays', () => {
  const { copiedHeaders, responseHeaders, submission } = buildRendererSubmission();

  assert.notEqual(copiedHeaders['Set-Cookie'], responseHeaders['Set-Cookie']);
  assert.deepEqual(Array.from(copiedHeaders['Set-Cookie']), cookies);
  responseHeaders['Set-Cookie'].push('later=value');
  assert.deepEqual(Array.from(copiedHeaders['Set-Cookie']), cookies);

  assert.deepEqual(submission.action.headers['Set-Cookie'], cookies);
  assert.equal(submission.action.headers['X-Scalar'], 'preserved');
  for (const skipped of ['Connection', 'Transfer-Encoding', 'Content-Encoding', 'Content-Length']) {
    assert.equal(Object.hasOwn(submission.action.headers, skipped), false, skipped);
  }
});

test('mock API stores repeated response header arrays without flattening', async t => {
  const proxy = new ProxyServer(null);
  const apiPort = await startApi(t, proxy);
  const { submission } = buildRendererSubmission();

  const created = await requestJson(apiPort, 'POST', '/api/mock-rules', submission);

  assert.equal(created.statusCode, 200);
  assert.deepEqual(created.body.rule.action.headers['Set-Cookie'], cookies);
  assert.deepEqual(proxy.mockRules[0].action.headers['Set-Cookie'], cookies);
  assert.equal(proxy.mockRules[0].action.headers['X-Scalar'], 'preserved');
  assert.equal(Object.hasOwn(proxy.mockRules[0].action.headers, 'Content-Length'), false);
});

test('Create Mock replay sends two distinct Set-Cookie fields end to end', async t => {
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(() => proxy.stop());
  const apiPort = await startApi(t, proxy);
  const { submission } = buildRendererSubmission();
  const created = await requestJson(apiPort, 'POST', '/api/mock-rules', submission);
  assert.equal(created.statusCode, 200);

  const response = await requestThroughProxy(proxy.server.address().port);
  const rawCookies = [];
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    if (response.rawHeaders[i].toLowerCase() === 'set-cookie') rawCookies.push(response.rawHeaders[i + 1]);
  }

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, 'mocked');
  assert.deepEqual(response.headers['set-cookie'], cookies);
  assert.deepEqual(rawCookies, cookies);
  assert.equal(response.headers['x-scalar'], 'preserved');
  assert.notEqual(response.headers['content-length'], '999');
});
