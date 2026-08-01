import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import http2 from 'node:http2';
import test from 'node:test';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('HTTP/1 request and response trailers survive proxy forwarding', async (t) => {
  let requestTrailers;
  const origin = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requestTrailers = req.trailers;
      res.writeHead(200, {
        'content-type': 'text/plain',
        trailer: 'x-response-trailer'
      });
      res.write('ok');
      res.addTrailers({ 'x-response-trailer': 'response-value' });
      res.end();
    });
  });
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin);
  });

  const result = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: proxy.server.address().port,
      path: `http://127.0.0.1:${originPort}/trailers`,
      method: 'POST',
      headers: { trailer: 'x-request-trailer', 'transfer-encoding': 'chunked' }
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), trailers: res.trailers }));
    });
    req.once('error', reject);
    req.write('request-body');
    req.addTrailers({ 'x-request-trailer': 'request-value' });
    req.end();
  });

  assert.equal(requestTrailers['x-request-trailer'], 'request-value');
  assert.equal(result.body, 'ok');
  assert.equal(result.trailers['x-response-trailer'], 'response-value');
});

test('HTTP/2 request and response trailers survive the H2 forwarding helpers', async (t) => {
  const proxy = new ProxyServer(null);
  let requestTrailers;
  const origin = http2.createServer();
  origin.on('stream', (stream) => {
    stream.on('trailers', trailers => { requestTrailers = trailers; });
    stream.on('data', () => {});
    stream.on('end', () => {
      proxy._sendH2Response(
        stream,
        { ':status': 200, 'content-type': 'text/plain' },
        Buffer.from('h2-ok'),
        { 'x-response-trailer': 'response-value' }
      );
    });
  });
  const originPort = await listen(origin);
  const session = http2.connect(`http://127.0.0.1:${originPort}`);
  t.after(() => session.destroy());
  t.after(() => close(origin));
  await once(session, 'connect');

  const result = await proxy._makeH2Request(
    session,
    'POST',
    '127.0.0.1',
    originPort,
    '/trailers',
    { 'content-type': 'text/plain' },
    Buffer.from('request-body'),
    { 'x-request-trailer': 'request-value' }
  );

  assert.equal(requestTrailers['x-request-trailer'], 'request-value');
  assert.equal(result.body.toString('utf8'), 'h2-ok');
  assert.equal(result.trailers['x-response-trailer'], 'response-value');
});
