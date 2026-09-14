import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { generateExportSnippet } from '../../src/ui/request-export.js';

test('Windows PowerShell exports send UTF-8 raw text bytes', {
  skip: process.platform !== 'win32', timeout: 20000
}, async t => {
  const received = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(Buffer.concat(chunks));
    response.end('ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const body = "café ✓ 'quoted'\nnext line";
  for (const encoding of ['utf8', 'base64']) {
    const snippet = generateExportSnippet({
      method: 'POST', url: `http://127.0.0.1:${server.address().port}/`,
      requestHeaders: { 'Content-Type': 'text/plain' },
      requestBody: encoding === 'utf8' ? body : `data:application/octet-stream;base64,${Buffer.from(body).toString('base64')}`,
      requestBodyEncoding: encoding
    }, 'powershell');
    assert.doesNotMatch(snippet, /EXACT REPLAY UNAVAILABLE/);
    const previousCount = received.length;
    const script = "$ErrorActionPreference='Stop'; $PSDefaultParameterValues=@{'Invoke-WebRequest:UseBasicParsing'=$true};\n" + snippet;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
    assert.equal(received.length, previousCount + 1);
    assert.deepEqual(received.at(-1), Buffer.from(body), encoding);
  }
  assert.equal(received.length, 2);
});
