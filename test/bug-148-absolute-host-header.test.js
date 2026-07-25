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

test('absolute-form requests derive Host from their connection destination', async t => {
  let receivedHost;
  const origin = http.createServer((req, res) => {
    receivedHost = req.headers.host;
    res.end('ok');
  });
  const originPort = await listen(origin);
  t.after(() => new Promise(resolve => origin.close(resolve)));

  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(() => proxy.stop());

  const response = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: proxy.server.address().port,
      path: `http://127.0.0.1:${originPort}/target`,
      headers: { Host: 'conflicting.example' }
    }, res => {
      res.resume();
      res.once('end', () => resolve(res));
    });
    request.once('error', reject);
    request.end();
  });

  assert.equal(response.statusCode, 200);
  assert.equal(receivedHost, `127.0.0.1:${originPort}`);
});

test('target Host replacement removes conflicting case variants', () => {
  const proxy = new ProxyServer(null);
  const headers = { Host: 'one.test', host: 'two.test', Other: 'value' };

  proxy._setTargetHostHeader(headers, 'target.test:8080');

  assert.deepEqual(headers, { Host: 'target.test:8080', Other: 'value' });
});
