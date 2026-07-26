import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const filterStart = rendererSource.indexOf('function parseFilters(');
const filterEnd = rendererSource.indexOf('function showFilterHint(', filterStart);
assert.notEqual(filterStart, -1);
assert.notEqual(filterEnd, -1);

const context = {};
vm.createContext(context);
vm.runInContext(rendererSource.slice(filterStart, filterEnd), context);

function matches(request, rawFilter) {
  return context.matchesAllFilters(request, context.parseFilters(rawFilter));
}

const request = {
  method: 'POST',
  requestHeaders: {
    'X-Shared': 'request-only',
    'X-Mixed-Case': 'Alpha',
    'X-Empty': '',
    'X-Count': 0
  },
  responseHeaders: {
    'x-shared': 'response=token',
    'Set-Cookie': ['session=abc==; Path=/', 'theme=dark'],
    'X-Response-Empty': ''
  }
};

test('header filters safely search every value in a multi-valued header', () => {
  assert.doesNotThrow(() => matches(request, 'header:set-cookie=theme=dark'));
  assert.equal(matches(request, 'header:set-cookie=theme=dark'), true);
  assert.equal(matches(request, 'header:set-cookie=missing'), false);
});

test('header filters search same-named request and response headers independently', () => {
  assert.equal(matches(request, 'header:x-shared=request-only'), true);
  assert.equal(matches(request, 'header:x-shared=response=token'), true);
  assert.equal(matches(request, 'header:x-shared=absent'), false);
});

test('header names are case-insensitive and present empty values remain discoverable', () => {
  assert.equal(matches(request, 'header:x-MIXED-case=alpha'), true);
  assert.equal(matches(request, 'header:X-EMPTY'), true);
  assert.equal(matches(request, 'header:x-empty='), true);
  assert.equal(matches(request, 'header:x-response-empty'), true);
  assert.equal(matches(request, 'header:x-count=0'), true);
  assert.equal(matches(request, 'header:not-present'), false);
});

test('header filters split on only the first equals sign and retain AND semantics', () => {
  assert.equal(matches(request, 'header:set-cookie=session=abc=='), true);
  assert.equal(matches(request, 'method:post header:set-cookie=session=abc=='), true);
  assert.equal(matches(request, 'method:get header:set-cookie=session=abc=='), false);
});
