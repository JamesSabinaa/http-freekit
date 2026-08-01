import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

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
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: response.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    request.once('error', reject);
    request.end(payload);
  });
}

async function createApi(t) {
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { api, proxy, port: server.address().port };
}

test('spec API rejects matcher-incompatible OpenAPI shapes before adding them', async t => {
  const { proxy, port } = await createApi(t);
  const invalidSubmissions = [
    { baseUrl: {}, spec: { paths: {} } },
    { baseUrl: 'https://api.example.test', spec: { paths: { '/users/{id}': null } } },
    { baseUrl: 'https://api.example.test', spec: { paths: null } },
    { baseUrl: 'https://api.example.test', spec: { paths: [] } },
    { baseUrl: 'https://api.example.test', spec: { paths: 'invalid' } },
    { baseUrl: 'https://api.example.test', spec: { paths: { '/users': { get: null } } } },
    {
      baseUrl: 'https://api.example.test',
      spec: { paths: { '/users': { get: { tags: 'users' } } } }
    }
  ];

  for (const submission of invalidSubmissions) {
    const response = await postJson(port, '/api/specs', submission);
    assert.equal(response.statusCode, 400, response.body?.error);
  }
  assert.deepEqual(proxy.apiSpecs, []);
});

test('valid OpenAPI operations retain their matching metadata', async t => {
  const { proxy, port } = await createApi(t);
  const parameters = [{ name: 'id', in: 'path', required: true }];
  const response = await postJson(port, '/api/specs', {
    title: 'Users API',
    baseUrl: ' https://api.example.test/v1 ',
    spec: {
      openapi: '3.1.0',
      paths: {
        '/users/{id}': {
          get: {
            operationId: 'getUser',
            summary: 'Get one user',
            description: 'Returns a user.',
            parameters,
            tags: ['users']
          }
        }
      }
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(proxy.apiSpecs[0].baseUrl, 'https://api.example.test/v1');
  assert.deepEqual(proxy.matchApiSpec('GET', '/users/42?expand=true', 'api.example.test'), {
    operationId: 'getUser',
    summary: 'Get one user',
    description: 'Returns a user.',
    parameters,
    pathPattern: '/users/{id}',
    tags: ['users']
  });
});

test('OpenAPI descriptions may omit paths and simply never match traffic', async t => {
  const { proxy, port } = await createApi(t);
  const response = await postJson(port, '/api/specs', {
    title: 'Components API',
    baseUrl: 'https://api.example.test',
    spec: {
      openapi: '3.1.0',
      components: {
        schemas: {
          User: { type: 'object' }
        }
      }
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(proxy.apiSpecs.length, 1);
  assert.equal(proxy.matchApiSpec('GET', '/users/42', 'api.example.test'), null);
});

test('matcher skips malformed legacy specs and null matching path entries', () => {
  const proxy = new ProxyServer(null);
  proxy.apiSpecs = [
    null,
    { baseUrl: {}, spec: { paths: { '/users/{id}': { get: { operationId: 'unsafe' } } } } },
    {
      baseUrl: '',
      spec: {
        paths: {
          '/broken': null,
          '/legacy/{id}': {
            parameters: [{ name: 'id', in: 'path' }],
            get: { operationId: 'legacyGet', tags: ['legacy', 42] }
          }
        }
      }
    }
  ];

  assert.doesNotThrow(() => proxy.matchApiSpec('GET', '/broken', 'example.test'));
  assert.equal(proxy.matchApiSpec('GET', '/broken', 'example.test'), null);
  assert.deepEqual(proxy.matchApiSpec('GET', '/legacy/7', 'example.test'), {
    operationId: 'legacyGet',
    summary: '',
    description: '',
    parameters: [{ name: 'id', in: 'path' }],
    pathPattern: '/legacy/{id}',
    tags: ['legacy']
  });
});

test('traffic capture survives malformed specs and unexpected matcher failures', t => {
  const proxy = new ProxyServer(null);
  proxy.apiSpecs = [
    { baseUrl: {}, spec: { paths: {} } },
    { baseUrl: '', spec: { paths: { '/captured': null } } }
  ];
  const api = new ApiServer(proxy, null, null);
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);

  api.onTrafficEvent({ id: 'legacy', method: 'GET', path: '/captured', host: 'example.test' });
  t.mock.method(console, 'warn', () => {});
  proxy.matchApiSpec = () => { throw null; };
  api.onTrafficEvent({ id: 'throwing', method: 'GET', path: '/', host: 'example.test' });

  assert.deepEqual(api.trafficLog.map(request => request.id), ['legacy', 'throwing']);
  assert.deepEqual(broadcasts.map(message => message.data.id), ['legacy', 'throwing']);
});
