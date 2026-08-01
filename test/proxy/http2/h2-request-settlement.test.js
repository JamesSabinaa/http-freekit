import assert from 'node:assert/strict';
import { once } from 'node:events';
import http2 from 'node:http2';
import test from 'node:test';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

const TEST_IDLE_TIMEOUT_MS = 500;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function connect(port) {
  const session = http2.connect(`http://127.0.0.1:${port}`);
  await once(session, 'connect');
  return session;
}

function request(proxy, session, port, path, signal = null) {
  return proxy._makeH2Request(
    session,
    'GET',
    '127.0.0.1',
    port,
    path,
    {},
    Buffer.alloc(0),
    {},
    signal
  );
}

async function outcomeWithin(promise, ms = 1000) {
  return Promise.race([
    promise.then(value => ({ value }), error => ({ error })),
    delay(ms).then(() => ({ timedOut: true }))
  ]);
}

test('an H2 stream with no response headers uses the configured idle timeout', async t => {
  let resolveHangingStreamClosed;
  const hangingStreamClosed = new Promise(resolve => { resolveHangingStreamClosed = resolve; });
  const origin = http2.createServer();
  origin.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    if (headers[':path'] === '/hang') {
      stream.once('close', () => resolveHangingStreamClosed(stream.rstCode));
      return;
    }
    stream.respond({ ':status': 200 });
    stream.end('still usable');
  });
  const port = await listen(origin);
  const session = await connect(port);
  t.after(async () => {
    session.destroy();
    await close(origin);
  });

  const proxy = new ProxyServer(null, { upstreamIdleTimeoutMs: TEST_IDLE_TIMEOUT_MS });
  const result = await outcomeWithin(request(proxy, session, port, '/hang'));

  assert.equal(result.timedOut, undefined);
  assert.equal(result.error?.code, 'ETIMEDOUT');
  assert.equal(result.error?.upstreamPhase, 'response');
  assert.match(result.error?.message, /Upstream response timeout after 0\.5s/);
  assert.equal(await hangingStreamClosed, http2.constants.NGHTTP2_CANCEL);
  assert.equal(session.destroyed, false);

  const nextResponse = await request(proxy, session, port, '/ok');
  assert.equal(nextResponse.body.toString(), 'still usable');
});

test('an H2 stream that closes before a response rejects as a response reset', async t => {
  const origin = http2.createServer();
  origin.on('stream', stream => {
    stream.on('error', () => {});
    stream.close(http2.constants.NGHTTP2_NO_ERROR);
  });
  const port = await listen(origin);
  const session = await connect(port);
  t.after(async () => {
    session.destroy();
    await close(origin);
  });

  const proxy = new ProxyServer(null, { upstreamIdleTimeoutMs: 500 });
  const result = await outcomeWithin(request(proxy, session, port, '/premature'));

  assert.equal(result.timedOut, undefined);
  assert.equal(result.error?.code, 'ECONNRESET');
  assert.equal(result.error?.upstreamPhase, 'response');
  assert.match(result.error?.message, /before response headers/);
});

test('an errored upstream H2 stream rejects with response phase metadata', async t => {
  const origin = http2.createServer();
  origin.on('stream', stream => {
    stream.on('error', () => {});
    stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
  });
  const port = await listen(origin);
  const session = await connect(port);
  t.after(async () => {
    session.destroy();
    await close(origin);
  });

  const proxy = new ProxyServer(null, { upstreamIdleTimeoutMs: 500 });
  const result = await outcomeWithin(request(proxy, session, port, '/error'));

  assert.equal(result.timedOut, undefined);
  assert.ok(result.error);
  assert.equal(result.error.upstreamPhase, 'response');
});

test('an abort signal rejects and cancels an active H2 stream', async t => {
  let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const origin = http2.createServer();
  origin.on('stream', stream => {
    stream.on('error', () => {});
    stream.respond({ ':status': 200 });
    const interval = setInterval(() => stream.write('data'), 10);
    stream.once('close', () => {
      clearInterval(interval);
      resolveClosed(stream.rstCode);
    });
    resolveStarted();
  });
  const port = await listen(origin);
  const session = await connect(port);
  t.after(async () => {
    session.destroy();
    await close(origin);
  });

  const proxy = new ProxyServer(null, { upstreamIdleTimeoutMs: 500 });
  const controller = new AbortController();
  const pending = request(proxy, session, port, '/abort', controller.signal);
  await started;
  controller.abort();
  const result = await outcomeWithin(pending);

  assert.equal(result.timedOut, undefined);
  assert.equal(result.error?.code, 'ERR_DOWNSTREAM_ABORTED');
  assert.equal(await closed, http2.constants.NGHTTP2_CANCEL);
  assert.equal(session.destroyed, false);
});

test('a successful H2 response preserves trailers and has no late timeout', async t => {
  const proxy = new ProxyServer(null, { upstreamIdleTimeoutMs: TEST_IDLE_TIMEOUT_MS });
  const origin = http2.createServer();
  origin.on('stream', stream => {
    stream.on('error', () => {});
    proxy._sendH2Response(
      stream,
      { ':status': 200, 'content-type': 'text/plain' },
      Buffer.from('complete'),
      { 'x-response-trailer': 'present' }
    );
  });
  const port = await listen(origin);
  const session = await connect(port);
  t.after(async () => {
    session.destroy();
    await close(origin);
  });

  const nativeRequest = session.request.bind(session);
  let cancellationCount = 0;
  session.request = (...args) => {
    const stream = nativeRequest(...args);
    const nativeClose = stream.close.bind(stream);
    stream.close = (code, ...closeArgs) => {
      if (code === http2.constants.NGHTTP2_CANCEL) cancellationCount += 1;
      return nativeClose(code, ...closeArgs);
    };
    return stream;
  };

  const first = await request(proxy, session, port, '/complete');
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.toString(), 'complete');
  assert.equal(first.trailers['x-response-trailer'], 'present');

  await delay(TEST_IDLE_TIMEOUT_MS + 100);
  assert.equal(cancellationCount, 0);
  assert.equal(session.destroyed, false);

  const second = await request(proxy, session, port, '/again');
  assert.equal(second.body.toString(), 'complete');
  assert.equal(cancellationCount, 0);
});

test('an oversized H2 response still rejects with the body-limit error', async t => {
  const origin = http2.createServer();
  origin.on('stream', stream => {
    stream.on('error', () => {});
    stream.respond({ ':status': 200 });
    stream.end('too large');
  });
  const port = await listen(origin);
  const session = await connect(port);
  t.after(async () => {
    session.destroy();
    await close(origin);
  });

  const proxy = new ProxyServer(null, {
    maxBufferedBodyBytes: 4,
    upstreamIdleTimeoutMs: 500
  });
  const result = await outcomeWithin(request(proxy, session, port, '/large'));

  assert.equal(result.timedOut, undefined);
  assert.equal(result.error?.code, 'ERR_BODY_TOO_LARGE');
  assert.match(result.error?.message, /HTTP\/2 response body exceeds 4 byte buffer limit/);
});
