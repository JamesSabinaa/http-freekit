import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

function putJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

async function createServer(t) {
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { proxy, port: server.address().port };
}

test('invalid replacement imports leave every existing mock rule intact', async t => {
  const { proxy, port } = await createServer(t);
  proxy.mockRules = [{
    id: 'existing',
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }],
    action: { type: 'fixed-response', status: 200 }
  }];

  const result = await putJson(port, '/api/mock-rules', { rules: [{}] });

  assert.equal(result.statusCode, 400);
  assert.deepEqual(proxy.mockRules.map(rule => rule.id), ['existing']);
});

test('valid replacement imports are applied in one API operation', async t => {
  const { proxy, port } = await createServer(t);
  proxy.mockRules = [{ id: 'existing', urlPattern: '/old', response: {} }];

  const result = await putJson(port, '/api/mock-rules', {
    rules: [{ matchers: [{ type: 'method', value: 'GET' }], action: { type: 'passthrough' } }]
  });

  assert.equal(result.statusCode, 200);
  assert.equal(proxy.mockRules.length, 1);
  assert.notEqual(proxy.mockRules[0].id, 'existing');
  assert.ok(proxy.mockRules[0].id);
});

test('renderer replacement import uses the atomic endpoint and checks failures', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = source.indexOf('function importMockRules()');
  const end = source.indexOf('// ============ TRANSFORM HEADER HELPERS', start);
  const importSource = source.slice(start, end);

  assert.match(importSource, /method: 'PUT'/);
  assert.match(importSource, /if \(!response\.ok\)/);
  assert.doesNotMatch(importSource, /method: 'DELETE'/);
});
