import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

function postJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'POST',
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

test('moving a mock group into another group is rejected without mutation', async t => {
  const { proxy, port } = await createServer(t);
  proxy.mockRules = [
    { id: 'group-a', type: 'group', title: 'A', enabled: true, items: [] },
    { id: 'group-b', type: 'group', title: 'B', enabled: true, items: [] }
  ];

  const result = await postJson(port, '/api/mock-rules/move-to-group', {
    ruleId: 'group-a',
    groupId: 'group-b'
  });

  assert.equal(result.statusCode, 400);
  assert.match(result.body.error, /cannot contain other groups/);
  assert.deepEqual(proxy.mockRules.map(rule => rule.id), ['group-a', 'group-b']);
  assert.deepEqual(proxy.mockRules[1].items, []);
});

test('group creation rejects nested group payloads', async t => {
  const { proxy, port } = await createServer(t);
  const result = await postJson(port, '/api/mock-rules/group', {
    title: 'Outer',
    items: [{ id: 'inner', type: 'group', items: [] }]
  });

  assert.equal(result.statusCode, 400);
  assert.deepEqual(proxy.mockRules, []);
});

test('legacy deeply nested rules remain editable and removable', () => {
  const proxy = new ProxyServer(null);
  const leaf = { id: 'leaf', enabled: true };
  proxy.mockRules = [{
    id: 'outer',
    type: 'group',
    items: [{ id: 'inner', type: 'group', items: [leaf] }]
  }];

  assert.equal(proxy.toggleMockRule('leaf').enabled, false);
  assert.equal(proxy.removeMockRuleById('leaf'), true);
  assert.equal(proxy._findMockRuleById('leaf'), null);
});
