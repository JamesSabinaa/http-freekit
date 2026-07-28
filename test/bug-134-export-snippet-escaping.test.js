import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const start = source.indexOf('function getExportFormFields');
const end = source.indexOf('function autoSizeExportEditor', start);
const generatorSource = source.slice(start, end);
const { generateExportSnippet } = vm.runInNewContext(
  `(() => { ${generatorSource}; return { generateExportSnippet }; })()`,
  { URL, URLSearchParams, console }
);

const shellLiteral = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const powerShellLiteral = value => `'${String(value).replace(/'/g, "''")}'`;
const phpLiteral = value => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

test('raw request exports quote every untrusted request component', () => {
  const method = 'GET`touch method-pwned`';
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
  assert.ok(powershell.includes(`-Body ${powerShellLiteral(body)}`));
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
    method: "POST'; touch method-pwned; '",
    url: "https://example.test/' ; touch url-pwned ; '",
    bodyType: 'multipart',
    requestHeaders: { 'x-test': "value'; touch header-pwned; '" },
    formFields: [{ key: "field'; touch key-pwned; '", value: "body'; touch body-pwned; '" }]
  };

  const powershell = generateExportSnippet(request, 'powershell');
  assert.ok(powershell.includes(powerShellLiteral(request.url)));
  assert.ok(powershell.includes(powerShellLiteral(request.formFields[0].key)));
  assert.ok(powershell.includes(powerShellLiteral(request.formFields[0].value)));

  const php = generateExportSnippet(request, 'php');
  assert.ok(php.includes(phpLiteral(request.url)));
  assert.ok(php.includes(phpLiteral(request.formFields[0].key)));
  assert.ok(php.includes(phpLiteral(request.formFields[0].value)));
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
  assert.ok(multipart.includes(`-F ${shellLiteral('upload=@payload.bin;type=application/octet-stream')}`));
  assert.doesNotMatch(multipart, /-F 'literal=/);
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
