import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function isGrpcContentType(');
const end = source.indexOf('function contentTypeToMonacoLanguage(', start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
const modes = (body, type) => Array.from(context.getBodyViewModes(body, type), mode => mode.value);

test('explicit JSON media types retain JSON views for query URLs in arrays and strings', () => {
  for (const type of ['application/json', 'Application/JSON; charset=utf-8', 'application/problem+json']) {
    for (const body of ['["https://example.com/?a=1&b=2"]', '"https://example.com/?a=1&b=2"', '{"url":"/?a=1&b=2"}']) {
      assert.deepEqual(modes(body, type), ['json', 'text', 'hex']);
    }
  }
});

test('recognized media types take priority over content heuristics', () => {
  for (const [type, expected] of [
    ['application/x-www-form-urlencoded', 'decoded'],
    ['text/javascript', 'javascript'], ['text/css', 'css'],
    ['application/xml', 'markup'], ['text/html', 'markup'],
    ['text/markdown', 'markdown'], ['application/yaml', 'yaml']
  ]) {
    for (const body of ['a=1&b=2', '["a=1&b=2"]']) {
      assert.equal(modes(body, type)[0], expected, type);
    }
  }
});

test('fallback detection retains JSON arrays, forms, markup, and plain text', () => {
  for (const type of ['', 'text/plain']) {
    assert.equal(modes('["https://example.com/?a=1&b=2"]', type)[0], 'json');
    assert.deepEqual(modes('a=1&b=2', type), ['decoded', 'raw', 'hex']);
    assert.equal(modes('<p>a=1&b=2</p>', type)[0], 'markup');
    assert.deepEqual(modes('ordinary text', type), ['text', 'hex']);
  }
});
