import assert from 'node:assert/strict';
import test from 'node:test';

import { ProxyServer } from '../src/proxy/proxy-server.js';

function matches(matcher, { url = 'https://example.test/', headers = {}, body = '' } = {}) {
  return new ProxyServer(null)._evaluateMatcher(matcher, 'POST', url, headers, body);
}

test('host and hostname matchers compare DNS names case-insensitively', () => {
  assert.equal(matches(
    { type: 'host', value: 'EXAMPLE.TEST:8443' },
    { url: 'https://example.test:8443/path' }
  ), true);
  assert.equal(matches(
    { type: 'hostname', value: '*.EXAMPLE.TEST' },
    { url: 'https://api.example.test/path' }
  ), true);
  assert.equal(matches(
    { type: 'hostname', value: '*.EXAMPLE.TEST' },
    { url: 'https://notexample.test/path' }
  ), false);
});

test('header wildcard matchers escape punctuation and support repeated mixed-case headers', () => {
  const matcher = { type: 'header', name: 'X-Release', value: 'release.1+*?' };

  assert.equal(matches(matcher, {
    headers: { 'X-RELEASE': ['old', 'release.1+stable?'] }
  }), true);
  assert.equal(matches(matcher, {
    headers: { 'x-release': 'releaseX1stable' }
  }), false);
  assert.equal(matches(
    { type: 'header', name: 'X-Mode', value: '' },
    { headers: { 'x-mode': 'present' } }
  ), true);
});

test('JSON matchers ignore object property order but retain array order', () => {
  assert.equal(matches(
    { type: 'json-body-exact', value: '{"nested":{"first":1,"second":2},"enabled":true}' },
    { body: '{"enabled":true,"nested":{"second":2,"first":1}}' }
  ), true);
  assert.equal(matches(
    { type: 'json-body-exact', value: '{"items":[1,2]}' },
    { body: '{"items":[2,1]}' }
  ), false);
  assert.equal(matches(
    { type: 'json-body-includes', value: '{"nested":{"first":1,"second":2}}' },
    { body: '{"extra":true,"nested":{"second":2,"first":1}}' }
  ), true);
});

test('multipart matcher accepts quoted boundaries and reordered disposition parameters', () => {
  const boundary = 'AaB03x';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; filename="ignored.txt"; name="upload"',
    'Content-Type: text/plain',
    '',
    'matched value',
    `--${boundary}--`,
    ''
  ].join('\r\n');
  const request = {
    headers: { 'Content-Type': `multipart/form-data; charset=utf-8; boundary="${boundary}"` },
    body
  };

  assert.equal(matches(
    { type: 'multipart-form-data', name: 'upload', value: 'matched value' },
    request
  ), true);
  assert.equal(matches(
    { type: 'multipart-form-data', name: 'upload' },
    request
  ), true);
  assert.equal(matches(
    { type: 'multipart-form-data', name: 'upload', value: 'different' },
    request
  ), false);
});
