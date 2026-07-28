import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = rendererSource.indexOf(startMarker);
  const end = rendererSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} source must be present`);
  return rendererSource.slice(start, end);
}

const headerLookupSource = sourceBetween(
  'function findHeaderValues(',
  'function matchesFilter('
);
const detailSource = sourceBetween(
  'function renderDetailCards(',
  'function getExportFormFields('
);
const headerGridSource = sourceBetween(
  'function renderHeadersGrid(',
  '// Keep old renderHeaders as alias'
);
const bodyModeSource = sourceBetween(
  'function isGrpcContentType(',
  'const activeBodyEditors = {}'
);
const webSocketConnectionSource = sourceBetween(
  'function isWebSocketConnection(',
  'function wsConnectionKey('
);
const webSocketKeySource = sourceBetween(
  'function wsConnectionKey(',
  'function wsFrameParentKey('
);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderDetail(request) {
  const detailContent = { innerHTML: '' };
  const bodyViewerCalls = [];
  const context = {
    HEADER_DOCS: {},
    SOURCE_ICONS: { Other: '' },
    URL,
    URLSearchParams,
    _transformPerspective: 'transformed',
    _urlBreakdownOpen: false,
    console,
    disposeBodyEditor: () => {},
    document: {
      getElementById: id => id === 'detailContent' ? detailContent : null
    },
    esc: escapeHtml,
    formatBodyAs: body => escapeHtml(body),
    formatSize: size => `${size || 0} bytes`,
    getEffectiveRequest: value => value,
    wsFramesByParent: {},
    renderBodyViewer: (elementId, body, contentType, mode) => {
      bodyViewerCalls.push({ elementId, body, contentType, mode });
    },
    renderUrlBreakdown: () => '',
    window: {}
  };

  vm.createContext(context);
  vm.runInContext(`
    ${headerLookupSource}
    ${headerGridSource}
    ${bodyModeSource}
    ${webSocketConnectionSource}
    ${webSocketKeySource}
    ${detailSource}
    globalThis.renderDetailCardsForTest = renderDetailCards;
  `, context);
  context.renderDetailCardsForTest(request);

  return { html: detailContent.innerHTML, bodyViewerCalls };
}

function baseRequest(responseHeaders, overrides = {}) {
  return {
    id: 'imported-exchange',
    timestamp: '2026-01-01T00:00:00.000Z',
    protocol: 'https',
    method: 'GET',
    host: 'array-headers.example',
    url: 'https://array-headers.example/data',
    path: '/data',
    source: 'import',
    statusCode: 200,
    statusMessage: 'OK',
    requestHeaders: {},
    responseHeaders,
    requestBodySize: 0,
    responseBodySize: 4096,
    duration: 25,
    ...overrides
  };
}

test('traffic detail renders repeated mixed-case Content-Type and Cache-Control values', () => {
  const responseHeaders = {
    'cOnTeNt-TyPe': ['Application/JSON; charset=utf-8', 'application/problem+json'],
    'CaChE-CoNtRoL': ['Public', 'MAX-AGE=60'],
    'Set-Cookie': ['session=one', 'theme=dark']
  };
  const beforeRender = structuredClone(responseHeaders);
  const request = baseRequest(responseHeaders, { responseBody: '{"ok":true}' });

  const { html, bodyViewerCalls } = renderDetail(request);

  assert.match(html, /<option value="json">JSON<\/option>/);
  assert.match(html, /Cacheable for 60 seconds \(public\)/);
  assert.match(html, /Application\/JSON; charset=utf-8, application\/problem\+json/);
  assert.match(html, /Public, MAX-AGE=60/);
  assert.match(html, /session=one, theme=dark/);
  assert.deepEqual(responseHeaders, beforeRender, 'detail rendering must not flatten stored header arrays');
  assert.deepEqual(bodyViewerCalls, [{
    elementId: 'resBody',
    body: '{"ok":true}',
    contentType: 'Application/JSON; charset=utf-8, application/problem+json',
    mode: 'json'
  }]);
});

test('traffic detail keeps binary and no-store heuristics for scalar and repeated headers', () => {
  const cases = [
    {
      'content-type': 'image/png',
      'cache-control': 'no-store'
    },
    {
      'CONTENT-TYPE': ['IMAGE/PNG'],
      'CACHE-CONTROL': ['NO-STORE', 'MAX-AGE=60']
    }
  ];

  for (const responseHeaders of cases) {
    const { html } = renderDetail(baseRequest(responseHeaders, { responseBody: 'image bytes' }));
    assert.match(html, /Content type is already in a compressed format\./);
    assert.match(html, /Not cacheable \(no-store\)/);
  }
});

test('WebSocket details specialize only successful upgrade handshakes', () => {
  for (const protocol of ['ws', 'wss']) {
    const connected = renderDetail(baseRequest({}, {
      protocol,
      method: 'WS',
      statusCode: 101
    })).html;
    assert.match(connected, /detail-card-heading">WebSocket</);
    assert.match(connected, /detail-card-heading">Messages</);
    assert.doesNotMatch(connected, /id="card-error"/);

    for (const failure of [
      { statusCode: null },
      { statusCode: 401 },
      { statusCode: 0, error: 'downstream disconnected' },
      { statusCode: 502, error: 'upstream failed' },
      { statusCode: 101, error: 'relay failed' }
    ]) {
      const failed = renderDetail(baseRequest({}, {
        protocol,
        method: 'WS',
        ...failure
      })).html;
      assert.doesNotMatch(failed, /detail-card-heading">(?:WebSocket|Messages)</);
      if (failure.error) {
        assert.match(failed, /id="card-error"/);
        assert.match(failed, new RegExp(failure.error));
      }
    }
  }
});
