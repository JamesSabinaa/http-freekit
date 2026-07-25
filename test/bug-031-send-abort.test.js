import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { ApiServer } from '../src/api/api-server.js';

test('aborting a Send request closes the outbound connection', async (t) => {
  let resolveStarted;
  let resolveClosed;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const server = http.createServer((req) => {
    resolveStarted();
    req.socket.once('close', resolveClosed);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const controller = new AbortController();
  const request = ApiServer.prototype._sendRequest.call(
    {},
    `http://127.0.0.1:${server.address().port}/slow`,
    'POST',
    {},
    'payload',
    'utf8',
    controller.signal
  );

  await started;
  controller.abort();

  await assert.rejects(request, error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'ABORT_ERR');
    return true;
  });
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('outbound socket stayed open')), 1000))
  ]);
});

test('an already-aborted Send signal does not open a connection', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    ApiServer.prototype._sendRequest.call(
      {},
      'http://127.0.0.1:1/never-connect',
      'GET',
      {},
      '',
      'utf8',
      controller.signal
    ),
    { name: 'AbortError', code: 'ABORT_ERR' }
  );
});

test('disconnecting from the Send API aborts its outbound request', async (t) => {
  let resolveStarted;
  let resolveClosed;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const destination = http.createServer((req) => {
    resolveStarted();
    req.socket.once('close', resolveClosed);
  });
  await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => destination.close(resolve)));

  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null);
  api.port = 0;
  await api.start();
  t.after(() => api.stop());

  const payload = JSON.stringify({
    url: `http://127.0.0.1:${destination.address().port}/slow`,
    method: 'POST',
    body: 'payload'
  });
  const client = http.request({
    hostname: '127.0.0.1',
    port: api.httpServer.address().port,
    path: '/api/send',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload)
    }
  });
  client.once('error', () => {});
  client.end(payload);

  await started;
  client.destroy();
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('API outbound socket stayed open')), 1000))
  ]);
});
