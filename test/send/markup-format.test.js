import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function beautifyMarkup(');
const end = source.indexOf('// Syntax-aware code formatting', start);
assert.ok(start >= 0 && end > start);
const format = vm.runInNewContext(`(${source.slice(start, end).trim()})`);

test('markup formatting preserves all inter-element text and sensitive contexts', () => {
  for (const body of [
    '<span>Hello</span><span>world</span>',
    '  <span>Hello</span> <span>world</span>  ',
    '<div>Hello</div><div>world</div>',
    '<span>Hello</span><!-- comment --><span>world</span>',
    '<span>Hello</span>&nbsp;<span>world</span>',
    '<pre> <span>a</span><span>b</span> </pre>',
    '<textarea name="body" rows="4"> <b>a</b><b>b</b> </textarea>',
    '<script>const s = "<span a=one b=two>";</script>',
    '<style>.a::before { content: "<b a=one b=two>"; }</style>',
    '<plaintext><span a=one b=two>literal markup',
    '<!-- <span a=one b=two> -->',
    '<![CDATA[<span a=one b=two>]]>',
    '<div a="one" b="two">already\nformatted</div>'
  ]) assert.equal(format(body), body, body);
});

test('markup formatting wraps only attribute separators and is idempotent', () => {
  for (const [body, expected] of [
    [' <span class="word" title="a > b">Hello</span><span>world</span> ',
      ' <span\n  class="word"\n  title="a > b">Hello</span><span>world</span> '],
    ["<input disabled name = 'a  b' value=x/>", "<input\n  disabled\n  name = 'a  b'\n  value=x/>"],
    ['<input disabled name=x />', '<input\n  disabled\n  name=x />'],
    ['<svg><path d="M 1 2" fill="red"/></svg>', '<svg><path\n  d="M 1 2"\n  fill="red"/></svg>'],
    ['<!DOCTYPE html><!-- preserve --><div a=one b=two>x</div>',
      '<!DOCTYPE html><!-- preserve --><div\n  a=one\n  b=two>x</div>'],
    ['<x a="&quot; > <tag>" b="a&#10;b"> a <y/> b </x>',
      '<x\n  a="&quot; > <tag>"\n  b="a&#10;b"> a <y/> b </x>']
  ]) {
    assert.equal(format(body), expected, body);
    assert.equal(format(expected), expected, body);
  }
});

test('ambiguous or incomplete markup remains unchanged as a whole', () => {
  for (const body of [
    '<div a=one b=two>1 < 2</div>',
    '<div a=one b=two><span title="unfinished>',
    '<div a=one b=two><!-- unfinished',
    '<div a=one b=two><span a="one"b="two">',
    '<div a=one b=two><?custom <span a=x b=y> ?>',
    '<!DOCTYPE root [<!ENTITY x "<b a=one b=two>">]><root/>',
    '<div a=one b=two><span a=>'
  ]) assert.equal(format(body), body, body);
});
