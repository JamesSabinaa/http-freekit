import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiServer, DEFAULT_MAX_WS_BUFFERED_BYTES } from '../src/api/api-server.js';

function createApi(options = {}) {
  return new ApiServer({
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  }, null, null, options);
}

class FakeClient {
  constructor({ bufferedAmount = 0, throwOnSend = false, deferCallback = false,
    throwOnTerminate = false } = {}) {
    this.readyState = 1;
    this.bufferedAmount = bufferedAmount;
    this.throwOnSend = throwOnSend;
    this.deferCallback = deferCallback;
    this.throwOnTerminate = throwOnTerminate;
    this.sent = [];
    this.sendCallback = null;
    this.terminateCalls = 0;
  }

  send(data, callback) {
    if (this.throwOnSend) throw new Error('send failed synchronously');
    this.sent.push(data);
    if (this.deferCallback) this.sendCallback = callback;
    else callback();
  }

  terminate() {
    this.terminateCalls++;
    if (this.throwOnTerminate) throw new Error('terminate failed');
  }
}

test('slow WebSocket clients are evicted before their queued bytes exceed the cap', () => {
  assert.equal(DEFAULT_MAX_WS_BUFFERED_BYTES, 16 * 1024 * 1024);
  const message = { type: 'request', data: { id: 'one', body: 'payload' } };
  const messageBytes = Buffer.byteLength(JSON.stringify(message));
  const api = createApi({ maxWsBufferedBytes: messageBytes + 4 });
  const slow = new FakeClient({ bufferedAmount: 5 });
  const healthy = new FakeClient();
  api.clients.add(slow);
  api.clients.add(healthy);

  api._broadcast(message);

  assert.equal(api.maxWsBufferedBytes, messageBytes + 4);
  assert.equal(slow.terminateCalls, 1);
  assert.deepEqual(slow.sent, []);
  assert.equal(api.clients.has(slow), false);
  assert.equal(api.clients.has(healthy), true);
  assert.deepEqual(healthy.sent.map(payload => JSON.parse(payload)), [message]);
});

test('a synchronous send failure cannot prevent delivery to healthy clients', () => {
  const api = createApi();
  const broken = new FakeClient({ throwOnSend: true, throwOnTerminate: true });
  const healthy = new FakeClient();
  api.clients.add(broken);
  api.clients.add(healthy);

  assert.doesNotThrow(() => api._broadcast({ type: 'traffic-cleared' }));

  assert.equal(broken.terminateCalls, 1);
  assert.equal(api.clients.has(broken), false);
  assert.equal(api.clients.has(healthy), true);
  assert.deepEqual(healthy.sent.map(payload => JSON.parse(payload)), [{ type: 'traffic-cleared' }]);
});

test('an asynchronous send callback failure removes only the failed client', () => {
  const api = createApi();
  const failing = new FakeClient({ deferCallback: true });
  const healthy = new FakeClient();
  api.clients.add(failing);
  api.clients.add(healthy);

  api._broadcast({ type: 'request', data: { id: 'first' } });
  assert.equal(api.clients.has(failing), true);
  assert.equal(typeof failing.sendCallback, 'function');

  failing.sendCallback(new Error('socket write failed'));
  assert.equal(failing.terminateCalls, 1);
  assert.equal(api.clients.has(failing), false);
  assert.equal(api.clients.has(healthy), true);

  api._broadcast({ type: 'request', data: { id: 'second' } });
  assert.deepEqual(healthy.sent.map(payload => JSON.parse(payload).data.id), ['first', 'second']);
  assert.equal(failing.sent.length, 1);
});
