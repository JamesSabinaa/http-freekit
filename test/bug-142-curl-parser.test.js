import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const start = source.indexOf('function encodeCurlComponent');
const end = source.indexOf('// ============ SEND REQUEST', start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);

const context = {
  TextEncoder,
  btoa: value => Buffer.from(value, 'binary').toString('base64')
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

test('repeated cURL data options are joined in command order', () => {
  const result = context.parseCurlCommand("curl https://example.test -d 'a=1' --data-raw 'b=2' --data-binary 'c=3'");

  assert.equal(result.method, 'POST');
  assert.equal(result.body, 'a=1&b=2&c=3');
  assert.equal(result.headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('--data-urlencode encodes values before joining them', () => {
  const result = context.parseCurlCommand(
    "curl https://example.test --data-urlencode 'name=hello world!' --data-urlencode '=plain value' --data-urlencode 'emoji=✓' --data-urlencode 'whole/value'"
  );

  assert.equal(result.body, 'name=hello%20world%21&plain%20value&emoji=%E2%9C%93&whole%2Fvalue');
});

test('quoted Windows backslashes and Unicode basic auth survive parsing', () => {
  const result = context.parseCurlCommand(
    String.raw`curl https://example.test -d 'C:\temp\file' --data-raw "D:\other\file" -u 'føø:päss'`
  );

  assert.equal(result.body, String.raw`C:\temp\file&D:\other\file`);
  assert.equal(result.headers.Authorization, 'Basic ' + Buffer.from('føø:päss', 'utf8').toString('base64'));
});

test('an explicitly empty data argument does not consume the following option', () => {
  const result = context.parseCurlCommand(
    "curl https://example.test -d '' -H 'X-After: retained'"
  );

  assert.equal(result.method, 'POST');
  assert.equal(result.body, '');
  assert.equal(result.hasData, true);
  assert.equal(result.headers['X-After'], 'retained');
});

test('explicit Content-Type matching is case-insensitive', () => {
  const result = context.parseCurlCommand(
    "curl https://example.test -H 'content-type: application/json' -d '{}'"
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(result.headers)),
    { 'content-type': 'application/json' }
  );
});

test('file-backed data is rejected instead of being imported as literal text', () => {
  for (const command of [
    'curl https://example.test -d @payload.txt',
    'curl https://example.test --data-binary @payload.bin',
    'curl https://example.test --data-urlencode name@payload.txt'
  ]) {
    assert.match(context.parseCurlCommand(command).error, /File-backed/);
  }

  const raw = context.parseCurlCommand('curl https://example.test --data-raw @literal');
  assert.equal(raw.body, '@literal');
  assert.equal(raw.error, undefined);
});

test('paste handling reports parser errors and applies explicitly empty bodies', () => {
  const pasteStart = source.indexOf("document.getElementById('sendUrl')?.addEventListener('paste'");
  const pasteEnd = source.indexOf('// Resizer for Send panel split pane', pasteStart);
  const pasteSource = source.slice(pasteStart, pasteEnd);
  const errorIndex = pasteSource.indexOf('if (parsed?.error)');

  assert.notEqual(errorIndex, -1);
  assert.ok(errorIndex < pasteSource.indexOf("document.getElementById('sendUrl').value"));
  assert.match(pasteSource, /if \(parsed\.hasData\) \{\s*setSendBodyValue\(parsed\.body\)/);
});
