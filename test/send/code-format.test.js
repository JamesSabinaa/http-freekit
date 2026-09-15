import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import beautifier from 'js-beautify';
import * as acorn from 'acorn';
import * as csstree from 'css-tree';

const source = fs.readFileSync('src/ui/app.js', 'utf8');
const start = source.indexOf('function formatCodeWithSyntaxChecks(');
const end = source.indexOf('function wrapWithLineNumbers(', start);
assert.ok(start >= 0 && end > start);
function harness(dependencies = { beautifier, acorn, csstree }) {
  const context = vm.createContext(dependencies);
  vm.runInContext(source.slice(start, end), context);
  return context;
}

test('JavaScript formatting preserves regex, templates, comments and executable behavior', () => {
  const { beautifyJs } = harness();
  for (const [code, expression, expected] of [
    ['function f(){return /a{2}/.test("aa");}', 'f()', true],
    ['function f(){return /[{};\\/]+/.test("{;/");}', 'f()', true],
    ['function f(){return 12/3/2;}', 'f()', 2],
    ['function f(){return `a;${1+2}{b}`;}', 'f()', 'a;3{b}'],
    ['function f(){return String.raw`a\\nb;{}`;}', 'f()', 'a\\nb;{}'],
    ['function f(){/* keep ;{} */return 1n+2n;}', 'f()', 3n],
    ['function f(){const obj={a:3};return obj?.a??0;}', 'f()', 3]
  ]) {
    const formatted = beautifyJs(code);
    assert.notEqual(formatted, code, code);
    assert.equal(vm.runInNewContext(formatted + '\n' + expression), expected, code);
    assert.equal(beautifyJs(formatted), formatted, code);
    if (code.includes('/* keep ;{} */')) assert.ok(formatted.includes('/* keep ;{} */'));
  }
  assert.notEqual(beautifyJs('export function f(){return /a{2}/;}'), 'export function f(){return /a{2}/;}');
});

test('CSS formatting preserves strings, escapes, URLs, selectors and nested rules', () => {
  const { beautifyCss } = harness();
  for (const code of [
    'p::before{content:"a;b";}',
    'p::before{content:"a;{b}\\\"c";}',
    'a[data-x="a;b"]{background:url("data:image/svg+xml;a;{b}");}',
    '@media (width>100px){a:hover{color:red;margin:calc(1px + 2px);}}',
    '.a{color:red;& .b{color:blue;}}'
  ]) {
    const formatted = beautifyCss(code);
    assert.notEqual(formatted, code, code);
    assert.deepEqual(csstree.toPlainObject(csstree.parse(formatted)), csstree.toPlainObject(csstree.parse(code)));
    assert.equal(beautifyCss(formatted), formatted, code);
  }
});

test('missing formatters, parsing failures and changed syntax retain the exact original', () => {
  const context = harness();
  const automaticSemicolon = 'function f(){return\n/a{2}/.test("aa");}';
  assert.equal(context.beautifyJs(automaticSemicolon), automaticSemicolon);
  for (const code of ['  function f( {  ', ' const r = /unterminated; ', ' const value = <unsupported-jsx/>; ']) {
    assert.equal(context.beautifyJs(code), code);
  }
  for (const code of [' p{content:"unterminated;} ', ' a{broken; color:red;} ',
    ' a{color:red ', ' a{color:rgb(1,2,3;} ', ' /* unfinished ',
    ' a{background:url(unfinished;} ', ' a[data-x="x"{color:red;} ']) {
    assert.equal(context.beautifyCss(code), code);
  }
  assert.equal(harness({}).beautifyJs(' const x=1; '), ' const x=1; ');
  const changed = harness({ acorn, csstree, beautifier: {
    js: () => 'const x=2;', css: () => 'p{color:blue;}'
  } });
  assert.equal(changed.beautifyJs('const x=1;'), 'const x=1;');
  assert.equal(changed.beautifyCss('p{color:red;}'), 'p{color:red;}');
});
