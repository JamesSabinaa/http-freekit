import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiServer, DEFAULT_MAX_WS_BUFFERED_BYTES } from '../../../src/api/api-server.js';

function createApi(options = {}) {
  return new ApiServer({
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  }, null, null, options);
}

class FakeClient {
  constructor({ bufferedAmount = 0, throwOnSend = false, deferCallback = false,
    throwOnTerminate = false, trackBufferedAmount = false } = {}) {
    this.readyState = 1;
    this.bufferedAmount = bufferedAmount;
    this.throwOnSend = throwOnSend;
    this.deferCallback = deferCallback;
    this.throwOnTerminate = throwOnTerminate;
    this.trackBufferedAmount = trackBufferedAmount;
    this.sent = [];
    this.sendCallback = null;
    this.terminateCalls = 0;
  }

  send(data, callback) {
    if (this.throwOnSend) throw new Error('send failed synchronously');
    this.sent.push(data);
    const bytes = Buffer.byteLength(data);
    if (this.trackBufferedAmount) this.bufferedAmount += bytes;
    const complete = error => {
      if (this.trackBufferedAmount) this.bufferedAmount -= bytes;
      callback(error);
    };
    if (this.deferCallback) this.sendCallback = complete;
    else complete();
  }

  terminate() {
    this.terminateCalls++;
    if (this.throwOnTerminate) throw new Error('terminate failed');
  }
}

async function waitForSentCount(client, expectedCount) {
  for (let attempt = 0; attempt < 20 && client.sent.length < expectedCount; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(
    client.sent.length >= expectedCount,
    `expected at least ${expectedCount} queued sends, received ${client.sent.length}`
  );
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

test('traffic dumps stay behind queued mutation broadcasts and snapshot immediately', async () => {
  const api = createApi();
  const client = new FakeClient({ deferCallback: true, trackBufferedAmount: true });
  api.clients.add(client);
  api.trafficLog = [{ id: 'shared', trafficLifecycleId: 'life-2', marker: 'SNAPSHOT' }];

  api._broadcast({
    type: 'traffic-pinned', requestId: 'shared', trafficLifecycleId: 'life-1',
    pinned: false, revision: 1
  });
  api._broadcast({
    type: 'traffic-deleted', requestId: 'shared', trafficLifecycleId: 'life-1',
    clearRevision: 0
  });
  api._handleWsMessage(client, { type: 'get-traffic', limit: 10 });
  api._broadcast({ type: 'request', data: { id: 'newer-than-dump' } });
  api.trafficLog[0].marker = 'MUTATED-AFTER-SNAPSHOT';

  assert.deepEqual(client.sent.map(payload => JSON.parse(payload).type), ['traffic-pinned']);
  client.sendCallback();
  await waitForSentCount(client, 2);
  assert.deepEqual(client.sent.map(payload => JSON.parse(payload).type), [
    'traffic-pinned',
    'traffic-deleted'
  ]);
  client.sendCallback();
  await waitForSentCount(client, 3);

  const delivered = client.sent.map(payload => JSON.parse(payload));
  assert.deepEqual(delivered.map(message => message.type), [
    'traffic-pinned',
    'traffic-deleted',
    'traffic-dump'
  ]);
  assert.equal(delivered[2].requests[0].marker, 'SNAPSHOT');
  client.sendCallback();
  await waitForSentCount(client, 4);
  assert.deepEqual(client.sent.map(payload => JSON.parse(payload).type), [
    'traffic-pinned',
    'traffic-deleted',
    'traffic-dump',
    'request'
  ]);
  assert.equal(JSON.parse(client.sent[3]).data.id, 'newer-than-dump');
  client.sendCallback();
});

test('a bounded traffic dump queues behind imported chunks and their following Clear', async () => {
  const api = createApi({ maxWsBufferedBytes: 1024 });
  const client = new FakeClient({ deferCallback: true, trackBufferedAmount: true });
  api.clients.add(client);
  const importedTraffic = Array.from({ length: 20 }, (_, index) => ({
    id: `imported-${index}`,
    method: 'POST',
    url: `https://example.test/${'x'.repeat(240)}`
  }));
  const retainedImportedTraffic = api._appendImportedTraffic(importedTraffic);
  const importChunkCount = api._buildImportedTrafficMessages(
    retainedImportedTraffic,
    importedTraffic.length
  ).length;
  assert.ok(importChunkCount > 1);

  api._broadcastImportedTraffic(retainedImportedTraffic, importedTraffic.length);
  api._clearTraffic();
  assert.deepEqual(api.trafficLog, []);

  api._handleWsMessage(client, { type: 'get-traffic', limit: 10 });

  assert.equal(api.clients.has(client), true);
  assert.deepEqual(client.sent.map(payload => JSON.parse(payload).type), ['traffic-imported']);
  while (client.sendCallback) {
    const callback = client.sendCallback;
    client.sendCallback = null;
    callback();
    await new Promise(resolve => setImmediate(resolve));
  }
  const deliveredTypes = client.sent.map(payload => JSON.parse(payload).type);
  assert.deepEqual(deliveredTypes.slice(0, importChunkCount),
    Array(importChunkCount).fill('traffic-imported'));
  assert.deepEqual(deliveredTypes.slice(importChunkCount), [
    'traffic-cleared',
    'traffic-dump'
  ]);
  assert.deepEqual(JSON.parse(client.sent.at(-1)).requests, []);
  assert.equal(client.terminateCalls, 0);
});

test('repeated traffic dumps cannot grow a slow client queue beyond the byte cap', () => {
  const api = createApi({ maxWsBufferedBytes: 1024 });
  const client = new FakeClient({ deferCallback: true, trackBufferedAmount: true });
  api.clients.add(client);
  const buildTrafficDumpMessages = api._buildTrafficDumpMessages.bind(api);
  let buildCalls = 0;
  api._buildTrafficDumpMessages = (...args) => {
    buildCalls++;
    return buildTrafficDumpMessages(...args);
  };
  api.trafficLog = Array.from({ length: 20 }, (_, index) => ({
    id: `large-${index}`,
    method: 'GET',
    url: `https://example.test/${'x'.repeat(256)}`
  }));

  api._handleWsMessage(client, { type: 'get-traffic', limit: 20 });
  assert.equal(client.sent.length, 1);
  assert.equal(buildCalls, 1);
  assert.equal(api.clients.has(client), true);
  api._handleWsMessage(client, { type: 'get-traffic', limit: 20 });

  assert.equal(client.sent.length, 1);
  assert.equal(buildCalls, 1);
  assert.equal(client.terminateCalls, 1);
  assert.equal(api.clients.has(client), false);
  api._handleWsMessage(client, { type: 'get-traffic', limit: 20 });
  assert.equal(buildCalls, 1);
});

test('in-flight bytes are not double-counted against real bufferedAmount', () => {
  const first = { type: 'request', data: { id: 'first', body: 'x'.repeat(700) } };
  const second = { type: 'request', data: { id: 'second', body: 'x'.repeat(300) } };
  const firstBytes = Buffer.byteLength(JSON.stringify(first));
  const secondBytes = Buffer.byteLength(JSON.stringify(second));
  const api = createApi({ maxWsBufferedBytes: firstBytes + secondBytes });
  const client = new FakeClient({ deferCallback: true, trackBufferedAmount: true });
  api.clients.add(client);

  api._broadcast(first);
  api._broadcast(second);

  assert.equal(client.bufferedAmount, firstBytes);
  assert.equal(api.clients.has(client), true);
  assert.equal(client.terminateCalls, 0);
  client.sendCallback();
});

test('a second oversized atomic batch evicts instead of growing the first batch queue', () => {
  const messages = [
    { type: 'traffic-cleared', chunkIndex: 0, body: 'x'.repeat(600) },
    { type: 'traffic-cleared', chunkIndex: 1, body: 'y'.repeat(600) }
  ];
  const payloadBytes = messages.map(message => Buffer.byteLength(JSON.stringify(message)));
  const api = createApi({ maxWsBufferedBytes: Math.max(...payloadBytes) + 32 });
  const client = new FakeClient({ deferCallback: true, trackBufferedAmount: true });
  api.clients.add(client);

  api._broadcastSequence(messages);
  assert.equal(api.clients.has(client), true);
  assert.equal(client.sent.length, 1);
  api._broadcastSequence(messages);

  assert.equal(api.clients.has(client), false);
  assert.equal(client.terminateCalls, 1);
  assert.equal(client.sent.length, 1);
});

test('an oversized traffic dump drains as bounded FIFO chunks without evicting a healthy client', async () => {
  const api = createApi();
  const client = new FakeClient({ deferCallback: true, trackBufferedAmount: true });
  api.clients.add(client);
  api.trafficLog = Array.from({ length: 10_000 }, (_, index) => ({
    id: `request-${index}`,
    trafficLifecycleId: `life-${index}`,
    method: 'POST',
    requestBody: 'x'.repeat(1800)
  }));

  const startedAt = Date.now();
  api._handleWsMessage(client, { type: 'get-traffic', limit: 10_000 });
  const buildDuration = Date.now() - startedAt;
  api._broadcast({ type: 'request', data: { id: 'after-dump' } });

  assert.ok(buildDuration < 10_000, `dump chunking took ${buildDuration}ms`);
  assert.equal(api.clients.has(client), true);
  assert.equal(client.terminateCalls, 0);
  while (client.sendCallback) {
    const callback = client.sendCallback;
    client.sendCallback = null;
    callback();
    await new Promise(resolve => setImmediate(resolve));
  }

  const delivered = client.sent.map(payload => JSON.parse(payload));
  const dumpChunks = delivered.filter(message => message.type === 'traffic-dump');
  assert.ok(dumpChunks.length > 1);
  assert.equal(delivered.at(-1).data.id, 'after-dump');
  assert.equal(new Set(dumpChunks.map(message => message.dumpId)).size, 1);
  assert.deepEqual(dumpChunks.map(message => message.chunkIndex),
    Array.from({ length: dumpChunks.length }, (_, index) => index));
  assert.ok(client.sent.every(payload => Buffer.byteLength(payload) <= api.maxWsBufferedBytes));
  const restored = dumpChunks.flatMap(message => message.requests);
  assert.equal(restored.length, 10_000);
  assert.equal(restored[0].id, 'request-0');
  assert.equal(restored.at(-1).requestBody.length, 1800);
  assert.equal(client.terminateCalls, 0);
});

test('atomic in-flight bytes do not hide unrelated socket backlog', () => {
  const messages = [
    { type: 'traffic-cleared', chunkIndex: 0, body: 'x'.repeat(650) },
    { type: 'traffic-cleared', chunkIndex: 1, body: 'y'.repeat(650) }
  ];
  const api = createApi({ maxWsBufferedBytes: 1500 });
  const client = new FakeClient({
    bufferedAmount: 500,
    deferCallback: true,
    trackBufferedAmount: true
  });
  api.clients.add(client);

  api._broadcastSequence(messages);
  assert.equal(api.clients.has(client), true);
  api._broadcast({ type: 'request', data: { body: 'z'.repeat(1000) } });

  assert.equal(api.clients.has(client), false);
  assert.equal(client.terminateCalls, 1);
});

test('a near-cap chunked dump leaves bounded room for a later live event', async () => {
  const api = createApi({ maxWsBufferedBytes: 4096 });
  const client = new FakeClient({ deferCallback: true, trackBufferedAmount: true });
  api.clients.add(client);
  api.trafficLog = Array.from({ length: 10 }, (_, index) => ({
    id: `request-${index}`,
    trafficLifecycleId: `life-${index}`,
    method: 'POST',
    requestBody: 'x'.repeat(200)
  }));
  const dumpPayloads = api._buildTrafficDumpMessages(api.trafficLog)
    .map(message => JSON.stringify(message));
  const dumpBytes = dumpPayloads.reduce((total, payload) => total + Buffer.byteLength(payload), 0);
  const live = { type: 'request', data: { id: 'live', body: 'z'.repeat(1000) } };
  assert.equal(dumpPayloads.length, 2);
  assert.ok(dumpBytes < api.maxWsBufferedBytes);
  assert.ok(dumpBytes + Buffer.byteLength(JSON.stringify(live)) > api.maxWsBufferedBytes);

  api._handleWsMessage(client, { type: 'get-traffic', limit: 10 });
  api._broadcast(live);
  assert.equal(api.clients.has(client), true);
  assert.equal(client.terminateCalls, 0);

  while (client.sendCallback) {
    const callback = client.sendCallback;
    client.sendCallback = null;
    callback();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(client.sent.map(payload => JSON.parse(payload).type), [
    'traffic-dump',
    'traffic-dump',
    'request'
  ]);
});
