import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ProxyServer } from '../../src/proxy/proxy-server.js';
import { normalizeHarEntries } from '../../src/ui/har-import.js';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = rendererSource.indexOf(startMarker);
  const end = rendererSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} source must be present`);
  return rendererSource.slice(start, end);
}

const createMockSource = sourceBetween(
  'function copyResponseHeadersForMock(',
  '// --- Header context menu'
);
const createBreakpointSource = sourceBetween(
  'function createBreakpointFromRequest(',
  'function toast('
);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function captureNativeIpv4Request() {
  const origin = http.createServer((request, response) => {
    request.resume();
    response.setHeader('x-derived-rule', 'native');
    response.end('native response');
  });
  const originPort = await listen(origin);
  const events = [];
  const proxy = new ProxyServer(null, {
    port: 0,
    onRequest: event => events.push(event)
  });
  await proxy.start();

  try {
    const url = `http://127.0.0.1:${originPort}/native/path?ignored=yes`;
    await new Promise((resolve, reject) => {
      const request = http.get({
        hostname: '127.0.0.1',
        port: proxy.server.address().port,
        path: url,
        headers: { host: `127.0.0.1:${originPort}`, connection: 'close' }
      }, response => {
        response.resume();
        response.once('end', resolve);
      });
      request.once('error', reject);
    });
    const completed = events.findLast(event => event.statusCode === 200);
    assert.ok(completed, 'the native proxy request must produce a completed capture');
    assert.equal(completed.url, url);
    assert.equal(completed.host, '127.0.0.1');
    return completed;
  } finally {
    await proxy.stop();
    await close(origin);
  }
}

function harRequest(url, { method = 'GET', requestBody = '', responseBody = 'imported response' } = {}) {
  const entry = {
    startedDateTime: '2026-01-01T00:00:00.000Z',
    time: 12,
    request: {
      method,
      url,
      httpVersion: 'HTTP/1.1',
      headers: [],
      bodySize: Buffer.byteLength(requestBody),
      ...(requestBody ? {
        postData: {
          mimeType: 'application/json',
          text: requestBody
        }
      } : {})
    },
    response: {
      status: 207,
      statusText: 'Multi-Status',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'X-Derived-Rule', value: 'imported' }],
      bodySize: Buffer.byteLength(responseBody),
      content: {
        mimeType: 'text/plain',
        size: Buffer.byteLength(responseBody),
        text: responseBody
      }
    }
  };
  return normalizeHarEntries({ log: { version: '1.2', entries: [entry] } }, {
    createId: () => `har-${new URL(url).hostname}`
  })[0];
}

async function deriveRendererRules(request) {
  const submissions = new Map();
  const context = {
    API_BASE: '',
    console,
    document: { querySelector: () => null },
    editMockRule() {},
    async fetch(url, options) {
      submissions.set(url, JSON.parse(options.body));
      return { ok: true, json: async () => ({ rule: {} }) };
    },
    async loadMockRules() {},
    async loadBreakpointRules() {},
    requests: [request],
    setTimeout() {},
    switchPanel() {},
    trafficActionRequest: requestId => requestId === request.id ? request : null,
    toast() {},
    mockSaveInProgress: false,
    mockRevertInProgress: false,
    mockResetInProgress: false,
    mockCollectionMutationCount: 0,
    _queueMockCollectionMutation: mutation => mutation()
  };
  vm.createContext(context);
  vm.runInContext(`
    let breakpointRulesLoadGeneration = 0;
    ${createMockSource}
    ${createBreakpointSource}
    globalThis.createMockFromRequestForTest = createMockFromRequest;
    globalThis.createBreakpointFromRequestForTest = createBreakpointFromRequest;
  `, context);

  await context.createMockFromRequestForTest(request.id);
  await context.createBreakpointFromRequestForTest(request.id);
  assert.equal(submissions.size, 2);
  return {
    mock: submissions.get('/api/mock-rules'),
    breakpoint: submissions.get('/api/breakpoints')
  };
}

async function assertDerivedRulesMatch(request, { oldHostMatcherMatches = false } = {}) {
  const derived = await deriveRendererRules(request);
  const mockHostname = derived.mock.matchers.find(matcher => matcher.type === 'hostname');
  const breakpointHostname = derived.breakpoint.matchers.find(matcher => matcher.type === 'hostname');
  assert.deepEqual(mockHostname, { type: 'hostname', value: request.host });
  assert.deepEqual(breakpointHostname, mockHostname);
  assert.equal(derived.mock.matchers.some(matcher => matcher.type === 'host'), false);
  assert.equal(derived.breakpoint.matchers.some(matcher => matcher.type === 'host'), false);

  assert.deepEqual(
    derived.mock.matchers.find(matcher => matcher.type === 'method'),
    { type: 'method', value: request.method }
  );
  assert.deepEqual(
    derived.mock.matchers.find(matcher => matcher.type === 'path'),
    { type: 'path', value: new URL(request.url).pathname, matchType: 'exact' }
  );
  const bodyMatchers = derived.mock.matchers.filter(matcher =>
    matcher.type === 'json-body-includes' || matcher.type === 'body-contains'
  );
  if (request.requestBody) {
    assert.deepEqual(bodyMatchers, [{
      type: 'json-body-includes',
      value: request.requestBody
    }]);
  } else {
    assert.deepEqual(bodyMatchers, []);
  }
  assert.equal(derived.mock.action.type, 'fixed-response');
  assert.equal(derived.mock.action.status, request.statusCode);
  assert.equal(derived.mock.action.body, request.responseBody || '');

  const runtime = new ProxyServer(null);
  const storedMock = runtime.addMockRule(structuredClone(derived.mock));
  const storedBreakpoint = runtime.addBreakpoint(structuredClone(derived.breakpoint));
  const headers = request.requestHeaders || {};
  const body = request.requestBody || '';
  assert.equal(
    runtime._findMockRule(request.method, request.url, headers, body),
    storedMock,
    `derived mock must match ${request.url}`
  );
  assert.equal(
    runtime._checkBreakpoint(request.method, request.url, headers, body),
    storedBreakpoint,
    `derived breakpoint must match ${request.url}`
  );
  assert.equal(
    runtime._evaluateMatcher(
      { type: 'host', value: request.host },
      request.method,
      request.url,
      headers,
      body
    ),
    oldHostMatcherMatches,
    'the regression must distinguish authority matching from hostname matching'
  );
}

test('rules derived from a native IPv4 capture match its non-default port', async () => {
  const captured = await captureNativeIpv4Request();

  await assertDerivedRulesMatch(captured);
});

test('rules derived from renderer HAR imports match non-default DNS and IPv6 ports', async () => {
  const imported = [
    harRequest('http://dev.example.test:3000/api/items?ignored=yes', {
      method: 'POST',
      requestBody: '{"include":"all"}'
    }),
    harRequest('http://[2001:db8::5]:4567/ipv6/resource', {
      method: 'PUT',
      requestBody: '{"version":6}'
    })
  ];

  assert.deepEqual(imported.map(request => request.host), [
    'dev.example.test',
    '[2001:db8::5]'
  ]);
  for (const request of imported) await assertDerivedRulesMatch(request);
});

test('derived hostname rules retain ordinary and explicit default-port matching', async () => {
  for (const url of [
    'http://ordinary.example.test/resource',
    'http://ordinary.example.test:80/resource',
    'https://secure.example.test:443/resource'
  ]) {
    await assertDerivedRulesMatch(harRequest(url), { oldHostMatcherMatches: true });
  }
});
