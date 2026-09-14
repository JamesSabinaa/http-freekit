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
  'function autoSizeExportEditor('
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
    atob,
    HEADER_DOCS: {},
    SOURCE_ICONS: { Other: '' },
    URL,
    URLSearchParams,
    _transformPerspective: 'transformed',
    _detailRenderedRequestIdentity: null,
    _detailHeaderScope: 0,
    _headerCollapsed: Object.create(null),
    _urlBreakdownOpen: false,
    console,
    disposeBodyEditor: () => {},
    document: {
      getElementById: id => id === 'detailContent' ? detailContent : null
    },
    esc: escapeHtml,
    escapeHtmlAttribute: escapeHtml,
    formatBodyAs: body => escapeHtml(body),
    formatSize: size => `${size || 0} bytes`,
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
    getResponseStatusPillBackground: (statusCode, options = {}) => {
      if (options.breakpoint) return 'var(--status-pill-4xx)';
      if (options.error) return 'var(--status-pill-5xx)';
      const numeric = Number(statusCode);
      const family = Number.isFinite(numeric) && numeric > 0
        ? Math.min(5, Math.max(1, Math.floor(numeric / 100)))
        : 1;
      return `var(--status-pill-${family}xx)`;
    },
    initializeDetailCardDisclosures: () => {},
    window: {}
  };

  vm.createContext(context);
  vm.runInContext(`
    ${sourceBetween('function getEffectiveRequest(', 'function toggleUrlBreakdown(')}
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

  return {
    html: detailContent.innerHTML,
    bodyViewerCalls,
    context,
    render(nextRequest) {
      context.renderDetailCardsForTest(nextRequest);
      return detailContent.innerHTML;
    }
  };
}

test('binary ping and pong payloads display the captured bytes as hex', () => {
  for (const opcode of [9, 10]) {
    const { html } = renderDetail({
      id: 'control', protocol: 'ws-frame', direction: 'server', opcode,
      opcodeName: opcode === 9 ? 'ping' : 'pong', timestamp: Date.now(),
      requestBody: '/wCAQQ==', requestBodyEncoding: 'base64', requestBodySize: 4
    });
    assert.match(html, /Payload \(Binary\)/);
    assert.match(html, /ff 00 80 41/);
    assert.doesNotMatch(html, /�|\/wCAQQ==/);
  }
});

function renderTrafficRow(request) {
  const context = {
    SOURCE_ICONS: { tunnel: '', proxy: '', breakpoint: '' },
    selectedRequestId: null,
    selectedRequestLifecycleId: null,
    esc: escapeHtml,
    escapeHtmlAttribute: escapeHtml,
    isSelectedTrafficRequest: () => false,
    trafficRowDomId: request => `row-${request.id}`,
    trafficRowIdentityAttributes: request =>
      `data-id="${escapeHtml(request.id)}" data-lifecycle-id="${escapeHtml(request.trafficLifecycleId || '')}"`,
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

function requestAndResponseCards(request) {
  const html = renderDetail(request).html;
  const requestStart = html.indexOf('id="card-request"');
  const responseStart = html.indexOf('id="card-response"');
  assert.ok(requestStart >= 0 && responseStart > requestStart);
  return {
    html,
    requestCard: html.slice(requestStart, responseStart),
    responseCard: html.slice(responseStart)
  };
}

test('detail cards preserve literal binary-prefixed text while hiding capture placeholders', () => {
  for (const body of ['[Binary search]', '[Binary data: ordinary text]', '[Binary data: 42 bytes]']) {
    const result = renderDetail(baseRequest({}, {
      requestBody: body, requestBodyEncoding: 'utf8',
      responseBody: body, responseBodyEncoding: 'utf8'
    }));
    assert.match(result.html, /id="card-req-body"/);
    assert.ok(result.bodyViewerCalls.some(call => call.elementId === 'reqBody' && call.body === body));
    assert.ok(result.bodyViewerCalls.some(call => call.elementId === 'resBody' && call.body === body));
  }
  for (const metadata of [{}, { requestBodyEncoding: 'utf8', requestBodyTruncated: true, requestBodyCapturedSize: 0 }]) {
    const result = renderDetail(baseRequest({}, { requestBody: '[Binary data: 42 bytes]', ...metadata }));
    assert.doesNotMatch(result.html, /id="card-req-body"/);
    assert.ok(!result.bodyViewerCalls.some(call => call.elementId === 'reqBody'));
  }
});

test('header context actions copy values from the displayed request perspective', () => {
  const request = baseRequest({ 'x-response': 'response' }, {
    requestHeaders: { 'x-value': 'transformed' },
    originalRequest: { method: 'GET', url: 'https://array-headers.example/data', headers: { 'x-value': ['original', 'second'] } }
  });
  const rendered = renderDetail(request);
  let actions;
  let copied;
  rendered.context.showContextMenu = (_x, _y, items) => { actions = items; };
  rendered.context.copyTextToClipboard = value => { copied = value; };
  vm.runInContext(sourceBetween('function showHeaderContextMenu(', '// ============ HELPERS'), rendered.context);
  for (const perspective of ['original', 'transformed', 'client']) {
    rendered.context._transformPerspective = perspective;
    rendered.render(request);
    rendered.context.showHeaderContextMenu({ preventDefault() {}, stopPropagation() {} }, 'x-value', 'request');
    const expected = perspective === 'transformed' ? 'transformed' : 'original, second';
    actions[0].action();
    assert.equal(copied, expected);
    actions[2].action();
    assert.equal(copied, `x-value: ${expected}`);
    assert.equal(rendered.context.window._detailHeaders.response['x-response'], 'response');
  }
});

test('traffic detail metadata remains inert if an unvalidated in-process record reaches the renderer', () => {
  const protocolHtml = renderDetail(baseRequest({}, {
    protocol: '<img src=x onerror=alert(1)>'
  })).html;
  assert.doesNotMatch(protocolHtml, /<img src=x/);
  assert.match(protocolHtml, /&lt;IMG SRC=X ONERROR=ALERT\(1\)&gt;/);

  const frameHtml = renderDetail(baseRequest({}, {
    protocol: 'ws-frame',
    method: 'WS',
    direction: 'client',
    opcodeName: 'hostile',
    opcode: '<img src=x onerror=alert(1)>',
    requestBody: 'frame data',
    requestBodySize: 10,
    responseHeaders: {}
  })).html;
  assert.doesNotMatch(frameHtml, /<img src=x/);
  assert.match(frameHtml, /hostile \(0x0\)/);
});

test('traffic details preserve distinct imported HTTP versions with safe live fallbacks', () => {
  const imported = requestAndResponseCards(baseRequest({}, {
    requestHttpVersion: 'HTTP/1.0',
    responseHttpVersion: 'HTTP/1.1'
  }));
  assert.match(imported.requestCard, />HTTP\/1\.0<\/span>/);
  assert.doesNotMatch(imported.requestCard, />HTTP\/1\.1<\/span>/);
  assert.match(imported.responseCard, />HTTP\/1\.1<\/span>/);
  assert.doesNotMatch(imported.responseCard, />HTTP\/1\.0<\/span>/);

  const liveHttps = requestAndResponseCards(baseRequest({}));
  assert.match(liveHttps.requestCard, />HTTP\/1\.1<\/span>/);
  assert.match(liveHttps.responseCard, />HTTP\/1\.1<\/span>/);
  assert.doesNotMatch(liveHttps.html, /HTTPS\/1\.1/);

  const liveHttp2 = requestAndResponseCards(baseRequest({}, { protocol: 'h2' }));
  assert.match(liveHttp2.requestCard, />HTTP\/2<\/span>/);
  assert.match(liveHttp2.responseCard, />HTTP\/2<\/span>/);

  const hostile = 'HTTP/1.0</span><img src=x onerror="audit">';
  const hostileDetails = requestAndResponseCards(baseRequest({}, {
    requestHttpVersion: hostile,
    responseHttpVersion: hostile
  }));
  assert.doesNotMatch(hostileDetails.html, /<img src=x/);
  assert.match(hostileDetails.requestCard, /HTTP\/1\.0&lt;\/span&gt;&lt;img src=x onerror=&quot;audit&quot;&gt;/);
  assert.match(hostileDetails.responseCard, /HTTP\/1\.0&lt;\/span&gt;&lt;img src=x onerror=&quot;audit&quot;&gt;/);
});

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

test('traffic compression analysis escapes unrecognized Content-Encoding values', () => {
  const hostileEncoding = '<img src=x onerror=alert(1)>';
  const { html } = renderDetail(baseRequest({
    'content-encoding': hostileEncoding,
    'content-type': 'text/plain'
  }));

  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(
    html,
    /Response compressed with <strong>&lt;img src=x onerror=alert\(1\)&gt;<\/strong>/
  );
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
        assert.match(failed, /background:var\(--status-pill-1xx\);color:#fff;">Pending/);
      }
      if (failure.statusCode === 0) {
        assert.match(failed, /background:var\(--status-pill-5xx\);color:#fff;">ERR/);
      }
      if (failure.error) {
        assert.match(failed, /id="card-error"/);
        assert.match(failed, new RegExp(failure.error));
      }
      if (protocol === 'wss') {
        assert.match(failed, />HTTP\/1\.1</);
        assert.doesNotMatch(failed, />HTTPS\/1\.1</);
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
    assert.match(html, /background:var\(--status-pill-4xx\);color:#fff;">Paused/);
    assert.match(html, /border-left-color:#f1971f/);
    assert.doesNotMatch(html, />ERR</);
    assert.doesNotMatch(html, /background:var\(--status-pill-5xx\);color:#fff;">/);
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
    assert.match(html, /background:var\(--status-pill-5xx\);color:#fff;">ERR/);
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

test('failed tunnel rows and details expose captured status and diagnostics', () => {
  const request = baseRequest({}, {
    protocol: 'tunnel',
    method: 'CONNECT',
    host: 'unreachable.example',
    statusCode: 502,
    statusMessage: 'Bad Gateway',
    error: 'connect failed <script>alert(1)</script>',
    errorCode: 'ECONNREFUSED<&',
    errorPhase: 'upstream-connect<phase>',
    remote: { address: '192.0.2.9', port: 8443 }
  });

  const row = renderTrafficRow(request);
  assert.match(row, /status-badge status-5xx">502</);
  assert.match(row, /row-marker" style="color:#ce3939/);
  assert.doesNotMatch(row, /status-2xx">200/);
  assert.doesNotMatch(row, /<script>/);

  const detail = renderDetail(request).html;
  assert.match(detail, />Tunnel Failed</);
  assert.match(detail, /background:var\(--status-pill-5xx\);color:#fff;">502</);
  assert.match(detail, />Status Message<[^>]*>.*Bad Gateway/s);
  assert.match(detail, />Error Code<[^>]*>.*ECONNREFUSED&lt;&amp;/s);
  assert.match(detail, />Error Phase<[^>]*>.*upstream-connect&lt;phase&gt;/s);
  assert.match(detail, /connect failed &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(detail, /<script>alert\(1\)<\/script>/);

  const missingStatusFailure = { ...request, statusCode: undefined };
  assert.match(renderTrafficRow(missingStatusFailure), /status-badge status-err">ERR</);
  assert.match(renderDetail(missingStatusFailure).html, /background:var\(--status-pill-5xx\);color:#fff;">ERR</);
});

test('transform perspective resets for a different request but survives same-request rerenders', () => {
  const firstRequest = baseRequest({}, {
    id: 'transform-one',
    originalRequest: {
      method: 'POST',
      url: 'https://original-one.test/path',
      headers: {},
      body: 'original one'
    }
  });
  const secondRequest = baseRequest({}, {
    id: 'transform-two',
    originalRequest: {
      method: 'PUT',
      url: 'https://original-two.test/path',
      headers: {},
      body: 'original two'
    }
  });
  const renderer = renderDetail(firstRequest);

  renderer.context._transformPerspective = 'original';
  const sameRequestHtml = renderer.render(firstRequest);
  assert.match(sameRequestHtml, /value="original" selected/);

  const nextRequestHtml = renderer.render(secondRequest);
  assert.match(nextRequestHtml, /value="transformed" selected/);
  assert.doesNotMatch(nextRequestHtml, /value="original" selected/);
});

test('header disclosure IDs are section-scoped and stale state is reset per request', () => {
  const firstRequest = baseRequest({ 'Content-Type': 'response/type' }, {
    id: 'headers-one',
    requestHeaders: { 'Content-Type': 'request/type' },
    trailers: { 'Content-Type': 'trailer/type' }
  });
  const renderer = renderDetail(firstRequest);
  const ids = [...renderer.html.matchAll(/id="(hdr-[^"]+)-(?:icon|desc)"/g)]
    .map(match => match[1]);
  const uniqueIds = new Set(ids);
  assert.equal(ids.length, 6);
  assert.equal(uniqueIds.size, 3);
  assert.ok([...uniqueIds].some(id => id.includes('-request-')));
  assert.ok([...uniqueIds].some(id => id.includes('-response-')));
  assert.ok([...uniqueIds].some(id => id.includes('-trailers-')));

  const requestDisclosureId = [...uniqueIds].find(id => id.includes('-request-'));
  renderer.context._headerCollapsed[requestDisclosureId] = true;
  assert.match(renderer.render(firstRequest), new RegExp(`${requestDisclosureId}-icon"[^>]*>\u2212<`));

  const secondRequest = { ...firstRequest, id: 'headers-two' };
  const secondHtml = renderer.render(secondRequest);
  assert.doesNotMatch(secondHtml, />\u2212<\/span>/);
  assert.equal(Object.keys(renderer.context._headerCollapsed).length, 0);
});
