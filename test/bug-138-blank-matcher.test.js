import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import { ApiServer } from '../src/api/api-server.js';
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

test('the renderer requires every matcher row to be complete', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = source.indexOf('function saveMockRule');
  const end = source.indexOf('function _applyDraftToLocal', start);
  const saveSource = source.slice(start, end);

  assert.match(saveSource, /matchers\.every\(isMockMatcherComplete\)/);
  assert.doesNotMatch(saveSource, /!hasContent && mockEditDraft\.matchers\.length === 0/);
});
