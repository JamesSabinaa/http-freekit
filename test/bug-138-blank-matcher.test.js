import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../src/api/api-server.js';
import { isCompleteMockMatcher } from '../src/proxy/mock-rule-validation.js';
import { ProxyServer } from '../src/proxy/proxy-server.js';

function postJson(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/mock-rules',
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

test('blank broad matchers never match traffic at runtime', () => {
  const proxy = new ProxyServer(null);
  const inputs = ['path', 'url-contains', 'body-contains', 'regex-path', 'regex-url', 'regex-body'];

  for (const type of inputs) {
    assert.equal(proxy._evaluateMatcher({ type, value: '' }, 'GET', 'https://example.test/path', {}, 'body'), false, type);
    assert.equal(proxy._evaluateMatcher({ type, value: '   ' }, 'GET', 'https://example.test/path', {}, 'body'), false, type);
  }
});

test('exact-empty matchers distinguish an explicit empty value from a missing one', () => {
  const proxy = new ProxyServer(null);

  assert.equal(isCompleteMockMatcher({ type: 'exact-query' }), false);
  assert.equal(isCompleteMockMatcher({ type: 'exact-query', value: '' }), true);
  assert.equal(isCompleteMockMatcher({ type: 'raw-body-exact' }), false);
  assert.equal(isCompleteMockMatcher({ type: 'raw-body-exact', value: '' }), true);

  assert.equal(proxy._evaluateMatcher(
    { type: 'exact-query', value: '' }, 'GET', 'https://example.test/path', {}, ''
  ), true);
  assert.equal(proxy._evaluateMatcher(
    { type: 'exact-query' }, 'GET', 'https://example.test/path', {}, ''
  ), false);
  assert.equal(proxy._evaluateMatcher(
    { type: 'raw-body-exact', value: '' }, 'POST', 'https://example.test/path', {}, ''
  ), true);
  assert.equal(proxy._evaluateMatcher(
    { type: 'raw-body-exact' }, 'POST', 'https://example.test/path', {}, ''
  ), false);
});

test('legacy internal empty matcher arrays retain their explicit match-all behavior', () => {
  const proxy = new ProxyServer(null);
  const rule = { enabled: true, matchers: [], action: { type: 'fixed-response' } };
  proxy.mockRules = [rule];

  assert.equal(proxy._findMockRule('GET', 'https://example.test/path', {}, ''), rule);
});

test('the mock API rejects empty and incomplete matcher arrays', async t => {
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const empty = await postJson(server.address().port, { matchers: [], action: { type: 'passthrough' } });
  const blank = await postJson(server.address().port, {
    matchers: [{ type: 'url-contains', value: '' }],
    action: { type: 'passthrough' }
  });

  assert.equal(empty.statusCode, 400);
  assert.equal(blank.statusCode, 400);
  assert.deepEqual(proxy.mockRules, []);
});

test('the mock API requires explicit values for exact-empty matchers', async t => {
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  for (const type of ['exact-query', 'raw-body-exact']) {
    const missing = await postJson(server.address().port, {
      matchers: [{ type }],
      action: { type: 'passthrough' }
    });
    const explicitEmpty = await postJson(server.address().port, {
      matchers: [{ type, value: '' }],
      action: { type: 'passthrough' }
    });
    assert.equal(missing.statusCode, 400, type);
    assert.equal(explicitEmpty.statusCode, 200, type);
  }
  assert.equal(proxy.mockRules.length, 2);
});

test('the renderer requires every matcher row to be complete', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = source.indexOf('function saveMockRule');
  const end = source.indexOf('function _applyDraftToLocal', start);
  const saveSource = source.slice(start, end);
  const completeStart = source.indexOf('function isMockMatcherComplete');
  const completeEnd = source.indexOf('function saveMockRule', completeStart);
  const completeSource = source.slice(completeStart, completeEnd);

  assert.match(saveSource, /matchers\.every\(isMockMatcherComplete\)/);
  assert.match(completeSource, /\['raw-body-exact', 'exact-query'\]\.includes\(matcher\.type\)/);
  assert.match(completeSource, /typeof matcher\.value === 'string'/);
  assert.doesNotMatch(saveSource, /!hasContent && mockEditDraft\.matchers\.length === 0/);
});

test('the renderer initializes exact-empty matcher values explicitly', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = source.indexOf('function updateMockMatcher');
  const end = source.indexOf('function addMockMatcher', start);
  const updateSource = source.slice(start, end);
  const context = {};
  vm.runInNewContext(`
    let mockEditDraft = { matchers: [{ type: 'path', value: '/' }] };
    function rerenderMockMatchers() {}
    ${updateSource}
    globalThis.harness = {
      setType(type) {
        updateMockMatcher(0, 'type', type, 'editor');
        return { ...mockEditDraft.matchers[0] };
      }
    };
  `, context);

  for (const type of ['exact-query', 'raw-body-exact']) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(context.harness.setType(type))),
      { type, value: '' }
    );
  }
});
