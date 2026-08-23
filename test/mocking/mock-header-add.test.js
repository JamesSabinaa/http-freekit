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
