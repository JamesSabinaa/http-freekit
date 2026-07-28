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
const remoteEndpointSource = sourceBetween(
  'function formatRemoteEndpoint(',
  'function buildRowHtml('
);
const rowSource = sourceBetween(
  'function buildRowHtml(',
  'function renderTraffic('
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
    getBreakpointEditDraft: req => req.breakpointPhase === 'response' ? {
      _phase: 'response', status: 200, headers: {}, body: ''
    } : {
      _phase: 'request', method: req.method, url: req.url, headers: {}, body: ''
    },
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
    ${remoteEndpointSource}
    ${detailSource}
    globalThis.renderDetailCardsForTest = renderDetailCards;
  `, context);
  context.renderDetailCardsForTest(request);

  return { html: detailContent.innerHTML, bodyViewerCalls };
}

function renderTrafficRow(request) {
  const context = {
    SOURCE_ICONS: { tunnel: '', proxy: '', breakpoint: '' },
    selectedRequestId: null,
    esc: escapeHtml,
    formatSize: size => `${size || 0} bytes`,
    isWebSocketConnection: () => false,
    isConnectedWebSocket: () => false,
    wsFramesByParent: {},
    wsExpandedConnections: new Set(),
    wsConnectionKey: () => ''
  };
  vm.createContext(context);
  vm.runInContext(`
    ${remoteEndpointSource}
    ${rowSource}
    globalThis.buildRowHtmlForTest = buildRowHtml;
  `, context);
  return context.buildRowHtmlForTest(request, 0);
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
      statusCode: 101,
      tls: { version: 'TLSv1.3', cipher: 'AES-256' },
      ...(protocol === 'wss' ? {
        remote: { address: '127.0.0.1', port: 443 }
      } : {})
    })).html;
    assert.match(connected, /detail-card-heading">WebSocket</);
    assert.match(connected, /detail-card-heading">Messages</);
    assert.doesNotMatch(connected, /id="card-error"/);
    if (protocol === 'wss') {
      assert.match(connected, />WSS</);
      assert.match(connected, /WSS \(TLSv1\.3\)/);
      assert.match(connected, /Cipher: AES-256/);
      assert.match(connected, /Remote: 127\.0\.0\.1:443/);
    } else {
      assert.match(connected, />WS</);
      assert.match(connected, /WS \(unencrypted\)/);
      assert.doesNotMatch(connected, /Cipher:|AES-256|TLSv1\.3/);
    }

    for (const failure of [
      { statusCode: null, statusMessage: 'Pending' },
      { statusCode: undefined, statusMessage: 'Pending' },
      { statusCode: 401 },
      { statusCode: 0 },
      { statusCode: 0, error: 'downstream disconnected' },
      { statusCode: 502, error: 'upstream failed' },
      { statusCode: 101, error: 'relay failed' }
    ]) {
      const failed = renderDetail(baseRequest({}, {
        protocol,
        method: 'WS',
        ...(protocol === 'wss' ? { tls: { version: 'TLSv1.3', cipher: 'AES-256' } } : {}),
        ...failure
      })).html;
      assert.doesNotMatch(failed, /detail-card-heading">(?:WebSocket|Messages)</);
      if (failure.statusCode === null || failure.statusCode === undefined) {
        assert.match(failed, />Pending</);
        assert.doesNotMatch(failed, /ERR Pending|Pending Pending/);
        assert.match(failed, /background:#888;color:#fff;">Pending/);
      }
      if (failure.statusCode === 0) {
        assert.match(failed, /background:#ce3939;color:#fff;">ERR/);
      }
      if (failure.error) {
        assert.match(failed, /id="card-error"/);
        assert.match(failed, new RegExp(failure.error));
      }
      if (protocol === 'wss') {
        assert.match(failed, />HTTPS\/1\.1</);
        assert.match(failed, />WSS \(TLSv1\.3\)</);
        assert.match(failed, />AES-256</);
      } else {
        assert.match(failed, />HTTP\/1\.1</);
        assert.match(failed, />WS \(unencrypted\)</);
      }
    }

    if (protocol === 'wss') {
      const failedWithoutTls = renderDetail(baseRequest({}, {
        protocol,
        method: 'WS',
        statusCode: 502,
        error: 'TLS negotiation failed',
        remote: { address: '10.0.0.2', port: 8443 }
      })).html;
      assert.match(failedWithoutTls, />WSS \(TLS\)</);
      assert.match(failedWithoutTls, />10\.0\.0\.2:8443</);
    }
  }
});

test('paused breakpoint details use an amber Paused response status', () => {
  for (const breakpointPhase of ['request', 'response']) {
    const html = renderDetail(baseRequest({}, {
      source: 'breakpoint',
      breakpointActive: true,
      statusCode: 0,
      statusMessage: `Breakpoint (${breakpointPhase})`,
      breakpointPhase
    })).html;

    assert.match(html, new RegExp(`>${breakpointPhase === 'response' ? 'Response' : 'Request'} Paused at Breakpoint<`));
    assert.match(html, /background:#f1971f;color:#fff;">Paused/);
    assert.match(html, /border-left-color:#f1971f/);
    assert.doesNotMatch(html, />ERR</);
    assert.doesNotMatch(html, /background:#ce3939;color:#fff;">/);
  }
});

test('terminal breakpoint details show the failure without a Resume action', () => {
  for (const terminal of [
    { statusMessage: 'Client Disconnected' },
    { statusMessage: 'Breakpoint' },
    { statusMessage: 'Breakpoint (request)', error: 'downstream failed' }
  ]) {
    const request = baseRequest({}, {
      source: 'breakpoint',
      breakpointActive: false,
      statusCode: 0,
      breakpointPhase: 'request',
      ...terminal
    });
    const html = renderDetail(request).html;
    const row = renderTrafficRow(request);

    assert.doesNotMatch(html, /Paused at Breakpoint|resumeBreakpointRequest|>Paused</);
    assert.match(html, /background:#ce3939;color:#fff;">ERR/);
    if (terminal.error) assert.match(html, /downstream failed/);
    else assert.match(html, new RegExp(terminal.statusMessage));
    assert.match(row, /status-badge status-err">ERR/);
    assert.doesNotMatch(row, /status-breakpoint|Paused at breakpoint/);
  }
});

test('traffic details escape remote ports in specialized and generic connection cards', () => {
  const hostilePort = '<img src=x onerror=alert(1)>';
  for (const scenario of [
    { protocol: 'ws', statusCode: 101 },
    { protocol: 'wss', statusCode: 101 },
    { protocol: 'http', statusCode: 502, error: 'failed' },
    { protocol: 'https', statusCode: 502, error: 'failed', tls: { version: 'TLSv1.3' } },
    { protocol: 'h2', statusCode: 502, error: 'failed', tls: { version: 'TLSv1.3' } },
    { protocol: 'wss', statusCode: 502, error: 'failed', tls: { version: 'TLSv1.3' } }
  ]) {
    const html = renderDetail(baseRequest({}, {
      method: scenario.protocol === 'http' || scenario.protocol === 'https' || scenario.protocol === 'h2'
        ? 'GET'
        : 'WS',
      remote: { address: '127.0.0.1', port: hostilePort },
      ...scenario
    })).html;
    assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  }
});

test('traffic details preserve port zero and omit separators for absent ports', () => {
  for (const port of [0, 65535, null, undefined]) {
    const remote = {
      address: '192.0.2.1',
      ...(port === undefined ? {} : { port })
    };
    for (const scenario of [
      { protocol: 'ws', method: 'WS', statusCode: 101 },
      { protocol: 'http', method: 'GET', statusCode: 502, error: 'failed' }
    ]) {
      const html = renderDetail(baseRequest({}, { ...scenario, remote })).html;
      if (port === null || port === undefined) {
        assert.match(html, /192\.0\.2\.1/);
        assert.doesNotMatch(html, /192\.0\.2\.1:/);
      } else {
        assert.match(html, new RegExp(`192\\.0\\.2\\.1:${port}`));
      }
    }
  }
});

test('traffic details bracket raw IPv6 endpoints without double bracketing', () => {
  for (const address of ['2001:db8::1', '[2001:db8::1]']) {
    for (const scenario of [
      { protocol: 'ws', method: 'WS', statusCode: 101 },
      {
        protocol: 'https', method: 'GET', statusCode: 502, error: 'failed',
        tls: { version: 'TLSv1.3' }
      }
    ]) {
      const html = renderDetail(baseRequest({}, {
        ...scenario,
        remote: { address, port: 443 }
      })).html;
      assert.match(html, /\[2001:db8::1\]:443/);
      assert.doesNotMatch(html, /\[\[2001:db8::1\]\]/);
      assert.doesNotMatch(html, /2001:db8::1:443/);
    }
  }
});

test('tunnel rows and details preserve explicit ports and format IPv6 endpoints', () => {
  for (const { port, expectedPort } of [
    { port: 0, expectedPort: 0 },
    { port: null, expectedPort: 443 },
    { port: 65535, expectedPort: 65535 }
  ]) {
    const request = baseRequest({}, {
      protocol: 'tunnel',
      method: 'CONNECT',
      host: '2001:db8::5',
      remote: { address: '2001:db8::5', port }
    });
    const endpointPattern = new RegExp(`\\[2001:db8::5\\]:${expectedPort}`);
    const row = renderTrafficRow(request);
    const detail = renderDetail(request).html;

    assert.match(row, endpointPattern);
    assert.match(detail, endpointPattern);
    assert.doesNotMatch(row, /2001:db8::5:443/);
    assert.doesNotMatch(detail, /2001:db8::5:443/);
  }
});
