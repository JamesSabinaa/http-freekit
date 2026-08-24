import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} must be present`);
  return source.slice(start, end);
}

const keyHelpers = section('function bodySchemaTypeOverrideKey(', 'function updateProtobufSchemaStatus()');
const selectorHelpers = section('function updateProtobufTypeSelect(', 'function collectProtobufTypes(');

function createHarness() {
  const select = { style: {}, innerHTML: '', value: '' };
  const detailPanel = { _request: null };
  const elements = {
    detailPanel,
    'reqBody-schema': select,
    reqBody: { dataset: { viewMode: 'protobuf' } },
    'sendResBody-schema': { style: {}, innerHTML: '', value: '' }
  };
  const renders = [];
  const context = {
    document: { getElementById: id => elements[id] || null },
    getProtobufTypeOptions: () => ['.One', '.Two'],
    inferGrpcMessageType: () => null,
    inferProtobufMessageType: () => null,
    getEffectiveRequest: request => request,
    getCombinedHeaderValue: () => 'application/protobuf',
    getBodyViewModes: () => [{ value: 'protobuf' }],
    renderBodyViewer: (...args) => renders.push(args),
    esc: value => String(value),
    escapeHtmlAttribute: value => String(value)
  };
  vm.createContext(context);
  vm.runInContext(`
    const bodySchemaTypeOverrides = Object.create(null);
    const standaloneBodyViewers = Object.create(null);
    let _transformPerspective = 'transformed';
    ${keyHelpers}
    ${selectorHelpers}
    globalThis.protobufScopeApi = {
      select: updateProtobufTypeSelect,
      set: setProtobufBodyType,
      setDetail(request) { document.getElementById('detailPanel')._request = request; },
      setStandalone(id, viewer) { standaloneBodyViewers[id] = viewer; }
    };
  `, context);
  return { api: context.protobufScopeApi, elements, renders };
}

test('manual Protobuf choices are scoped to the selected Traffic exchange', () => {
  const { api, elements } = createHarness();
  const first = { id: 'first', trafficLifecycleId: 'life-1', url: 'https://one.test/', requestBody: 'a' };
  const second = { id: 'second', trafficLifecycleId: 'life-2', url: 'https://two.test/', requestBody: 'b' };

  api.setDetail(first);
  api.set('reqBody', '.One', 'request');
  api.select('reqBody', 'protobuf', { request: first, section: 'request' });
  assert.equal(elements['reqBody-schema'].value, '.One');

  api.setDetail(second);
  api.select('reqBody', 'protobuf', { request: second, section: 'request' });
  assert.equal(elements['reqBody-schema'].value, '');

  api.setDetail(first);
  api.select('reqBody', 'protobuf', { request: first, section: 'request' });
  assert.equal(elements['reqBody-schema'].value, '.One');
});

test('manual Protobuf choices are scoped to each standalone Send response', () => {
  const { api, elements } = createHarness();
  const first = { id: 'send-first', trafficLifecycleId: 'life-1', url: 'https://one.test/' };
  const second = { id: 'send-second', trafficLifecycleId: 'life-2', url: 'https://two.test/' };

  api.setStandalone('sendResBody', {
    body: 'a', contentType: 'application/protobuf', mode: 'protobuf',
    context: { viewerIdentity: 'send-response-1', request: first, section: 'response' }
  });
  api.set('sendResBody', '.Two', 'response');
  api.select('sendResBody', 'protobuf', {
    viewerIdentity: 'send-response-1', request: first, section: 'response'
  });
  assert.equal(elements['sendResBody-schema'].value, '.Two');

  api.setStandalone('sendResBody', {
    body: 'b', contentType: 'application/protobuf', mode: 'protobuf',
    context: { viewerIdentity: 'send-response-2', request: first, section: 'response' }
  });
  api.select('sendResBody', 'protobuf', {
    viewerIdentity: 'send-response-2', request: first, section: 'response'
  });
  assert.equal(elements['sendResBody-schema'].value, '');
});
