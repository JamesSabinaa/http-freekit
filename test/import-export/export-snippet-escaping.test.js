import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateExportSnippet } from '../../src/ui/request-export.js';

const shellLiteral = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const powerShellLiteral = value => `'${String(value).replace(/'/g, "''")}'`;
const phpLiteral = value => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

test('raw request exports quote every untrusted request component', () => {
  const method = "MiXeD!#$%&'*+-.^_`|~09AZ";
  const url = 'https://example.test/a\' ; touch url-pwned ; "\\next';
  const headerValue = 'value\' ; touch header-pwned ; "\\next';
  const body = 'body\' ; touch body-pwned ; "\\next\n$(touch subshell-pwned)';
  const request = {
    method,
    url,
    host: 'example.test',
    requestHeaders: { host: 'example.test', 'x-test': headerValue },
    requestBody: body
  };

  const curl = generateExportSnippet(request, 'curl');
  assert.match(curl, new RegExp(`^curl -X ${escapeRegex(shellLiteral(method))} ${escapeRegex(shellLiteral(url))}`));
  assert.ok(curl.includes(shellLiteral(`x-test: ${headerValue}`)));
  assert.ok(curl.includes(`--data-raw ${shellLiteral(body)}`));
  assert.doesNotMatch(curl, /(?:^|\s)-d(?:\s|$)/);

  const wget = generateExportSnippet(request, 'wget');
  assert.ok(wget.includes(`--method=${shellLiteral(method)}`));
  assert.ok(wget.includes(shellLiteral(url)));
  assert.ok(wget.includes(shellLiteral(body)));

  const python = generateExportSnippet(request, 'python');
  assert.ok(python.includes(JSON.stringify(method)));
  assert.ok(python.includes(JSON.stringify(url)));
  assert.ok(python.includes(JSON.stringify(headerValue)));
  assert.ok(python.includes(JSON.stringify(body)));

  const fetchSnippet = generateExportSnippet(request, 'javascript-fetch');
  const nodeSnippet = generateExportSnippet(request, 'javascript-node');
  assert.doesNotThrow(() => new Function(`return async function () { ${fetchSnippet} }`));
  assert.doesNotThrow(() => new Function(nodeSnippet));

  const powershell = generateExportSnippet(request, 'powershell');
  assert.ok(powershell.includes(`-Uri ${powerShellLiteral(url)}`));
  assert.ok(powershell.includes(`-Method ${powerShellLiteral(method)}`));
  assert.ok(powershell.includes(`-Body ([Text.Encoding]::UTF8.GetBytes(${powerShellLiteral(body)}))`));
  assert.ok(powershell.includes(powerShellLiteral(headerValue)));

  const php = generateExportSnippet(request, 'php');
  assert.ok(php.includes(`CURLOPT_URL, ${phpLiteral(url)}`));
  assert.ok(php.includes(`CURLOPT_CUSTOMREQUEST, ${phpLiteral(method)}`));
  assert.ok(php.includes(`CURLOPT_POSTFIELDS, ${phpLiteral(body)}`));

  const go = generateExportSnippet(request, 'go');
  assert.ok(go.includes(`http.NewRequest(${JSON.stringify(method)}, ${JSON.stringify(url)}, body)`));
  assert.ok(go.includes(`strings.NewReader(${JSON.stringify(body)})`));
});

test('multipart PowerShell and PHP exports use their native safe literals', () => {
  const request = {
    method: "MiXeD'*+.^_`|~",
    url: "https://example.test/' ; touch url-pwned ; '",
    bodyType: 'multipart',
    requestHeaders: { 'x-test': "value'; touch header-pwned; '" },
    formFields: [{ key: "field'; touch key-pwned; '", value: "body'; touch body-pwned; '" }]
  };

  const powershell = generateExportSnippet(request, 'powershell');
  assert.ok(powershell.includes(powerShellLiteral(request.url)));
  assert.ok(powershell.includes(powerShellLiteral(
    `Content-Disposition: form-data; name="${request.formFields[0].key}"`
  )));
  assert.ok(powershell.includes(powerShellLiteral(request.formFields[0].value)));

  const php = generateExportSnippet(request, 'php');
  assert.ok(php.includes(phpLiteral(request.url)));
  assert.ok(php.includes(phpLiteral(
    `Content-Disposition: form-data; name="${request.formFields[0].key}"`
  )));
  assert.ok(php.includes(phpLiteral(request.formFields[0].value)));
});

test('request exports preserve omitted-method compatibility but reject explicit invalid methods', () => {
  const baseRequest = {
    url: 'https://example.test/',
    requestHeaders: {},
    requestBody: ''
  };

  assert.match(generateExportSnippet(baseRequest, 'curl'), /^curl -X 'GET' /);
  assert.match(generateExportSnippet({ ...baseRequest, bodyType: 'multipart' }, 'curl'), /^curl -X 'POST' /);

  for (const method of ['', null, '<img>', 'GET /smuggled']) {
    const raw = generateExportSnippet({ ...baseRequest, method }, 'curl');
    const multipart = generateExportSnippet({ ...baseRequest, bodyType: 'multipart', method }, 'curl');
    assert.match(raw, /^# EXACT REPLAY UNAVAILABLE/);
    assert.match(raw, /non-empty valid HTTP token/);
    assert.match(multipart, /^# EXACT REPLAY UNAVAILABLE/);
    assert.match(multipart, /non-empty valid HTTP token/);
  }
});

test('cURL exports keep leading-at bodies and multipart text fields literal', () => {
  const rawBody = '@/private/secret.txt';
  const raw = generateExportSnippet({
    method: 'POST',
    url: 'https://example.test/raw',
    requestHeaders: {},
    requestBody: rawBody
  }, 'curl');

  assert.ok(raw.includes(`--data-raw ${shellLiteral(rawBody)}`));
  assert.doesNotMatch(raw, /(?:^|\s)-(?:d|data)(?:\s|$)/);

  const multipart = generateExportSnippet({
    method: 'POST',
    url: 'https://example.test/form',
    bodyType: 'multipart',
    requestHeaders: {},
    formFields: [
      { key: 'literal', value: '@/private/secret.txt' },
      {
        key: 'upload',
        type: 'file',
        fileName: 'payload.bin',
        fileType: 'application/octet-stream'
      }
    ]
  }, 'curl');

  assert.ok(multipart.includes(`--form-string ${shellLiteral('literal=@/private/secret.txt')}`));
  assert.ok(multipart.includes(`-F ${shellLiteral('upload=@"payload.bin";type=application/octet-stream')}`));
  assert.doesNotMatch(multipart, /-F 'literal=/);
});

test('cURL multipart file metadata is quoted for cURL form parsing', () => {
  const multipart = generateExportSnippet({
    method: 'POST',
    url: 'https://example.test/form',
    bodyType: 'multipart',
    requestHeaders: {},
    formFields: [{
      key: 'upload',
      type: 'file',
      fileName: 'intended;headers=@leak-headers.txt\\"quoted.bin',
      fileType: 'application/x-review'
    }]
  }, 'curl');

  assert.ok(multipart.includes(shellLiteral(
    'upload=@"intended;headers=@leak-headers.txt\\\\\\"quoted.bin";type=application/x-review'
  )));
  assert.doesNotMatch(multipart, /@intended;headers=/);
  assert.doesNotMatch(multipart, /;type=application\/x-review;headers=/);

  const unsafeContentType = generateExportSnippet({
    method: 'POST',
    url: 'https://example.test/form',
    bodyType: 'multipart',
    requestHeaders: {},
    formFields: [{
      key: 'upload',
      type: 'file',
      fileName: 'payload.bin',
      fileType: 'application/x-review;headers=@leak-headers.txt'
    }]
  }, 'curl');
  assert.match(unsafeContentType, /^# EXACT REPLAY UNAVAILABLE/);
  assert.doesNotMatch(unsafeContentType, /(?:^|\s)-F(?:\s|$)/);
  assert.doesNotMatch(unsafeContentType, /headers=@/);

  for (const unsafeField of [
    { key: 'upload=@secret.txt', fileName: 'payload.bin', fileType: 'application/octet-stream' },
    { key: 'upload', fileName: '-', fileType: 'application/octet-stream' }
  ]) {
    const unavailable = generateExportSnippet({
      method: 'POST',
      url: 'https://example.test/form',
      bodyType: 'multipart',
      requestHeaders: {},
      formFields: [{ ...unsafeField, type: 'file' }]
    }, 'curl');
    assert.match(unavailable, /^# EXACT REPLAY UNAVAILABLE/);
    assert.doesNotMatch(unavailable, /(?:^|\s)-F(?:\s|$)/);
  }
});

test('generated cURL multipart command cannot load injected form header files', async (t) => {
  const shell = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\sh.exe' : '/bin/sh';
  if (!fs.existsSync(shell)) {
    t.skip(`POSIX shell is unavailable at ${shell}`);
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freekit-curl-form-'));
  const fileName = 'intended;headers=@leak-headers.txt';
  fs.writeFileSync(path.join(tempDir, fileName), 'INTENDED-FILE-CONTENTS');
  fs.writeFileSync(path.join(tempDir, 'leak-headers.txt'), 'X-Local-Leak: LOCAL-HEADER-FILE-READ\n');

  let receivedBody = '';
  const server = http.createServer((request, response) => {
    request.setEncoding('latin1');
    request.on('data', chunk => { receivedBody += chunk; });
    request.on('end', () => {
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const snippet = generateExportSnippet({
      method: 'POST',
      url: `http://127.0.0.1:${port}/upload`,
      bodyType: 'multipart',
      requestHeaders: {},
      formFields: [{
        key: 'upload',
        type: 'file',
        fileName,
        fileType: 'application/x-review'
      }]
    }, 'curl');

    const result = await new Promise(resolve => {
      const child = spawn(shell, ['-c', snippet], { cwd: tempDir, windowsHide: true });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => resolve({ code: null, stderr: error.message }));
      child.on('close', code => resolve({ code, stderr }));
    });

    if (result.code === null && /ENOENT/i.test(result.stderr)) {
      t.skip(`cURL is unavailable: ${result.stderr}`);
      return;
    }
    assert.equal(result.code, 0, `${result.stderr}\nGenerated snippet:\n${snippet}`);
    assert.match(receivedBody, /INTENDED-FILE-CONTENTS/);
    assert.match(receivedBody, /filename="intended;headers=@leak-headers\.txt"/);
    assert.match(receivedBody, /Content-Type: application\/x-review/i);
    assert.doesNotMatch(receivedBody, /X-Local-Leak: LOCAL-HEADER-FILE-READ/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('generated Node.js raw and multipart requests preserve mixed-case extension methods', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freekit-node-method-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const requestLines = [];
  const server = net.createServer(socket => {
    let requestHead = '';
    socket.setEncoding('latin1');
    socket.on('data', chunk => {
      if (requestLines.length >= 2 || requestHead.includes('\r\n\r\n')) return;
      requestHead += chunk;
      if (!requestHead.includes('\r\n\r\n')) return;
      requestLines.push(requestHead.slice(0, requestHead.indexOf('\r\n')));
      socket.end('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const runSnippet = (snippet, name) => new Promise((resolve, reject) => {
    const scriptPath = path.join(tempDir, `${name}.cjs`);
    fs.writeFileSync(scriptPath, snippet);
    const child = spawn(process.execPath, [scriptPath], { cwd: tempDir, windowsHide: true });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve()
      : reject(new Error(`${name} exited ${code}: ${stderr}\n${snippet}`)));
  });
  const url = `http://127.0.0.1:${server.address().port}/exact-method`;

  await runSnippet(generateExportSnippet({
    method: 'gEt',
    url,
    requestHeaders: {},
    requestBody: 'raw body'
  }, 'javascript-node'), 'raw');
  await runSnippet(generateExportSnippet({
    method: 'gEt',
    url,
    bodyType: 'multipart',
    requestHeaders: {},
    formFields: [{ key: 'field', value: 'multipart body' }]
  }, 'javascript-node'), 'multipart');

  assert.deepEqual(requestLines, [
    'gEt /exact-method HTTP/1.1',
    'gEt /exact-method HTTP/1.1'
  ]);
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
