import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function sourceSection(startMarker, endMarker) {
  const start = rendererSource.indexOf(startMarker);
  const end = rendererSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} section must be present`);
  return rendererSource.slice(start, end);
}

const responseAndWebhookSource = sourceSection(
  'function nextMockHeaderName(',
  'function mockRuleDraftComparable('
);
const transformSource = sourceSection(
  'function _getTransformHeadersProp(',
  'function rerenderMockActionConfig('
);

function createHarness(action) {
  const context = {
    __draft: { action },
    document: { getElementById: () => null }
  };
  vm.createContext(context);
  vm.runInContext(`
    let mockEditDraft = globalThis.__draft;
    ${responseAndWebhookSource}
    ${transformSource}
    globalThis.headerApi = {
      nextMockHeaderName,
      addMockRespHeader,
      addMockWebhookHeader,
      addMockTransformHeader,
      updateMockRespHeader,
      updateMockWebhookHeader,
      updateMockTransformHeader,
      removeMockRespHeader,
      removeMockWebhookHeader,
      removeMockTransformHeader,
      rows: mockHeaderEditorRows,
      getDraft: () => mockEditDraft
    };
  `, context);
  return context.headerApi;
}

test('fixed-response Add Header creates distinct empty rows on consecutive clicks', () => {
  const api = createHarness({});

  api.addMockRespHeader('fixed');
  api.addMockRespHeader('fixed');
  api.addMockRespHeader('fixed');

  const headers = api.getDraft().action.headers;
  assert.deepEqual(Object.keys(headers), ['X-Custom', 'X-Custom-1', 'X-Custom-2']);
  assert.deepEqual(Object.values(headers), ['', '', '']);
});

test('webhook Add Header allocates against case-insensitive own names with empty values', () => {
  const api = createHarness({
    webhookHeaders: JSON.parse('{"x-custom":"","X-CUSTOM-1":""}')
  });

  api.addMockWebhookHeader('webhook');

  const headers = api.getDraft().action.webhookHeaders;
  assert.equal(Object.keys(headers).length, 3);
  assert.equal(Object.hasOwn(headers, 'X-Custom-2'), true);
  assert.equal(headers['X-Custom-2'], '');
});

test('request and response transform Add Header controls share the allocator', () => {
  const api = createHarness({
    headers: JSON.parse('{"x-CuStOm":""}'),
    resHeaders: JSON.parse('{"X-Custom":"","x-custom-1":""}')
  });

  api.addMockTransformHeader('req', 'request-transform');
  api.addMockTransformHeader('req', 'request-transform');
  api.addMockTransformHeader('res', 'response-transform');

  const { headers, resHeaders } = api.getDraft().action;
  assert.deepEqual(Object.keys(headers), ['x-CuStOm', 'X-Custom-1', 'X-Custom-2']);
  assert.deepEqual(Object.keys(resHeaders), ['X-Custom', 'x-custom-1', 'X-Custom-2']);
});

test('the allocator ignores inherited names and considers only own header keys', () => {
  const api = createHarness({});
  const headers = Object.create({ 'x-custom': 'inherited' });
  Object.defineProperty(headers, 'X-CUSTOM-1', {
    configurable: true,
    enumerable: false,
    value: ''
  });

  assert.equal(api.nextMockHeaderName(headers), 'X-Custom');
  Object.defineProperty(headers, 'x-CUSTOM', {
    configurable: true,
    enumerable: false,
    value: ''
  });
  assert.equal(api.nextMockHeaderName(headers), 'X-Custom-2');
});

for (const kind of ['fixed', 'webhook', 'req', 'res']) {
  test(`${kind} header renames preserve visible row identity through edit, add and remove`, () => {
    const prop = kind === 'webhook' ? 'webhookHeaders' : kind === 'res' ? 'resHeaders' : 'headers';
    const api = createHarness({ [prop]: { 'X-A': 'one', 'X-B': 'two', 'X-C': 'three' } });
    const update = (...args) => kind === 'fixed' ? api.updateMockRespHeader(...args)
      : kind === 'webhook' ? api.updateMockWebhookHeader(...args)
      : api.updateMockTransformHeader(kind, ...args);
    const add = () => kind === 'fixed' ? api.addMockRespHeader('editor')
      : kind === 'webhook' ? api.addMockWebhookHeader('editor')
      : api.addMockTransformHeader(kind, 'editor');
    const remove = index => kind === 'fixed' ? api.removeMockRespHeader(index, 'editor')
      : kind === 'webhook' ? api.removeMockWebhookHeader(index, 'editor')
      : api.removeMockTransformHeader(kind, index, 'editor');
    update(2, 'key', 'X-A', 'editor');
    update(1, 'val', 'edited-B', 'editor');
    assert.deepEqual(JSON.parse(JSON.stringify(api.getDraft().action[prop])), {
      'X-A': ['one', 'three'], 'X-B': 'edited-B'
    });
    add();
    assert.deepEqual(Array.from(api.rows(api.getDraft().action[prop]), row => row.name),
      ['X-A', 'X-B', 'X-A', 'X-Custom']);
    update(2, 'val', 'edited-third', 'editor');
    remove(0);
    assert.deepEqual(JSON.parse(JSON.stringify(api.getDraft().action[prop])), {
      'X-B': 'edited-B', 'X-A': 'edited-third', 'X-Custom': ''
    });
  });
}

test('repeated fixed and transform headers remain distinct editable values', () => {
  const api = createHarness({
    headers: { 'Set-Cookie': ['first=1', 'second=2'] },
    resHeaders: { Warning: ['199 first', '299 second'] },
    webhookHeaders: { 'X-Hook': ['one', 'two'] }
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(api.rows(api.getDraft().action.headers))),
    [
      { name: 'Set-Cookie', value: 'first=1' },
      { name: 'Set-Cookie', value: 'second=2' }
    ]
  );

  api.updateMockRespHeader(1, 'val', 'second=updated', 'fixed');
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.getDraft().action.headers)),
    { 'Set-Cookie': ['first=1', 'second=updated'] }
  );

  api.updateMockTransformHeader('res', 0, 'val', '199 updated', 'transform');
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.getDraft().action.resHeaders)),
    { Warning: ['199 updated', '299 second'] }
  );

  api.updateMockWebhookHeader(1, 'val', 'two updated', 'webhook');
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.getDraft().action.webhookHeaders)),
    { 'X-Hook': ['one', 'two updated'] }
  );

  api.removeMockRespHeader(0, 'fixed');
  api.removeMockTransformHeader('res', 1, 'transform');
  api.removeMockWebhookHeader(0, 'webhook');
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.getDraft().action.headers)),
    { 'Set-Cookie': 'second=updated' }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.getDraft().action.resHeaders)),
    { Warning: '199 updated' }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.getDraft().action.webhookHeaders)),
    { 'X-Hook': 'two updated' }
  );
});
