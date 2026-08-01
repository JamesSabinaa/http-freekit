import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import test from 'node:test';
import { ApiServer } from '../../../src/api/api-server.js';
import { normalizeBrowserUrl } from '../../../src/interceptors/browser-url.js';
import { InterceptorManager } from '../../../src/interceptors/interceptor-manager.js';

const require = createRequire(import.meta.url);
const { parseOpenDeepLink, findDeepLinkArg } = require('../../../electron/deep-link.cjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function postJson(port, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    req.once('error', reject);
    req.end(payload);
  });
}

test('parses an encoded desktop open link', () => {
  const target = 'https://example.com/path?q=hello world#result';
  const deepLink = `http-freekit://open?url=${encodeURIComponent(target)}`;

  assert.equal(parseOpenDeepLink(deepLink), 'https://example.com/path?q=hello%20world#result');
  assert.equal(findDeepLinkArg(['HTTP-FREEKIT://open?url=https%3A%2F%2Fexample.com']),
    'HTTP-FREEKIT://open?url=https%3A%2F%2Fexample.com');
});

test('rejects unsupported deep-link actions and non-web target protocols', () => {
  assert.throws(
    () => parseOpenDeepLink('http-freekit://unknown?url=https%3A%2F%2Fexample.com'),
    /Unknown HTTP FreeKit link action/
  );
  assert.throws(
    () => parseOpenDeepLink('http-freekit://open?url=javascript%3Aalert%281%29'),
    /Only HTTP and HTTPS URLs/
  );
});

test('normalizes web URLs and rejects values that could become browser flags', () => {
  assert.equal(normalizeBrowserUrl(' https://example.com/test '), 'https://example.com/test');
  assert.throws(() => normalizeBrowserUrl('--incognito'), /Invalid URL/);
  assert.throws(() => normalizeBrowserUrl('file:///tmp/private'), /Only HTTP and HTTPS URLs/);
});

test('reuses an active interceptor and activates an inactive interceptor', async () => {
  const manager = Object.create(InterceptorManager.prototype);
  let openedUrl = null;
  const activeInterceptor = {
    name: 'Chrome',
    isActive: async () => true,
    openUrl: async url => {
      openedUrl = url;
      return { success: true, url };
    }
  };
  manager.interceptors = new Map([['chrome', activeInterceptor]]);

  const reused = await manager.openUrl('chrome', 8081, 'https://example.com/active');
  assert.equal(openedUrl, 'https://example.com/active');
  assert.equal(reused.success, true);

  const inactiveInterceptor = {
    id: 'chrome',
    name: 'Chrome',
    isActive: async () => false,
    isActivable: async () => true,
    openUrl: async () => {},
    activate: async (port, options) => ({ id: 'chrome', port, ...options })
  };
  manager.interceptors.set('chrome', inactiveInterceptor);
  manager.operationsInProgress = new Map();

  assert.deepEqual(
    await manager.openUrl('chrome', 9090, 'https://example.com/new'),
    { id: 'chrome', port: 9090, url: 'https://example.com/new' }
  );
});

test('browser open API requires the desktop session token', async (t) => {
  const calls = [];
  const proxy = { port: 8081, mockRules: [] };
  const interceptors = {
    onStatusChange: null,
    openUrl: async (...args) => {
      calls.push(args);
      return { browser: 'Chrome', url: args[2] };
    }
  };
  const api = new ApiServer(proxy, null, interceptors, { authToken: 'session-secret' });
  const server = http.createServer(api.app);
  const port = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));

  const unauthorized = await postJson(
    port,
    '/api/interceptors/chrome/open',
    { url: 'https://example.com' }
  );
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(calls.length, 0);

  const authorized = await postJson(
    port,
    '/api/interceptors/chrome/open',
    { url: 'https://example.com' },
    'session-secret'
  );
  assert.equal(authorized.statusCode, 200);
  assert.deepEqual(calls, [['chrome', 8081, 'https://example.com']]);
});
