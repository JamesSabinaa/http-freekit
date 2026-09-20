import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { promisify } from 'node:util';
import { generateExportSnippet } from '../../src/ui/request-export.js';

const run = promisify(execFile);
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : '/bin/sh';

test('generated cURL HEAD exports complete when the response advertises a nonzero representation length', async t => {
  if (!fs.existsSync(shell)) return t.skip('POSIX shell is unavailable');
  const received = [];
  const origin = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received.push({ method: req.method, body: Buffer.concat(chunks).toString(), header: req.headers['x-marker'] });
      res.writeHead(200, { 'Content-Length': 5, Connection: 'close' });
      res.end(req.method === 'HEAD' ? undefined : 'hello');
    });
  });
  t.after(() => new Promise(resolve => origin.close(resolve)));
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  for (const method of ['HEAD', 'GET', 'POST']) {
    for (const bodyType of ['raw', 'urlencoded']) {
      const snippet = generateExportSnippet({
        method, bodyType, url: `http://127.0.0.1:${origin.address().port}/`,
        requestHeaders: { 'X-Marker': 'kept' }, formFields: [], requestBody: ''
      }, 'curl');
      const { stdout } = await run(shell, ['-c', snippet.replace(/^curl /,
        'curl -q --noproxy "*" --silent --show-error --max-time 5 ')], { windowsHide: true, timeout: 10000 });
      assert.deepEqual(received.at(-1), { method, body: '', header: 'kept' });
      if (method === 'HEAD') assert.match(stdout, /HTTP\/1\.1 200 OK/);
      else assert.equal(stdout, 'hello');
    }
  }
});

test('PHP bodyless HEAD exports enable libcurl HEAD response semantics', () => {
  for (const bodyType of ['raw', 'urlencoded']) {
    const snippet = generateExportSnippet({ method: 'HEAD', bodyType, url: 'http://example.test/', formFields: [] }, 'php');
    assert.match(snippet, /curl_setopt\(\$ch, CURLOPT_NOBODY, true\);/);
    assert.doesNotMatch(snippet, /CURLOPT_POSTFIELDS/);
  }
  const ordinary = generateExportSnippet({ method: 'GET', url: 'http://example.test/' }, 'php');
  assert.doesNotMatch(ordinary, /CURLOPT_NOBODY/);
});

test('cURL and PHP explain HEAD upload limitations instead of dropping the request body', () => {
  for (const format of ['curl', 'php']) {
    for (const body of [
      { requestBody: 'payload' },
      { requestBody: 'data:application/octet-stream;base64,AP+A', requestBodyEncoding: 'base64' },
      { bodyType: 'urlencoded', formFields: [{ key: 'field', value: 'payload' }] },
      { bodyType: 'multipart', formFields: [] },
      { bodyType: 'multipart', formFields: [{ key: 'field', value: 'payload' }] }
    ]) {
      const snippet = generateExportSnippet({ method: 'HEAD', url: 'http://example.test/', ...body }, format);
      assert.match(snippet, /EXACT REPLAY UNAVAILABLE/);
      assert.match(snippet, /HEAD.*request body/);
      assert.doesNotMatch(snippet, /curl_exec|curl -/);
    }
  }
});
