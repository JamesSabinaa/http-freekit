import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const start = source.indexOf('function buildMcpTrafficFilters(');
const end = source.indexOf('function showFilterHint()', start);
assert.ok(start >= 0 && end > start, 'MCP renderer filter helpers must be present');

const context = {};
vm.createContext(context);
vm.runInContext(`
  ${source.slice(start, end)}
  globalThis.filterApi = { build: buildMcpTrafficFilters, matches: matchesAllFilters };
`, context);

function matches(request, spec) {
  return context.filterApi.matches(request, context.filterApi.build(spec));
}

test('renderer treats an MCP query as one literal over the MCP field set', () => {
  const phrase = {
    method: 'POST',
    statusCode: 201,
    url: 'https://example.test/messages',
    host: 'example.test',
    path: '/messages',
    responseBody: 'The value is hello world today'
  };
  assert.equal(matches(phrase, { query: 'hello world' }), true);
  assert.equal(matches({ ...phrase, responseBody: 'hello brave world' }, { query: 'hello world' }), false);

  const structuredLookingLiteral = { ...phrase, responseBody: 'literal host:other.test marker' };
  assert.equal(matches(structuredLookingLiteral, { query: 'host:other.test' }), true);
  assert.equal(matches({ ...phrase, host: 'other.test' }, { query: 'host:other.test' }), false);
});

test('renderer MCP matching excludes UI-only header and source fields', () => {
  const request = {
    method: 'GET',
    statusCode: 200,
    url: 'https://example.test/',
    host: 'example.test',
    path: '/',
    source: 'header-only-needle',
    requestHeaders: { 'x-test': 'header-only-needle' },
    requestBody: '',
    responseBody: ''
  };
  assert.equal(matches(request, { query: 'header-only-needle' }), false);
  assert.equal(matches(request, { method: 'GET', status: '2xx', host: 'example' }), true);
});
