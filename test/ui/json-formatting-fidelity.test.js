import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
function harness(body) {
  const context = vm.createContext({
    body, edits: 0, toasts: [],
    document: { getElementById: () => ({ value: 'json' }) },
    getSendBodyValue: () => context.body,
    setSendBodyValue: value => { context.body = value; },
    markActiveSendBodyEdited: () => { context.edits++; },
    scheduleSendExportUpdate() {},
    toast: (message, type) => context.toasts.push({ message, type }),
    esc: value => value, syntaxHighlightJson: value => value,
    wrapWithLineNumbers: value => value,
    isBodyPlaceholder: () => false
  });
  vm.runInContext([
    section('function prettyPrintJson(', 'function tryPrettyJson('),
    section('function tryPrettyJson(', '// ============ BREAKPOINT FUNCTIONS'),
    section('function formatSendBody(', 'function createMultipartBoundary('),
    section('function getMonacoBodyValue(', 'async function initBodyMonacoEditor('),
    section('function formatBodyAs(', 'function disposeBodyEditor('),
    section('function formatBody(', 'function isGrpcContentType(')
  ].join('\n'), context);
  return context;
}

test('Send and JSON previews preserve exact tokens while indenting nested content', () => {
  const input = String.raw` { "orderId":9007199254740993,"negative":-9223372036854775808,"decimal":0.123456789012345678901,"exponent":1e400,"zero":-0,"nested":[{},[],true,false,null,{"text":"a  b, [ \" \\ \u0041"}],"duplicate":1,"duplicate":2 } `;
  const expected = String.raw`{
  "orderId": 9007199254740993,
  "negative": -9223372036854775808,
  "decimal": 0.123456789012345678901,
  "exponent": 1e400,
  "zero": -0,
  "nested": [
    {},
    [],
    true,
    false,
    null,
    {
      "text": "a  b, [ \" \\ \u0041"
    }
  ],
  "duplicate": 1,
  "duplicate": 2
}`;
  const context = harness(input);
  context.formatSendBody();
  assert.equal(context.body, expected);
  assert.equal(context.edits, 1);
  assert.equal(context.toasts[0].type, 'success');
  assert.equal(context.getMonacoBodyValue(input, 'json'), expected);
  assert.equal(context.formatBodyAs(input, 'application/json', 'json'), expected);
  assert.equal(context.formatBody(input, 'application/json'), expected);
  assert.equal(context.tryPrettyJson(input), expected);
  context.formatSendBody();
  assert.equal(context.edits, 1, 'formatting is idempotent');
});

test('JSON formatting accepts scalar values and leaves invalid input unchanged', () => {
  for (const input of ['9007199254740993', '-0', '1.2300e+99', '"a  b"', 'true', 'null', '[]', '{}']) {
    const context = harness(input);
    context.formatSendBody();
    assert.equal(context.body, input);
    assert.equal(context.toasts[0].type, 'success');
  }
  for (const input of ['{"x":01}', '{"x":1,}', '[1 2]', '"unterminated', '{']) {
    const context = harness(input);
    context.formatSendBody();
    assert.equal(context.body, input);
    assert.equal(context.edits, 0);
    assert.equal(context.toasts[0].type, 'error');
    assert.equal(context.getMonacoBodyValue(input, 'json'), input);
    assert.equal(context.formatBodyAs(input, 'application/json', 'json'), input);
  }
});
