import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const start = source.indexOf('function encodeCurlDataUrlValue');
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
  const result = context.parseCurlCommand("curl https://example.test --data-urlencode 'name=hello world' --data-urlencode 'plain value'");

  assert.equal(result.body, 'name=hello%20world&plain%20value');
});

test('single-quoted backslashes and Unicode basic auth survive parsing', () => {
  const result = context.parseCurlCommand("curl https://example.test -d 'C:\\temp\\file' -u 'føø:päss'");

  assert.equal(result.body, 'C:\\temp\\file');
  assert.equal(result.headers.Authorization, 'Basic ' + Buffer.from('føø:päss', 'utf8').toString('base64'));
});
