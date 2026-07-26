import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const compactStart = source.indexOf('function formatBody(');
const compactEnd = source.indexOf('function isGrpcContentType(', compactStart);
const decodedStart = source.indexOf('function formatBodyAs(');
const decodedEnd = source.indexOf('function disposeBodyEditor(', decodedStart);

assert.notEqual(compactStart, -1);
assert.notEqual(compactEnd, -1);
assert.notEqual(decodedStart, -1);
assert.notEqual(decodedEnd, -1);

const renderers = vm.runInNewContext(`(() => {
  const esc = value => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const syntaxHighlightJson = value => esc(value);
  const syntaxHighlightXml = value => esc(value);
  ${source.slice(compactStart, compactEnd)}
  ${source.slice(decodedStart, decodedEnd)}
  return { formatBody, formatBodyAs };
})()`, { URLSearchParams, console });

const body = [
  'path%252Fname=%252Fadmin',
  'literal=%25ZZ',
  'space+name=hello+world',
  'repeat=first',
  'repeat=second',
  'markup=%3Cscript%3Ealert%281%29%3C%2Fscript%3E'
].join('&');

const expectedPairs = [
  ['path%2Fname', '%2Fadmin'],
  ['literal', '%ZZ'],
  ['space name', 'hello world'],
  ['repeat', 'first'],
  ['repeat', 'second'],
  ['markup', '&lt;script&gt;alert(1)&lt;/script&gt;']
];

test('compact URL-encoded body rendering decodes each repeated field exactly once', () => {
  const html = renderers.formatBody(body, 'application/x-www-form-urlencoded');
  const pairs = [...html.matchAll(
    /color:#4caf7d;">(.*?)<\/span><span[^>]*> = <\/span><span style="color:#ff8c38;">(.*?)<\/span>/g
  )].map(match => [match[1], match[2]]);

  assert.deepEqual(pairs, expectedPairs);
  assert.doesNotMatch(html, /<script>/);
});

test('decoded URL-encoded body view preserves one-pass values, ordering, escaping, and copy text', () => {
  const html = renderers.formatBodyAs(body, 'application/x-www-form-urlencoded', 'decoded');
  const values = [...html.matchAll(/class="url-decoded-value">(.*?)<\/div>/g)].map(match => match[1]);
  const pairs = [];
  for (let index = 0; index < values.length; index += 2) {
    pairs.push([values[index], values[index + 1]]);
  }

  assert.deepEqual(pairs, expectedPairs);
  assert.equal((html.match(/navigator\.clipboard\.writeText/g) || []).length, expectedPairs.length * 2);
  assert.equal((html.match(/\.textContent/g) || []).length, expectedPairs.length * 2);
  assert.doesNotMatch(html, /<script>/);
});
