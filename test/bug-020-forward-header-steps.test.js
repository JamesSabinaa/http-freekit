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

test('H1 forward actions send headers produced by pre-steps', async (t) => {
  let receivedHeaders;
  const origin = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    res.end('forwarded');
  });
  const originPort = await listen(origin);

  const proxy = new ProxyServer(null, { port: 0 });
  proxy.mockRules = [{
    enabled: true,
    matchers: [],
    preSteps: [
      { type: 'add-header', name: 'X-Added-By-Step', value: 'yes' },
      { type: 'remove-header', name: 'X-Remove-Me' }
    ],
    action: { type: 'forward', forwardTo: `http://127.0.0.1:${originPort}` }
  }];
  await proxy.start();

  t.after(async () => {
    await proxy.stop();
    await close(origin);
  });

  const responseBody = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: proxy.server.address().port,
      path: 'http://original.invalid/resource',
      headers: {
        host: 'original.invalid',
        'X-Original-Case': 'preserved',
        'X-Remove-Me': 'old'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.once('error', reject);
    req.end();
  });

  assert.equal(responseBody, 'forwarded');
  assert.equal(receivedHeaders['x-added-by-step'], 'yes');
  assert.equal(receivedHeaders['x-original-case'], 'preserved');
  assert.equal(receivedHeaders['x-remove-me'], undefined);
  assert.equal(receivedHeaders.host, `127.0.0.1:${originPort}`);
});

test('raw-case header reconstruction respects changed and deleted current headers', () => {
  const proxy = new ProxyServer(null);
  const headers = proxy._currentHeadersWithRawCase(
    ['X-Original-Case', 'old', 'X-Deleted', 'gone'],
    { 'x-original-case': 'new', 'x-added': 'yes' }
  );

  assert.deepEqual(headers, { 'X-Original-Case': 'new', 'x-added': 'yes' });
});
