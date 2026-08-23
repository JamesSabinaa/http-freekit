import assert from 'node:assert/strict';
import test from 'node:test';

import { generateExportSnippet } from '../../src/ui/request-export.js';

function request(headers, bodyType = 'raw') {
  return {
    method: 'POST',
    url: 'https://example.test/replay',
    bodyType,
    requestHeaders: headers,
    requestBody: bodyType === 'raw' ? 'payload' : undefined,
    formFields: bodyType === 'multipart' ? [{ key: 'field', value: 'value' }] : undefined
  };
}

test('Fetch exports omit browser-controlled headers with an explicit replay warning', () => {
  const cases = {
    raw: [
      'Content-Length', 'connection', 'Transfer-Encoding', 'Cookie', 'Origin',
      'Proxy-Authorization', 'Sec-Fetch-Site'
    ],
    multipart: [
      'connection', 'Cookie', 'Origin', 'Proxy-Authorization', 'Sec-Fetch-Site'
    ]
  };
  for (const [bodyType, headers] of Object.entries(cases)) {
    for (const header of headers) {
      const snippet = generateExportSnippet(request({ [header]: 'captured' }, bodyType), 'javascript-fetch');
      assert.match(snippet, /^\/\/ BROWSER-CONTROLLED HEADERS OMITTED:/);
      assert.match(snippet, new RegExp(header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
      assert.match(snippet, /await fetch\(/);
      assert.doesNotMatch(snippet, /captured/);
    }
  }
});

test('Fetch exports omit automatically rebuilt forbidden headers without disabling ordinary replay', () => {
  for (const bodyType of ['raw', 'multipart']) {
    const snippet = generateExportSnippet(request({
      Host: 'example.test',
      'Proxy-Connection': 'keep-alive'
    }, bodyType), 'javascript-fetch');
    assert.match(snippet, /await fetch\(/);
    assert.doesNotMatch(snippet, /Host|Proxy-Connection|EXACT REPLAY UNAVAILABLE/i);
  }

  const multipart = generateExportSnippet(request({
    'Content-Length': '100',
    'Transfer-Encoding': 'chunked'
  }, 'multipart'), 'javascript-fetch');
  assert.match(multipart, /await fetch\(/);
  assert.doesNotMatch(multipart, /Content-Length|Transfer-Encoding|EXACT REPLAY UNAVAILABLE/i);
});

test('Fetch exports still generate requests when all headers are script-settable', () => {
  const snippet = generateExportSnippet(request({ 'X-Custom': 'value' }), 'javascript-fetch');
  assert.match(snippet, /await fetch\(/);
  assert.match(snippet, /"X-Custom": "value"/);
  assert.doesNotMatch(snippet, /EXACT REPLAY UNAVAILABLE/);
});
