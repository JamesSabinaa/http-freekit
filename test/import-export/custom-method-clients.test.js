import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { generateExportSnippet } from '../../src/ui/request-export.js';

test('Fetch explains forbidden methods for every body representation', () => {
  for (const method of ['CONNECT', 'TRACE', 'TRACK', 'cOnNeCt', 'trace', 'track']) {
    for (const body of [{}, { requestBody: 'text' },
      { bodyType: 'urlencoded', formFields: [{ key: 'a', value: 'b' }] },
      { bodyType: 'multipart', formFields: [{ key: 'a', value: 'b' }] }]) {
      const snippet = generateExportSnippet({ url: 'https://example.test/', method, ...body }, 'javascript-fetch');
      assert.match(snippet, /EXACT REPLAY UNAVAILABLE/);
      assert.match(snippet, /Fetch API forbids/);
      assert.doesNotMatch(snippet, /await fetch/);
    }
  }
  assert.match(generateExportSnippet({ url: 'https://example.test/', method: 'PROPFIND' }, 'javascript-fetch'), /await fetch/);
});

for (const shell of ['powershell.exe', 'pwsh.exe']) {
  const executable = shell === 'pwsh.exe'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', shell)
    : path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', shell);
  test(`${shell}: custom methods preserve headers and raw, binary and multipart bytes`, {
    skip: process.platform !== 'win32' || !fs.existsSync(executable), timeout: 45000
  }, async t => {
    const received = [];
    const sockets = new Set();
    const server = net.createServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let data = Buffer.alloc(0);
      let continued = false;
      let done = false;
      socket.on('data', chunk => {
        if (done) return;
        data = Buffer.concat([data, chunk]);
        const headerEnd = data.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const headers = data.subarray(0, headerEnd).toString();
        if (!continued && /expect: 100-continue/i.test(headers)) {
          continued = true;
          socket.write('HTTP/1.1 100 Continue\r\n\r\n');
        }
        const length = Number(headers.match(/content-length: (\d+)/i)?.[1] || 0);
        if (data.length < headerEnd + 4 + length) return;
        done = true;
        received.push({ headers, body: data.subarray(headerEnd + 4, headerEnd + 4 + length) });
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
    const text = "café ✓ 'quoted'\nnext line";
    const binary = Buffer.from([0, 255, 128, 13, 10]);
    for (const [method, body, expected] of [
      ['PROPFIND', {}, Buffer.alloc(0)],
      ['PURGE', { requestBody: text }, Buffer.from(text)],
      ["MiXeD!#$%&'*+-.^_`|~09AZ", { requestBody: text }, Buffer.from(text)],
      ['X-Custom', { requestBody: `data:application/octet-stream;base64,${binary.toString('base64')}`, requestBodyEncoding: 'base64' }, binary],
      ['PROPFIND', { bodyType: 'multipart', formFields: [{ key: 'field', value: text }, { key: 'field', value: 'second' }] }, null]
    ]) {
      const snippet = generateExportSnippet({
        method, url: `http://127.0.0.1:${server.address().port}/custom`,
        requestHeaders: { 'X-Custom': 'header-value', 'Content-Type': 'application/octet-stream' }, ...body
      }, 'powershell');
      assert.match(snippet, /System.Net.Http.HttpClient/);
      assert.doesNotMatch(snippet, /Invoke-WebRequest/);
      const script = "$ErrorActionPreference='Stop'\n" + snippet;
      const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
      t.after(() => { if (child.exitCode === null) child.kill(); });
      let stderr = '';
      child.stdout.resume();
      child.stderr.on('data', chunk => { stderr += chunk; });
      const count = received.length;
      const [code] = await once(child, 'close');
      if (shell === 'powershell.exe' && method.includes("'")) {
        assert.notEqual(code, 0);
        assert.match(stderr, /EXACT REPLAY UNAVAILABLE/);
        assert.match(stderr, /PowerShell 7/);
        assert.equal(received.length, count);
        continue;
      }
      assert.equal(code, 0, stderr);
      assert.equal(received.length, count + 1, stderr);
      const request = received.at(-1);
      assert.ok(request.headers.startsWith(method + ' /custom HTTP/1.1\r\n'), request.headers);
      assert.match(request.headers, /X-Custom: header-value/i);
      if (expected) assert.deepEqual(request.body, expected);
      else {
        const boundary = request.headers.match(/boundary=([^\r\n]+)/i)?.[1];
        assert.ok(boundary, request.headers);
        assert.equal(request.body.toString(),
          `--${boundary}\r\nContent-Disposition: form-data; name="field"\r\n\r\n${text}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="field"\r\n\r\nsecond\r\n--${boundary}--\r\n`);
      }
    }
  });
}
