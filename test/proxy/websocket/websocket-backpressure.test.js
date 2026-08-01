import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

class FakeSocket extends EventEmitter {
  constructor(writeResults = []) {
    super();
    this.writeResults = [...writeResults];
    this.writes = [];
    this.pauseCalls = 0;
    this.resumeCalls = 0;
  }

  write(chunk) {
    this.writes.push(Buffer.from(chunk));
    return this.writeResults.length ? this.writeResults.shift() : true;
  }

  pause() {
    this.pauseCalls++;
  }

  resume() {
    this.resumeCalls++;
  }
}

function startRelay({
  clientResults = [],
  serverResults = [],
  head = '',
  proxyHead = '',
  onClientChunk,
  onServerChunk
} = {}) {
  const proxy = new ProxyServer(null);
  const client = new FakeSocket(clientResults);
  const server = new FakeSocket(serverResults);
  const clientChunks = [];
  const serverChunks = [];
  const stop = proxy._startWebSocketRelay(
    client,
    server,
    Buffer.from(head),
    Buffer.from(proxyHead),
    chunk => {
      clientChunks.push(Buffer.from(chunk));
      onClientChunk?.(chunk);
    },
    chunk => {
      serverChunks.push(Buffer.from(chunk));
      onServerChunk?.(chunk);
    }
  );
  return { client, server, clientChunks, serverChunks, stop };
}

test('WebSocket relay writes bytes before scheduling capture work', () => {
  const order = [];
  const relay = startRelay({ onClientChunk: () => order.push('capture') });
  const write = relay.server.write.bind(relay.server);
  relay.server.write = chunk => {
    order.push('write');
    return write(chunk);
  };

  relay.client.emit('data', Buffer.from('relayed-first'));

  assert.deepEqual(order, ['write', 'capture']);
  relay.stop();
});

test('client-to-server WebSocket relay pauses until the upstream socket drains', () => {
  const relay = startRelay({ serverResults: [false, true] });

  relay.client.emit('data', Buffer.from('client-one'));
  assert.deepEqual(relay.server.writes, [Buffer.from('client-one')]);
  assert.deepEqual(relay.clientChunks, [Buffer.from('client-one')]);
  assert.equal(relay.client.pauseCalls, 1);
  assert.equal(relay.client.resumeCalls, 0);
  assert.equal(relay.server.listenerCount('drain'), 1);

  relay.server.emit('drain');
  assert.equal(relay.client.resumeCalls, 1);
  assert.equal(relay.server.listenerCount('drain'), 0);

  relay.client.emit('data', Buffer.from('client-two'));
  assert.deepEqual(relay.server.writes, [Buffer.from('client-one'), Buffer.from('client-two')]);
  relay.stop();
});

test('server-to-client WebSocket relay pauses until the client socket drains', () => {
  const relay = startRelay({ clientResults: [false] });

  relay.server.emit('data', Buffer.from('server-one'));
  assert.deepEqual(relay.client.writes, [Buffer.from('server-one')]);
  assert.deepEqual(relay.serverChunks, [Buffer.from('server-one')]);
  assert.equal(relay.server.pauseCalls, 1);
  assert.equal(relay.server.resumeCalls, 0);

  relay.client.emit('drain');
  assert.equal(relay.server.resumeCalls, 1);

  relay.client.writeResults.push(false);
  relay.server.emit('data', Buffer.from('server-two'));
  assert.equal(relay.server.pauseCalls, 2);
  relay.client.emit('error', new Error('client closed'));
  assert.equal(relay.client.listenerCount('drain'), 0);
  assert.equal(relay.server.listenerCount('data'), 0);
});

test('buffered WebSocket heads use backpressure and relay cleanup removes pending listeners', () => {
  const relay = startRelay({
    clientResults: [false],
    serverResults: [false],
    head: 'buffered-client-frame',
    proxyHead: 'buffered-server-frame'
  });

  assert.deepEqual(relay.server.writes, [Buffer.from('buffered-client-frame')]);
  assert.deepEqual(relay.client.writes, [Buffer.from('buffered-server-frame')]);
  assert.deepEqual(relay.clientChunks, [Buffer.from('buffered-client-frame')]);
  assert.deepEqual(relay.serverChunks, [Buffer.from('buffered-server-frame')]);
  assert.equal(relay.client.pauseCalls, 1);
  assert.equal(relay.server.pauseCalls, 1);
  assert.equal(relay.server.listenerCount('drain'), 1);
  assert.equal(relay.client.listenerCount('drain'), 1);

  relay.client.emit('close');
  assert.equal(relay.client.listenerCount('data'), 0);
  assert.equal(relay.server.listenerCount('data'), 0);
  assert.equal(relay.client.listenerCount('drain'), 0);
  assert.equal(relay.server.listenerCount('drain'), 0);
  assert.equal(relay.client.resumeCalls, 1);
  assert.equal(relay.server.resumeCalls, 1);

  relay.client.emit('data', Buffer.from('ignored'));
  relay.server.emit('data', Buffer.from('ignored'));
  assert.equal(relay.clientChunks.length, 1);
  assert.equal(relay.serverChunks.length, 1);
});
