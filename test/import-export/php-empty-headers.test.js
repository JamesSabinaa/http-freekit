import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';
import { promisify } from 'node:util';
import { generateExportSnippet } from '../../src/ui/request-export.js';

const run = promisify(execFile);
const headers = {
  'X-Empty': '', "X-Quote'Empty": '', Accept: '',
  'X-Repeated': ['', 'middle', ''], 'X-Normal': "value 'quoted' \\ path"
};

// Decode the exact PHP single-quoted CURLOPT_HTTPHEADER entries. The multipart
// boundary expression is intentionally outside this header-value regression.
function phpHeaderValues(snippet) {
  const block = snippet.match(/CURLOPT_HTTPHEADER, \[\n([\s\S]*?)\n\]\);/);
  assert.ok(block, 'PHP export must set its captured headers');
  return [...block[1].matchAll(/^\s*'((?:\\.|[^'\\])*)',?$/gm)]
    .map(match => match[1].replace(/\\(['\\])/g, '$1'));
}

for (const bodyType of ['raw', 'urlencoded', 'multipart']) {
  test(`PHP ${bodyType} export preserves empty and repeated libcurl header values`, async t => {
    const origin = http.createServer((request, response) => {
      request.resume();
      request.once('end', () => response.end(JSON.stringify(request.rawHeaders)));
    });
    t.after(() => new Promise(resolve => origin.close(resolve)));
    await new Promise((resolve, reject) => {
      origin.once('error', reject);
      origin.listen(0, '127.0.0.1', resolve);
    });
    const url = `http://127.0.0.1:${origin.address().port}/`;
    const snippet = generateExportSnippet({
      method: 'POST', url, bodyType, requestBody: 'payload', requestHeaders: headers,
      formFields: [{ key: 'field', value: 'payload', enabled: true }]
    }, 'php');
    const lines = phpHeaderValues(snippet);
    // PHP cURL and curl -H use the same libcurl header-list convention:
    // https://curl.se/libcurl/c/CURLOPT_HTTPHEADER.html
    const { stdout } = await run(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '-q', '--noproxy', '*', '--silent', '--show-error', '--max-time', '5',
      ...lines.flatMap(line => ['-H', line]), url
    ], { timeout: 10000, windowsHide: true });
    const received = JSON.parse(stdout);
    for (const [name, value] of Object.entries(headers)) {
      const actual = received.filter((_, index) => index % 2 === 1 && received[index - 1].toLowerCase() === name.toLowerCase());
      assert.deepEqual(actual, Array.isArray(value) ? value : [value], name);
    }
    assert.ok(lines.includes('X-Empty;'));
    assert.ok(lines.includes("X-Quote'Empty;"));
    assert.deepEqual(lines.filter(line => line.startsWith('X-Repeated')), ['X-Repeated;', 'X-Repeated: middle', 'X-Repeated;']);
    assert.equal(received.some(value => value === 'X-Absent'), false);
  });
}
