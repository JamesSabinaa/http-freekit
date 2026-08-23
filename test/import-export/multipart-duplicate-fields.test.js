import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateExportSnippet } from '../../src/ui/request-export.js';

const hostileFirstValue = "first ' \" $value; $(ignored) `tick`\\path\r\nnext";
const secondValue = 'second value';
const scalarValue = 'ordinary value';
const duplicateName = 'tag"\\name';
const fileBytes = Buffer.from([0, 1, 2, 13, 10, 127, 128, 255]);

function multipartRequest(url, fileName = 'payload.bin') {
  return {
    method: 'POST',
    url,
    bodyType: 'multipart',
    requestHeaders: { 'X-Export-Test': 'duplicate fields' },
    formFields: [
      { key: duplicateName, value: hostileFirstValue },
      { key: 'upload', type: 'file', fileName, fileType: 'application/octet-stream' },
      { key: duplicateName, value: secondValue },
      { key: 'scalar', value: scalarValue }
    ]
  };
}

function assertOrderedMarkers(snippet, markers, format) {
  let cursor = -1;
  for (const marker of markers) {
    const position = snippet.indexOf(marker, cursor + 1);
    assert.ok(position > cursor, `${format} must emit ${JSON.stringify(marker)} in source order`);
    cursor = position;
  }
}

function parseMultipart(captured) {
  const contentType = String(captured.headers['content-type'] || '');
  const boundaryMatch = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  assert.ok(boundaryMatch, `missing multipart boundary in ${contentType}`);
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const delimiter = Buffer.from(`--${boundary}`);
  const separator = Buffer.from('\r\n\r\n');
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`);
  const parts = [];
  let cursor = 0;

  while (true) {
    assert.equal(captured.body.subarray(cursor, cursor + delimiter.length).compare(delimiter), 0);
    cursor += delimiter.length;
    if (captured.body.subarray(cursor, cursor + 2).toString() === '--') break;
    assert.equal(captured.body.subarray(cursor, cursor + 2).toString(), '\r\n');
    cursor += 2;

    const headerEnd = captured.body.indexOf(separator, cursor);
    assert.ok(headerEnd >= 0, 'multipart part must contain a header terminator');
    const headers = captured.body.subarray(cursor, headerEnd).toString('utf8');
    const bodyStart = headerEnd + separator.length;
    const bodyEnd = captured.body.indexOf(nextDelimiter, bodyStart);
    assert.ok(bodyEnd >= 0, 'multipart part must end at the next boundary');

    const disposition = /^content-disposition:\s*form-data;([^\r\n]*)$/im.exec(headers);
    assert.ok(disposition, `missing content disposition in ${headers}`);
    const nameMatch = /(?:^|;)\s*name="((?:\\.|[^"])*)"/.exec(disposition[1]);
    const filenameMatch = /(?:^|;)\s*filename="((?:\\.|[^"])*)"/.exec(disposition[1]);
    assert.ok(nameMatch, `missing part name in ${headers}`);
    const unquote = value => value.replace(/\\(.)/g, '$1');
    parts.push({
      name: unquote(nameMatch[1]),
      filename: filenameMatch ? unquote(filenameMatch[1]) : null,
      headers,
      value: captured.body.subarray(bodyStart, bodyEnd)
    });
    cursor = bodyEnd + 2;
  }
  return parts;
}

async function captureRequest(runClient) {
  let resolveRequest;
  let rejectRequest;
  const requestReceived = new Promise((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('error', rejectRequest);
    request.on('end', () => {
      resolveRequest({ headers: request.headers, body: Buffer.concat(chunks) });
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const { port } = server.address();
    const clientResult = await runClient(`http://127.0.0.1:${port}/multipart`);
    assert.equal(clientResult.code, 0, clientResult.stderr);
    let timeout;
    try {
      return await Promise.race([
        requestReceived,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('timed out waiting for multipart request')), 5000);
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function runScript(executable, args, options) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { ...options, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => resolve({ code: null, stdout, stderr: error.message }));
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function powerShellExecutables() {
  const candidates = process.platform === 'win32'
    ? [
        ['PowerShell 7', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')],
        ['Windows PowerShell 5', path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]
      ]
    : [
        ['PowerShell', '/usr/bin/pwsh'],
        ['PowerShell', '/opt/microsoft/powershell/7/pwsh']
      ];
  return candidates.filter(([, executable]) => fs.existsSync(executable));
}

function assertCapturedParts(captured, expectedFilename) {
  const parts = parseMultipart(captured);
  assert.deepEqual(parts.map(part => part.name), [duplicateName, 'upload', duplicateName, 'scalar']);
  assert.equal(parts[0].value.toString('utf8'), hostileFirstValue);
  assert.equal(parts[1].filename, expectedFilename);
  assert.deepEqual(parts[1].value, fileBytes);
  assert.equal(parts[2].value.toString('utf8'), secondValue);
  assert.equal(parts[3].value.toString('utf8'), scalarValue);
}

test('PowerShell and PHP multipart snippets serialize duplicate fields as ordered parts', () => {
  const request = multipartRequest('https://example.test/multipart', "payload ' \\ file.bin");
  const powershell = generateExportSnippet(request, 'powershell');
  assert.doesNotMatch(powershell, /\$form\s*=|\$form\[/);
  assert.match(powershell, /\[System\.IO\.MemoryStream\]::new\(\)/);
  assert.match(powershell, /-ContentType \('multipart\/form-data; boundary=' \+ \$boundary\)/);
  assertOrderedMarkers(powershell, [
    "& $writeMultipartText 'first '' \" $value; $(ignored) `tick`\\path",
    '[System.IO.File]::OpenRead',
    "& $writeMultipartText 'second value'",
    "& $writeMultipartText 'ordinary value'"
  ], 'PowerShell');

  const php = generateExportSnippet(request, 'php');
  assert.doesNotMatch(php, /\$postFields\s*=|CURLFile/);
  assert.match(php, /CURLOPT_POSTFIELDS, \$body/);
  assert.match(php, /Content-Type: multipart\/form-data; boundary=' \. \$boundary/);
  assertOrderedMarkers(php, [
    "$body .= 'first \\' \" $value; $(ignored) `tick`\\\\path",
    'file_get_contents(',
    "$body .= 'second value'",
    "$body .= 'ordinary value'"
  ], 'PHP');
});

test('unsafe hand-built multipart metadata is rejected instead of injected', () => {
  for (const format of ['javascript-node', 'powershell', 'wget', 'php']) {
    for (const unsafeField of [
      { key: 'unsafe\r\nX-Injected: yes', value: 'value' },
      { key: 'file', type: 'file', fileName: 'safe.bin', fileType: 'text/plain\r\nX-Injected: yes' }
    ]) {
      const snippet = generateExportSnippet({
        method: 'POST',
        url: 'https://example.test/multipart',
        bodyType: 'multipart',
        requestHeaders: {},
        formFields: [unsafeField]
      }, format);
      assert.match(snippet, /EXACT REPLAY UNAVAILABLE/);
      assert.match(snippet, /cannot be represented safely in MIME headers/);
      assert.equal(snippet.includes('https://example.test/multipart'), false);
    }
  }
});

test('adjacent multipart formats do not collapse duplicate text names', () => {
  const request = multipartRequest('https://example.test/multipart');
  request.formFields = [
    { key: 'tag', value: 'first duplicate marker' },
    request.formFields[1],
    { key: 'tag', value: 'second duplicate marker' },
    { key: 'scalar', value: 'ordinary marker' }
  ];
  for (const format of ['curl', 'python', 'javascript-fetch', 'javascript-node', 'wget', 'go']) {
    const snippet = generateExportSnippet(request, format);
    assert.doesNotMatch(snippet, /EXACT REPLAY UNAVAILABLE/, format);
    assertOrderedMarkers(snippet, [
      'first duplicate marker',
      'second duplicate marker',
      'ordinary marker'
    ], format);
  }
});

test('cURL refuses text field names containing its form separator', () => {
  const request = multipartRequest('https://example.test/multipart');
  request.formFields = [{ key: 'left=right', value: 'value' }];
  const snippet = generateExportSnippet(request, 'curl');
  assert.match(snippet, /EXACT REPLAY UNAVAILABLE/);
  assert.match(snippet, /cannot be represented safely in cURL form syntax/);
});

test('Python multipart snippets preserve interleaved text and file part order', () => {
  const request = multipartRequest('https://example.test/multipart');
  request.formFields = [
    { key: 'tag', value: 'first duplicate marker' },
    request.formFields[1],
    { key: 'tag', value: 'second duplicate marker' },
    { key: 'scalar', value: 'ordinary marker' }
  ];

  const snippet = generateExportSnippet(request, 'python');

  assert.match(snippet, /files = \[/);
  assert.match(snippet, /files=files/);
  assert.doesNotMatch(snippet, /\bdata\s*=/);
  assertOrderedMarkers(snippet, [
    '(None, "first duplicate marker")',
    'open("payload.bin", \'rb\')',
    '(None, "second duplicate marker")',
    '(None, "ordinary marker")'
  ], 'Python');
});

test('generated PowerShell multipart requests preserve duplicate order and binary files', async t => {
  const executables = powerShellExecutables();
  if (!executables.length) {
    t.skip('PowerShell is unavailable');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freekit-multipart-powershell-'));
  const fileName = path.join(tempDir, "payload ' [one].bin");
  fs.writeFileSync(fileName, fileBytes);
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [name, executable] of executables) {
    await t.test(name, async () => {
      const captured = await captureRequest(async url => {
        const scriptPath = path.join(tempDir, `${path.basename(executable)}.ps1`);
        fs.writeFileSync(scriptPath, generateExportSnippet(multipartRequest(url, fileName), 'powershell'));
        return runScript(executable, [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath
        ], { cwd: tempDir });
      });
      assertCapturedParts(captured, fileName);
    });
  }
});

test('generated Node multipart requests preserve quoted names and binary files', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freekit-multipart-node-'));
  const fileName = path.join(tempDir, 'payload.bin');
  const scriptPath = path.join(tempDir, 'request.cjs');
  fs.writeFileSync(fileName, fileBytes);
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const captured = await captureRequest(async url => {
    fs.writeFileSync(scriptPath, generateExportSnippet(multipartRequest(url, fileName), 'javascript-node'));
    return runScript(process.execPath, [scriptPath], { cwd: tempDir });
  });
  assertCapturedParts(captured, fileName);
});

test('generated PHP multipart requests preserve duplicate order and binary files when PHP is available', async t => {
  const version = spawnSync('php', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (version.error?.code === 'ENOENT' || version.status !== 0) {
    t.skip('PHP is unavailable');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freekit-multipart-php-'));
  const fileName = path.join(tempDir, "payload ' [one].bin");
  const scriptPath = path.join(tempDir, 'request.php');
  fs.writeFileSync(fileName, fileBytes);
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const captured = await captureRequest(async url => {
    fs.writeFileSync(scriptPath, generateExportSnippet(multipartRequest(url, fileName), 'php'));
    return runScript('php', [scriptPath], { cwd: tempDir });
  });
  assertCapturedParts(captured, fileName);
});
