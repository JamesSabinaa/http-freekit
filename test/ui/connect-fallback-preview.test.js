import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
function frame(flag, bytes) {
  const header = Buffer.alloc(5);
  header[0] = flag;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

test('Connect fallback renders messages and EndStream errors when Monaco is unavailable', async () => {
  const body = 'data:application/connect+proto;base64,' + Buffer.concat([
    frame(0, Buffer.from([8, 150, 1])),
    frame(2, Buffer.from(JSON.stringify({ error: { code: 'unavailable', message: 'Try later' } })))
  ]).toString('base64');
  const fallback = { style: {}, innerHTML: '' };
  const wrapper = { dataset: {} };
  const context = {
    TextEncoder, TextDecoder, Uint8Array, DataView, BigInt, atob,
    document: { getElementById: id => ({ body: wrapper, 'body-fallback': fallback, 'body-monaco': { style: {} } })[id] },
    console,
    esc: value => value,
    wrapWithLineNumbers: value => value,
    inferGrpcMessageType: () => null,
    inferProtobufMessageType: () => null,
    lookupProtobufType: () => null,
    getBodySchemaTypeOverride: () => '',
    updateProtobufTypeSelect: () => {},
    initBodyMonacoEditor: async () => null,
    disposeMonacoEditor: () => {},
    disposeBodyEditor: () => {},
    window: {}
  };
  vm.createContext(context);
  vm.runInContext(`
    ${section('function isGrpcContentType(', 'const activeBodyEditors = {}')}
    ${section('function headerValue(', 'function beautifyMarkup(')}
    ${section('function formatBodyAs(', 'function disposeBodyEditor(')}
    ${section('function renderBodyViewer(', '// Switch body view mode')}
    globalThis.preview = renderBodyViewer;
  `, context);
  context.preview('body', body, 'application/connect+proto', 'grpc', {
    section: 'response', request: { responseBodyEncoding: 'base64' }
  });
  await Promise.resolve();
  assert.equal(fallback.style.display, 'block');
  assert.match(fallback.innerHTML, /1: varint 150/);
  assert.match(fallback.innerHTML, /end stream:/);
  assert.match(fallback.innerHTML, /Try later/);
  assert.doesNotMatch(fallback.innerHTML, /Invalid|Unable to decode/);
});
