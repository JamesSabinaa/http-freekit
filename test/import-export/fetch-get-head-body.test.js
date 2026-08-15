import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import zlib from 'node:zlib';

import { generateExportSnippet } from '../../src/ui/request-export.js';

function request(overrides = {}) {
  return {
    method: 'GET',
    url: 'https://example.test/resource',
    bodyType: 'raw',
    requestHeaders: { 'X-Export-Test': 'fetch GET body' },
    requestBody: '',
    requestBodyEncoding: 'utf8',
    ...overrides
  };
}

function executeFetchSnippet(req) {
  const fetchCalls = [];
  const context = vm.createContext({
    URLSearchParams,
    FormData: class FormDataStub {},
    async fetch(url, options) {
      fetchCalls.push({ url, options });
      return { status: 204, text: async () => '' };
    },
    console: { log() {} }
  });
  const snippet = generateExportSnippet(req, 'javascript-fetch');
  const completion = vm.runInContext(`(async () => {\n${snippet}\n})()`, context);
  return { completion, fetchCalls, snippet };
}

test('empty GET and HEAD Fetch exports execute without a body', async t => {
  const cases = [
    ['GET raw', request({ method: 'GET' })],
    ['mixed-case HEAD raw', request({ method: 'HeAd' })],
    ['lower-case GET URL-encoded', request({
      method: 'get',
      bodyType: 'urlencoded',
      formFields: []
    })]
  ];

  for (const [name, req] of cases) {
    await t.test(name, async () => {
      const { completion, fetchCalls, snippet } = executeFetchSnippet(req);
      await completion;

      assert.doesNotMatch(snippet, /EXACT REPLAY UNAVAILABLE/);
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0].options.method, req.method);
      assert.equal(Object.hasOwn(fetchCalls[0].options, 'body'), false);
    });
  }
});

test('body-bearing GET and HEAD Fetch exports fail closed before fetch', async t => {
  const binary = Buffer.from([0x00, 0xff, 0x41]).toString('base64');
  const compressed = zlib.gzipSync(Buffer.from('compressed request body')).toString('base64');
  const cases = [
    ['raw GET', request({ requestBody: 'raw body' })],
    ['binary mixed-case GET', request({
      method: 'gEt',
      requestBody: `data:application/octet-stream;base64,${binary}`,
      requestBodyEncoding: 'base64'
    })],
    ['compressed HEAD', request({
      method: 'head',
      requestHeaders: { 'Content-Encoding': 'gzip' },
      requestBody: `data:application/octet-stream;base64,${compressed}`,
      requestBodyEncoding: 'base64'
    })],
    ['URL-encoded HEAD', request({
      method: 'HEAD',
      bodyType: 'urlencoded',
      formFields: [{ key: 'field', value: 'value' }]
    })],
    ['multipart mixed-case HEAD', request({
      method: 'hEaD',
      bodyType: 'multipart',
      formFields: [{ key: 'field', value: 'value' }]
    })],
    ['empty multipart GET', request({
      method: 'GET',
      bodyType: 'multipart',
      formFields: []
    })]
  ];

  for (const [name, req] of cases) {
    await t.test(name, async () => {
      const { completion, fetchCalls, snippet } = executeFetchSnippet(req);
      await completion;

      assert.match(snippet, /EXACT REPLAY UNAVAILABLE/);
      assert.match(snippet, /browser Fetch API rejects request bodies for (?:GET|HEAD) requests/);
      assert.match(snippet, /No request was generated/);
      assert.equal(snippet.includes(req.url), false);
      assert.deepEqual(fetchCalls, []);
    });
  }
});

test('invalid body provenance takes precedence over the Fetch method limitation', () => {
  const truncated = generateExportSnippet(request({
    method: 'GET',
    requestBody: 'partial body',
    requestBodyTruncated: true
  }), 'javascript-fetch');
  assert.match(truncated, /captured request body is incomplete/);
  assert.doesNotMatch(truncated, /Fetch API rejects request bodies/);

  const malformedBinary = generateExportSnippet(request({
    method: 'HEAD',
    requestBody: 'data:application\/octet-stream;base64,%%%',
    requestBodyEncoding: 'base64'
  }), 'javascript-fetch');
  assert.match(malformedBinary, /invalid base64 metadata/);
  assert.doesNotMatch(malformedBinary, /Fetch API rejects request bodies/);
});

test('POST Fetch and non-Fetch GET body exports retain body replay', async () => {
  const post = executeFetchSnippet(request({ method: 'POST', requestBody: 'post body' }));
  await post.completion;
  assert.equal(post.fetchCalls.length, 1);
  assert.equal(post.fetchCalls[0].options.body, 'post body');

  for (const format of ['curl', 'python', 'javascript-node', 'powershell', 'wget', 'php', 'go']) {
    const snippet = generateExportSnippet(request({ method: 'GET', requestBody: 'get body' }), format);
    assert.doesNotMatch(snippet, /EXACT REPLAY UNAVAILABLE/, format);
    assert.ok(snippet.includes('get body'), `${format} must retain the captured body`);
  }
});
