import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { ProxyServer } from '../src/proxy/proxy-server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('client proxy credentials and forwarding identity headers never reach the origin', async (t) => {
  let receivedHeaders;
  const origin = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    res.end('ok');
  });
  const originPort = await listen(origin);
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    await close(origin);
  });

  await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: proxy.server.address().port,
      path: `http://127.0.0.1:${originPort}/headers`,
      headers: {
        host: `127.0.0.1:${originPort}`,
        'proxy-authorization': 'Basic c2VjcmV0',
        'proxy-connection': 'keep-alive',
        'x-forwarded-for': '203.0.113.10',
        forwarded: 'for=203.0.113.10',
        'x-test-header': 'preserved'
      }
    }, (res) => {
      res.resume();
      res.once('end', resolve);
    });
    req.once('error', reject);
    req.end();
  });

  assert.equal(receivedHeaders['proxy-authorization'], undefined);
  assert.equal(receivedHeaders['proxy-connection'], undefined);
  assert.equal(receivedHeaders['x-forwarded-for'], undefined);
  assert.equal(receivedHeaders.forwarded, undefined);
  assert.equal(receivedHeaders['x-test-header'], 'preserved');
});
