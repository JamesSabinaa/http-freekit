import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { ProxyServer } from '../../src/proxy/proxy-server.js';
import { validateMockRule } from '../../src/proxy/mock-rule-validation.js';

const source = fs.readFileSync('src/ui/app.js', 'utf8');
const start = source.indexOf('function changeMockActionType(');
const end = source.indexOf('function nextMockHeaderName(', start);
assert.ok(start >= 0 && end > start);

test('legacy response migration preserves response behavior without transforming requests', () => {
  const proxy = new ProxyServer(null);
  for (const bodyMode of ['original', 'replace-fixed', 'match-replace', 'json-merge']) {
    for (const [withHeaders, statusOverride] of [[false, 201], [true, 201], [false, undefined], [true, undefined]]) {
      const legacy = {
        type: 'transform-response', delay: 17, statusOverride,
        ...(withHeaders ? { headers: { 'X-Added': ['one', 'two'] }, removeHeaders: ['x-remove'] } : {}),
        bodyMode, body: bodyMode === 'json-merge' ? '{"added":true}' : 'LEGACY',
        bodyMatchPattern: 'ORIGIN', bodyReplaceWith: 'LATEST'
      };
      const context = {
        mockEditDraft: { action: structuredClone(legacy), _originalResponseBody: 'captured response', _originalRequestBody: 'captured request' },
        document: { getElementById: () => null }
      };
      vm.runInNewContext(source.slice(start, end), context);
      context.changeMockActionType('transform-request', 'test');
      const migrated = JSON.parse(JSON.stringify(context.mockEditDraft.action));
      assert.equal(validateMockRule({ matchers: [{ type: 'wildcard' }], action: migrated }), null);
      const response = { statusCode: 200, headers: { 'x-remove': 'gone', 'x-keep': 'keep' }, body: Buffer.from('{"value":"ORIGIN"}'), trailers: { 'x-trailer': 'value' } };
      assert.deepEqual(proxy._applyMockResponseTransform(migrated, response), proxy._applyMockResponseTransform(legacy, response), `${bodyMode} headers=${withHeaders}`);
      const request = { method: 'POST', url: new URL('http://example.test/'), headers: { host: 'example.test', 'x-remove': 'keep' }, body: Buffer.from('ORIGIN request') };
      const transformed = proxy._applyMockRequestTransform(migrated, request);
      assert.equal(transformed.changed, false);
      assert.deepEqual(transformed.body, request.body);
      assert.equal(transformed.headers['x-remove'], 'keep');
      assert.equal(migrated.delay, 17);
    }
  }
});
