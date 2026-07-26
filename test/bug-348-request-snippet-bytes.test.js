import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import zlib from 'node:zlib';

import { ProxyServer } from '../src/proxy/proxy-server.js';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const start = source.indexOf('function getExportFormFields');
const end = source.indexOf('function autoSizeExportEditor', start);
const { generateExportSnippet } = vm.runInNewContext(
  `(() => { ${source.slice(start, end)}; return { generateExportSnippet }; })()`,
  {
    URL,
    URLSearchParams,
    console,
    findHeaderKey: (headers, name) => Object.keys(headers || {})
      .find(key => key.toLowerCase() === name.toLowerCase())
  }
);

const formats = [
  'curl',
  'python',
  'javascript-fetch',
  'javascript-node',
  'powershell',
  'wget',
  'php',
  'go'
];

function captureRequestBody(bytes) {
  const proxy = new ProxyServer(null);
  const captured = { requestBody: proxy._safeBodyString(bytes) };
  proxy._normalizeCapturedBodies(captured);
  return captured;
}

function rawRequest(captured, headers = {}) {
  return {
    method: 'POST',
    url: 'https://example.test/upload',
    requestHeaders: headers,
    ...captured
  };
}

function assertBinaryDecoder(format, snippet, base64) {
  const expected = {
    curl: [`printf '%s' '${base64}' | base64 --decode | curl`, '--data-binary @-'],
    python: ['import base64', `base64.b64decode(${JSON.stringify(base64)})`],
    'javascript-fetch': [`Uint8Array.from(atob(${JSON.stringify(base64)})`, 'character.charCodeAt(0)'],
    'javascript-node': [`Buffer.from(${JSON.stringify(base64)}, 'base64')`],
    powershell: [`[Convert]::FromBase64String('${base64}')`],
    wget: ['body_file=$(mktemp) || exit 1', `printf '%s' '${base64}' | base64 --decode > "$body_file"`, '--body-file="$body_file"'],
    php: [`base64_decode('${base64}', true)`, 'CURLOPT_POSTFIELDS, $body'],
    go: ['"bytes"', '"encoding/base64"', `base64.StdEncoding.DecodeString(${JSON.stringify(base64)})`, 'bytes.NewReader(bodyBytes)']
  };
  for (const marker of expected[format]) assert.ok(snippet.includes(marker), `${format} missing ${marker}`);
}

test('all raw snippet formats decode binary and compressed captures back to wire bytes', async t => {
  const binary = Buffer.from([0x00, 0xff, 0x41, 0x80, 0x0a]);
  const compressed = zlib.gzipSync(Buffer.from('compressed request text', 'utf8'));

  for (const [label, bytes, extraHeaders] of [
    ['binary', binary, { 'content-type': 'application/octet-stream' }],
    ['gzip', compressed, { 'content-encoding': 'gzip' }]
  ]) {
    const captured = captureRequestBody(bytes);
    const dataUri = String(captured.requestBody);
    const base64 = bytes.toString('base64');
    assert.equal(captured.requestBodyEncoding, 'base64');
    assert.equal(dataUri, `data:application/octet-stream;base64,${base64}`);

    for (const format of formats) {
      await t.test(`${label} / ${format}`, () => {
        const snippet = generateExportSnippet(rawRequest(captured, {
          ...extraHeaders,
          'content-length': String(bytes.length)
        }), format);

        assertBinaryDecoder(format, snippet, base64);
        assert.equal(snippet.includes(dataUri), false, 'display data URI must never be sent');
        assert.match(snippet, /content-length/i);
        if (label === 'gzip') {
          assert.match(snippet, /content-encoding/i);
          assert.match(snippet, /gzip/i);
        }
      });
    }
  }
});

test('UTF-8 and legacy text bodies remain literal, including data-URI-looking text', () => {
  const literal = 'data:text/plain;base64,SGVsbG8=';

  for (const format of formats) {
    const utf8 = generateExportSnippet(rawRequest({
      requestBody: literal,
      requestBodyEncoding: 'utf8'
    }), format);
    const legacy = generateExportSnippet(rawRequest({ requestBody: literal }), format);

    assert.ok(utf8.includes(literal), `${format} dropped UTF-8 literal text`);
    assert.ok(legacy.includes(literal), `${format} dropped legacy literal text`);
    assert.doesNotMatch(utf8, /EXACT REPLAY UNAVAILABLE/);
    assert.doesNotMatch(legacy, /EXACT REPLAY UNAVAILABLE/);
  }
});

test('invalid UTF-8 request bytes use the lossless base64 capture path', () => {
  const bytes = Buffer.from([0x41, 0xff, 0x42]);
  const captured = captureRequestBody(bytes);

  assert.equal(captured.requestBodyEncoding, 'base64');
  assert.equal(
    captured.requestBody,
    `data:application/octet-stream;base64,${bytes.toString('base64')}`
  );
  assert.equal(String(captured.requestBody).includes('\ufffd'), false);
});

test('truncated text and binary captures fail closed in every format', async t => {
  const largeText = captureRequestBody(Buffer.alloc(512 * 1024 + 1, 0x41));
  const largeBinary = captureRequestBody(Buffer.alloc(2 * 1024 * 1024, 0x00));

  assert.equal(largeText.requestBodyTruncated, true);
  assert.equal(largeBinary.requestBodyTruncated, true);
  assert.match(largeBinary.requestBody, /^\[Binary data:/);

  for (const [label, captured, forbidden] of [
    ['text', largeText, 'AAAAAAAAAAAA'],
    ['binary', largeBinary, '[Binary data:']
  ]) {
    for (const format of formats) {
      await t.test(`${label} / ${format}`, () => {
        const snippet = generateExportSnippet(rawRequest(captured), format);
        assert.match(snippet, /EXACT REPLAY UNAVAILABLE/);
        assert.match(snippet, /original bytes cannot be replayed/);
        assert.match(snippet, /No request was generated/);
        assert.equal(snippet.includes(forbidden), false);
        assert.equal(snippet.includes('https://example.test/upload'), false);
      });
    }
  }
});

test('malformed base64 provenance fails closed instead of sending display text', async t => {
  const malformedBodies = [
    'not-a-data-uri',
    'data:application/octet-stream;base64,%%%',
    'data:application/octet-stream;base64,AAA',
    'data:application/octet-stream;base64,A==='
  ];

  for (const format of formats) {
    await t.test(format, () => {
      for (const requestBody of malformedBodies) {
        const snippet = generateExportSnippet(rawRequest({
          requestBody,
          requestBodyEncoding: 'base64'
        }), format);
        assert.match(snippet, /EXACT REPLAY UNAVAILABLE/);
        assert.match(snippet, /invalid base64 metadata/);
        assert.match(snippet, /No request was generated/);
        assert.equal(snippet.includes(requestBody), false);
        assert.equal(snippet.includes('https://example.test/upload'), false);
      }
    });
  }
});

test('empty bodies and structured Send exports retain their existing paths', () => {
  for (const format of formats) {
    const emptyUtf8 = generateExportSnippet(rawRequest({
      requestBody: '',
      requestBodyEncoding: 'utf8'
    }), format);
    const emptyLegacy = generateExportSnippet(rawRequest({ requestBody: '' }), format);
    const emptyBase64 = generateExportSnippet(rawRequest({
      requestBody: 'data:application/octet-stream;base64,',
      requestBodyEncoding: 'base64'
    }), format);
    assert.equal(emptyUtf8, emptyLegacy);
    assert.equal(emptyBase64, emptyLegacy);

    const urlencoded = generateExportSnippet({
      ...rawRequest({
        requestBody: 'ignored display body',
        requestBodyEncoding: 'base64',
        requestBodyTruncated: true
      }),
      bodyType: 'urlencoded',
      formFields: [{ key: 'field', value: 'structured value' }]
    }, format);
    const multipart = generateExportSnippet({
      ...rawRequest({
        requestBody: '[Binary data: unavailable]',
        requestBodyEncoding: 'base64',
        requestBodyTruncated: true
      }),
      bodyType: 'multipart',
      formFields: [{ key: 'field', value: 'structured value' }]
    }, format);

    assert.doesNotMatch(urlencoded, /EXACT REPLAY UNAVAILABLE/);
    assert.match(urlencoded, /field/);
    assert.doesNotMatch(multipart, /EXACT REPLAY UNAVAILABLE/);
    assert.match(multipart, /structured value/);
  }
});
