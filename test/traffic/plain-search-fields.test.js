import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const start = source.indexOf('    function parseFilters(raw) {');
const end = source.indexOf('    function showFilterHint() {', start);
assert.notEqual(start, -1, 'filter parser not found');
assert.notEqual(end, -1, 'filter matcher boundary not found');

const context = vm.createContext({});
vm.runInContext(
  `${source.slice(start, end)}\nthis.matchesFilter = matchesFilter; this.parseFilters = parseFilters;`,
  context
);
const { matchesFilter, parseFilters } = context;

const request = {
  url: 'https://ordinary.example/path',
  method: 'POST',
  host: 'ordinary.example',
  statusCode: 200,
  path: '/path',
  source: 'proxy',
  requestHeaders: {
    'X-Request-Name-Token': 'ordinary-request-value',
    'x-request-value': 'Request-Scalar-Token',
    'x-request-array': ['first', 'Request-Array-Token'],
    'x-request-number': 194
  },
  responseHeaders: {
    'X-Response-Name-Token': 'ordinary-response-value',
    'x-response-scalar': 'Response-Scalar-Token',
    'x-response-value': ['first', 'Response-Array-Token'],
    'x-null-value': null
  },
  requestBody: 'Unique Request Body Token',
  responseBody: 'Unique Response Body Token'
};

function plainTextMatches(value, target = request) {
  return matchesFilter(target, { type: 'text', value });
}

test('plain renderer search includes request and response header names and values', () => {
  assert.equal(plainTextMatches('request-name-token'), true);
  assert.equal(plainTextMatches('REQUEST-SCALAR-TOKEN'), true);
  assert.equal(plainTextMatches('request-array-token'), true);
  assert.equal(plainTextMatches('response-name-token'), true);
  assert.equal(plainTextMatches('response-scalar-token'), true);
  assert.equal(plainTextMatches('RESPONSE-ARRAY-TOKEN'), true);
  assert.equal(plainTextMatches('194'), true);
});

test('plain renderer search includes request and response bodies case-insensitively', () => {
  assert.equal(plainTextMatches('unique request BODY token'), true);
  assert.equal(plainTextMatches('UNIQUE RESPONSE BODY TOKEN'), true);
});

test('plain renderer search preserves existing fields and rejects absent text', () => {
  for (const token of ['https://ordinary', 'post', 'ordinary.example', '200', '/path', 'proxy']) {
    assert.equal(plainTextMatches(token), true, token);
  }
  assert.equal(plainTextMatches('token-that-is-not-present'), false);
});

test('plain search expansion does not change filter parsing', () => {
  assert.equal(
    JSON.stringify(parseFilters('needle method:POST body:"two words"')),
    JSON.stringify([
      { type: 'text', value: 'needle' },
      { type: 'method', value: 'POST' },
      { type: 'body', value: 'two words' }
    ])
  );
});

test('plain renderer search safely ignores null and object field values', () => {
  const malformed = {
    url: {},
    method: null,
    host: ['not', 'a', 'host'],
    statusCode: null,
    path: { nested: true },
    source: undefined,
    requestHeaders: { 'x-null': null, 'x-object': { nested: true } },
    responseHeaders: null,
    requestBody: { nested: true },
    responseBody: null
  };
  assert.doesNotThrow(() => plainTextMatches('anything', malformed));
  assert.equal(plainTextMatches('anything', malformed), false);
});
