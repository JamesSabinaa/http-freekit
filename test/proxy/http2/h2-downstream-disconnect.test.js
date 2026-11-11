import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http2 from 'node:http2';
import test from 'node:test';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

function createHandler(t) {
  const server = new EventEmitter();
  t.mock.method(http2, 'createSecureServer', () => server);
  const proxy = new ProxyServer(null);
  proxy._handleHttp2Connection(new EventEmitter(), 'example.test', 443, {});
  const forward = t.mock.method(proxy, '_streamH2Exchange', () => {});
  t.mock.method(proxy, '_canStreamWithoutRequestBuffering', () => true);
  return { server, proxy, forward };
}

const headers = { ':method': 'GET', ':path': '/', ':authority': 'example.test', ':scheme': 'https' };

for (const state of ['detached', 'destroyed', 'closed', 'session destroyed']) {
  test(`a queued H2 stream that is ${state} does not crash or forward`, t => {
    const { server, proxy, forward } = createHandler(t);
    const stream = new EventEmitter();
    stream.session = state === 'detached' ? undefined : { destroyed: state === 'session destroyed' };
    stream.destroyed = state === 'destroyed';
    stream.closed = state === 'closed';

    assert.doesNotThrow(() => server.emit('stream', stream, headers));
    assert.doesNotThrow(() => stream.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' })));
    assert.equal(proxy.requestCount, 0);
    assert.equal(forward.mock.callCount(), 0);
  });
}

test('a live H2 stream retains its session profile and forwards after a detached stream', t => {
  const { server, proxy, forward } = createHandler(t);
  server.emit('stream', new EventEmitter(), headers);
  const session = {
    remoteSettings: { initialWindowSize: 65535 },
    state: { remoteWindowSize: 1048576 },
    socket: { servername: 'example.test' }
  };
  const stream = new EventEmitter();
  stream.session = session;
  stream.pause = () => {};
  server.emit('stream', stream, headers);

  assert.equal(proxy.requestCount, 1);
  assert.equal(forward.mock.callCount(), 1);
  const [exchange] = forward.mock.calls[0].arguments;
  assert.equal(exchange.stream, stream);
  assert.equal(exchange.fullUrl, 'https://example.test/');
  assert.deepEqual(exchange.clientHttp2Profile, {
    settings: session.remoteSettings,
    connectionWindowSize: 1048576
  });
  assert.equal(exchange.clientHttp2Profile, session._clientHttp2Profile);
});
