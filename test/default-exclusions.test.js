import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../src/api/api-server.js';
import {
  DEFAULT_EXCLUSIONS,
  matchesDefaultExclusion,
  normalizeDefaultExclusions
} from '../src/traffic/default-exclusions.js';

function requestJson(port, method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : undefined
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

async function createApi(t, initialSettings = {}) {
  const values = { ...initialSettings };
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null,
    getStats: () => ({})
  };
  const api = new ApiServer(proxy, null, null);
  api.settings = {
    get(key, fallback) {
      return Object.hasOwn(values, key) ? values[key] : fallback;
    },
    setAll(changes) {
      Object.assign(values, changes);
    }
  };
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { api, port: server.address().port, values };
}

test('the default list contains and matches the restored Chromium background exclusions', () => {
  assert.equal(DEFAULT_EXCLUSIONS.includes('android.clients.google.com/c2dm/register3'), true);
  assert.equal(matchesDefaultExclusion({
    url: 'https://android.clients.google.com/c2dm/register3?app=com.android.chrome'
  }), true);
  assert.equal(matchesDefaultExclusion({
    host: 'android.clients.google.com',
    path: '/user-request'
  }), false);
  assert.equal(matchesDefaultExclusion({ host: 'cache.gvt1.com', path: '/asset' }), true);
  assert.equal(matchesDefaultExclusion({ host: 'my-update-service.googleapis.com', path: '/' }), true);
});

test('exclusion patterns normalize URLs, comments, case, and duplicates', () => {
  assert.deepEqual(normalizeDefaultExclusions([
    '# comment',
    ' HTTPS://Android.Clients.Google.com/c2dm/register3 ',
    'android.clients.google.com/c2dm/register3',
    ''
  ]), ['android.clients.google.com/c2dm/register3']);
  assert.throws(
    () => normalizeDefaultExclusions(['not a host name']),
    /invalid hostname pattern/
  );
  assert.throws(() => normalizeDefaultExclusions('example.com'), /must be an array/);
});

test('renderer filtering applies the persisted hostname and path patterns', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const initialPatterns = source.match(
    /let defaultExclusions = (\[[\s\S]*?\]);\s*let defaultExclusionDefaults/
  );
  assert.ok(initialPatterns);
  assert.deepEqual(
    Array.from(vm.runInNewContext(initialPatterns[1])),
    Array.from(DEFAULT_EXCLUSIONS)
  );
  const start = source.indexOf('function defaultExclusionTarget(');
  const end = source.indexOf('function applyFilter(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const context = {
    URL,
    defaultExclusionsEnabled: true,
    defaultExclusions: ['android.clients.google.com/c2dm/register3']
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}\nthis.matches = isDefaultExcludedRequest;`, context);
  assert.equal(context.matches({
    url: 'https://android.clients.google.com/c2dm/register3?app=chrome'
  }), true);
  assert.equal(context.matches({
    url: 'https://android.clients.google.com/checkin'
  }), false);
  context.defaultExclusionsEnabled = false;
  assert.equal(context.matches({
    url: 'https://android.clients.google.com/c2dm/register3'
  }), false);
});

test('Default Exclusions API is enabled by default, persists edits, and controls traffic queries', async t => {
  const { api, port, values } = await createApi(t);
  api.trafficLog.push(
    {
      id: 'background',
      method: 'POST',
      host: 'android.clients.google.com',
      path: '/c2dm/register3',
      url: 'https://android.clients.google.com/c2dm/register3'
    },
    {
      id: 'wanted',
      method: 'GET',
      host: 'example.test',
      path: '/wanted',
      url: 'https://example.test/wanted'
    }
  );

  const defaults = await requestJson(port, 'GET', '/api/default-exclusions');
  assert.equal(defaults.statusCode, 200);
  assert.equal(defaults.body.enabled, true);
  assert.equal(defaults.body.patterns.includes('android.clients.google.com/c2dm/register3'), true);
  assert.deepEqual(defaults.body.defaults, defaults.body.patterns);

  const filtered = await requestJson(port, 'GET', '/api/traffic?limit=100');
  assert.equal(filtered.body.total, 1);
  assert.deepEqual(filtered.body.requests.map(request => request.id), ['wanted']);
  assert.deepEqual(api._getHarExportTraffic().map(request => request.id), ['wanted']);

  const saved = await requestJson(port, 'PUT', '/api/default-exclusions', {
    enabled: false,
    patterns: [' EXAMPLE.TEST/private ', 'example.test/private']
  });
  assert.deepEqual(saved, {
    statusCode: 200,
    body: {
      success: true,
      enabled: false,
      patterns: ['example.test/private']
    }
  });
  assert.deepEqual(values, {
    defaultExclusionsEnabled: false,
    defaultExclusions: ['example.test/private']
  });

  const unfiltered = await requestJson(port, 'GET', '/api/traffic?limit=100');
  assert.equal(unfiltered.body.total, 2);
  assert.deepEqual(unfiltered.body.requests.map(request => request.id), ['background', 'wanted']);
});

test('Default Exclusions API rejects malformed edits without changing settings', async t => {
  const { port, values } = await createApi(t);
  const response = await requestJson(port, 'PUT', '/api/default-exclusions', {
    enabled: true,
    patterns: ['bad host name']
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /invalid hostname pattern/);
  assert.deepEqual(values, {});
});

test('Default Exclusions API reports persistence failures without claiming success', async t => {
  const { api, port, values } = await createApi(t);
  api.settings.setAll = () => { throw new Error('disk full'); };
  const response = await requestJson(port, 'PUT', '/api/default-exclusions', {
    enabled: false,
    patterns: ['example.test']
  });
  assert.deepEqual(response, {
    statusCode: 500,
    body: { error: 'disk full' }
  });
  assert.deepEqual(values, {});
});
