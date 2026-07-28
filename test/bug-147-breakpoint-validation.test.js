import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

function requestJson(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
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

async function createServer(t) {
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { proxy, port: server.address().port };
}

test('breakpoint API rejects non-array matcher state', async t => {
  const { proxy, port } = await createServer(t);
  const result = await requestJson(port, 'POST', '/api/breakpoints', { matchers: {} });

  assert.equal(result.statusCode, 400);
  assert.deepEqual(proxy.breakpointRules, []);
});

test('breakpoint API rejects incomplete matcher fields', async t => {
  const { proxy, port } = await createServer(t);
  const invalidMatchers = [
    { type: 'method', value: 42 },
    { type: 'header', value: 'present' },
    { type: 'not-a-matcher', value: 'GET' },
    { type: 'regex-url' }
  ];

  for (const matcher of invalidMatchers) {
    const result = await requestJson(port, 'POST', '/api/breakpoints', {
      matchers: [matcher]
    });
    assert.equal(result.statusCode, 400);
  }

  assert.deepEqual(proxy.breakpointRules, []);
});

test('persisted breakpoints with incomplete matcher fields are discarded', () => {
  const proxy = new ProxyServer(null);
  const restored = proxy.loadBreakpoints([
    { id: 'bad-method', matchers: [{ type: 'method', value: {} }] },
    { id: 'bad-header', matchers: [{ type: 'header', value: 'present' }] },
    { id: 'valid', matchers: [{ type: 'method', value: 'GET' }] }
  ]);

  assert.equal(restored.migrated, true);
  assert.equal(restored.discarded, 2);
  assert.deepEqual(restored.rules.map(rule => rule.id), ['valid']);
});

test('persisted malformed breakpoint state is ignored at runtime', () => {
  const proxy = new ProxyServer(null);
  proxy.breakpointRules = [
    { enabled: true, matchers: {} },
    { enabled: true, matchers: [null] },
    { enabled: true, matchers: [{ type: 'method', value: {} }] },
    { enabled: true, matchers: [{ type: 'regex-url', value: '[' }] }
  ];

  assert.doesNotThrow(() => proxy._checkBreakpoint('GET', 'https://example.test', {}));
  assert.equal(proxy._checkBreakpoint('GET', 'https://example.test', {}), undefined);
});

test('invalid resume methods and headers are rejected without releasing the breakpoint', async t => {
  const { proxy, port } = await createServer(t);
  let resolved = false;
  proxy.pendingBreakpoints.set('pending', { resolve: () => { resolved = true; } });

  const method = await requestJson(port, 'POST', '/api/breakpoints/pending/pending/resume', {
    method: 'GET\r\nInjected: yes'
  });
  const header = await requestJson(port, 'POST', '/api/breakpoints/pending/pending/resume', {
    headers: { 'X-Test': 'safe\r\nInjected: yes' }
  });

  assert.equal(method.statusCode, 400);
  assert.equal(header.statusCode, 400);
  assert.equal(resolved, false);
  assert.equal(proxy.pendingBreakpoints.has('pending'), true);
});

test('invalid resume bodies and statuses do not release the breakpoint', async t => {
  const { proxy, port } = await createServer(t);
  let resolved = false;
  proxy.pendingBreakpoints.set('pending', { resolve: () => { resolved = true; } });

  const invalidPayloads = [
    { body: { nested: 'value' } },
    { body: null },
    { status: 199 },
    { statusCode: 100 },
    { status: 600 },
    { statusCode: 999 },
    { url: 42 }
  ];
  for (const payload of invalidPayloads) {
    const result = await requestJson(
      port,
      'POST',
      '/api/breakpoints/pending/pending/resume',
      payload
    );
    assert.equal(result.statusCode, 400);
  }

  assert.equal(resolved, false);
  assert.equal(proxy.pendingBreakpoints.has('pending'), true);
});

test('resume bodies accept strings and reject buffers', () => {
  const proxy = new ProxyServer(null);
  const resumed = [];
  proxy.pendingBreakpoints.set('string', { resolve: value => resumed.push(value.body) });
  proxy.pendingBreakpoints.set('buffer', { resolve: value => resumed.push(value.body) });

  assert.equal(proxy.resumeBreakpoint('string', { body: 'updated' }), true);
  assert.equal(proxy.resumeBreakpoint('buffer', { body: Buffer.from('binary') }), false);
  assert.equal(resumed[0], 'updated');
  assert.equal(resumed.length, 1);
  assert.equal(proxy.pendingBreakpoints.has('buffer'), true);
});

test('native H2 breakpoint responses strip connection-specific headers', async () => {
  const captures = [];
  let proxy;
  proxy = new ProxyServer(null, {
    onRequest: request => captures.push(request),
    onBreakpoint: event => {
      if (event.type !== 'breakpoint-hit') return;
      setImmediate(() => proxy.resumeBreakpoint(event.requestId, {
        status: 202,
        headers: {
          connection: 'x-remove',
          'keep-alive': 'timeout=5',
          'x-remove': 'nominated',
          'x-safe': 'yes'
        },
        body: 'safe response'
      }));
    }
  });
  const stream = new EventEmitter();
  stream.destroyed = false;
  stream.closed = false;
  let sentHeaders;
  let sentBody;
  stream.respond = headers => { sentHeaders = headers; };
  stream.end = body => { sentBody = body; };

  await proxy._handleH2MockResponse(
    stream,
    { action: { type: 'breakpoint-response' } },
    {
      requestId: 'h2-breakpoint',
      requestTrailers: {},
      startTime: Date.now(),
      tlsDetails: null,
      downstream: {},
      method: 'GET',
      fullUrl: 'https://example.test/',
      authority: 'example.test',
      path: '/',
      reqHeaders: {
        ':method': 'GET',
        ':path': '/',
        ':authority': 'example.test',
        ':scheme': 'https'
      },
      body: Buffer.alloc(0),
      pendingEmitted: false
    }
  );

  assert.deepEqual(sentHeaders, {
    ':status': 202,
    'x-safe': 'yes',
    'content-length': String(Buffer.byteLength('safe response'))
  });
  assert.equal(sentBody, 'safe response');
  assert.equal(captures.at(-1).responseHeaders.connection, undefined);
  assert.equal(captures.at(-1).responseHeaders['keep-alive'], undefined);
  assert.equal(captures.at(-1).responseHeaders['x-remove'], undefined);
  assert.equal(captures.at(-1).responseHeaders['x-safe'], 'yes');
});
