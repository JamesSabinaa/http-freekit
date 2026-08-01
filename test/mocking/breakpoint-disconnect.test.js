import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import { trafficToHar } from '../../src/api/har-converter.js';
import { McpServerBridge } from '../../src/mcp/mcp-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for condition'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

test('disconnecting paused HTTP clients removes their breakpoint and traffic lifecycle state', async t => {
  const proxy = new ProxyServer(null, { port: 0 });
  proxy.addBreakpoint({ matchers: [{ type: 'wildcard' }] });
  const events = [];
  const trafficBroadcasts = [];
  const api = new ApiServer(proxy, null, null);
  api._broadcast = event => trafficBroadcasts.push(structuredClone(event));
  proxy.onBreakpoint = event => events.push(event);
  proxy.onRequest = event => api.onTrafficEvent(event);
  await proxy.start();
  t.after(() => proxy.stop());

  for (let index = 0; index < 3; index++) {
    const request = http.request({
      hostname: '127.0.0.1',
      port: proxy.server.address().port,
      path: `http://127.0.0.1:9/paused-${index}`
    });
    request.on('error', () => {});
    request.end();

    await waitFor(() => proxy.pendingBreakpoints.size === 1);
    const pendingBreakpoint = proxy.getPendingBreakpoints()[0];
    const requestId = pendingBreakpoint.id;
    assert.equal(proxy._pendingTrafficLogDecisions.size, 1);
    const active = api.trafficLog.find(request =>
      request.id === requestId &&
      request.trafficLifecycleId === pendingBreakpoint.trafficLifecycleId
    );
    assert.equal(active?.statusCode, 0);
    assert.equal(active?.statusMessage, 'Breakpoint');
    assert.equal(active?.breakpointPhase, 'request');
    assert.equal(active?.breakpointActive, true);
    request.destroy();
    await waitFor(() => proxy.pendingBreakpoints.size === 0 &&
      proxy._pendingTrafficLogDecisions.size === 0);

    assert.equal(proxy.resumeBreakpoint(requestId), false);
    assert.equal(events.at(-1).type, 'breakpoint-resumed');
    assert.equal(events.at(-1).reason, 'client-disconnected');
    assert.equal(api._pendingTrafficIds.size, 0);
    const terminal = api.trafficLog.find(request => request.id === requestId);
    assert.equal(terminal?.statusCode, 0);
    assert.equal(terminal?.statusMessage, 'Client Disconnected');
    assert.equal(terminal?.breakpointActive, false);
    assert.equal(terminal?.method, 'GET');
    assert.equal(terminal?._mergeUpdate, undefined);
  }

  assert.equal(api.trafficLog.length, 3);
  assert.equal(trafficBroadcasts.filter(event => event.type === 'request-update'
    && event.data.statusMessage === 'Client Disconnected').length, 3);
});

test('proxy shutdown clears any remaining traffic lifecycle decisions', async () => {
  const proxy = new ProxyServer(null);
  proxy._pendingTrafficLogDecisions.set('abandoned-request', true);

  await proxy.stop();

  assert.equal(proxy._pendingTrafficLogDecisions.size, 0);
});

test('an evicted breakpoint disconnect remains a complete standalone traffic record', t => {
  t.mock.method(Date, 'now', () => 5_000);
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  api.maxTrafficLog = 1;
  const broadcasts = [];
  api._broadcast = event => broadcasts.push(structuredClone(event));
  proxy.onRequest = event => api.onTrafficEvent(event);

  proxy._emitPendingRequest({
    id: 'paused',
    protocol: 'http',
    method: 'POST',
    url: 'http://paused.test/original?value=1',
    host: 'paused.test',
    path: '/original?value=1',
    requestHeaders: { 'content-type': 'text/plain' },
    requestBody: 'payload',
    requestBodySize: 7,
    timestamp: 1_000,
    source: 'breakpoint',
    tls: null,
    remote: null
  });
  api.onTrafficEvent({
    id: 'evictor',
    protocol: 'http',
    method: 'GET',
    url: 'http://other.test/',
    host: 'other.test',
    path: '/',
    requestHeaders: {},
    requestBody: '',
    requestBodySize: 0,
    statusCode: 204,
    responseHeaders: {},
    responseBody: '',
    responseBodySize: 0,
    duration: 0,
    timestamp: 4_500,
    source: 'proxy'
  });
  assert.deepEqual(api.trafficLog.map(record => record.id), ['evictor']);

  let resolution;
  const client = new EventEmitter();
  client.destroyed = false;
  client.closed = false;
  proxy.pendingBreakpoints.set('paused', {
    method: 'POST',
    url: 'http://paused.test/original?value=1',
    host: 'paused.test',
    path: '/original?value=1',
    timestamp: 4_000,
    resolve: value => { resolution = value; }
  });
  proxy._setBreakpointTimeout('paused', client);
  broadcasts.length = 0;
  client.emit('close');

  assert.ok(resolution);
  assert.equal(proxy.pendingBreakpoints.size, 0);
  assert.equal(proxy._pendingTrafficLogDecisions.size, 0);
  assert.equal(api.trafficLog.length, 1);
  const terminal = api.trafficLog[0];
  assert.equal(terminal.id, 'paused');
  assert.equal(terminal.protocol, 'http');
  assert.equal(terminal.url, 'http://paused.test/original?value=1');
  assert.deepEqual(terminal.requestHeaders, { 'content-type': 'text/plain' });
  assert.equal(terminal.requestBody, 'payload');
  assert.equal(terminal.requestBodySize, 7);
  assert.equal(terminal.responseBody, '');
  assert.equal(terminal.responseBodySize, 0);
  assert.equal(terminal.timestamp, 1_000);
  assert.equal(terminal.duration, 4_000);
  assert.equal(terminal.statusCode, 0);
  assert.equal(terminal.statusMessage, 'Client Disconnected');
  assert.deepEqual(
    broadcasts.filter(event => event.type === 'request' || event.type === 'request-update')
      .map(event => event.type),
    ['request']
  );

  assert.doesNotThrow(() => trafficToHar(api.trafficLog, { maskSensitive: false }));
  const bridge = new McpServerBridge({
    apiServer: api,
    proxyServer: proxy,
    interceptorManager: {}
  });
  assert.doesNotThrow(() => bridge._handleSearchTraffic({ limit: 10 }));
});
