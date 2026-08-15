import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../../src/api/api-server.js';

const uiDir = path.join(process.cwd(), 'src', 'ui');

function buttonById(html, id) {
  const match = html.match(new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?</button>`));
  assert.ok(match, `${id} must be a visible native button`);
  return match[0];
}

function exportHarness(serverPayload = {
  exported: '2026-07-26T12:34:56.000Z',
  tool: 'HTTP FreeKit',
  version: '1.0.0',
  requests: [{ id: 'eligible', method: 'GET', url: 'https://eligible.example/' }]
}, responseOverrides = {}) {
  const source = fs.readFileSync(path.join(uiDir, 'app.js'), 'utf8');
  const start = source.indexOf('async function exportTraffic(');
  const end = source.indexOf('async function exportHarToGenerator(', start);
  assert.ok(start >= 0 && end > start, 'traffic export function must be present');

  const anchors = [];
  const blobs = [];
  const revokedUrls = [];
  const toasts = [];
  const fetches = [];
  class CapturedBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.type = options.type;
      blobs.push(this);
    }
  }
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : ['2026-07-26T12:34:56.000Z']));
    }
  }
  const context = {
    API_BASE: 'http://127.0.0.1:8080',
    Blob: CapturedBlob,
    Date: FixedDate,
    URL: {
      createObjectURL(blob) {
        assert.equal(blob, blobs.at(-1));
        return `blob:traffic-${blobs.length}`;
      },
      revokeObjectURL(url) {
        revokedUrls.push(url);
      }
    },
    authenticatedApiUrl: url => `authenticated:${url}`,
    async fetch(url) {
      fetches.push(url);
      return {
        ok: true,
        status: 200,
        async blob() {
          return new CapturedBlob([JSON.stringify(serverPayload)], { type: 'application/json' });
        },
        ...responseOverrides
      };
    },
    document: {
      createElement(tagName) {
        assert.equal(tagName, 'a');
        const anchor = {
          clicked: false,
          click() { this.clicked = true; }
        };
        anchors.push(anchor);
        return anchor;
      }
    },
    requests: [{ id: 'renderer-only-secret', method: 'GET', url: 'http://hidden.example/' }],
    filteredRequests: [],
    toast: (...args) => toasts.push(args)
  };
  vm.createContext(context);
  vm.runInContext(`
    ${source.slice(start, end)}
    globalThis.runExport = exportTraffic;
  `, context);
  return { context, anchors, blobs, fetches, revokedUrls, toasts };
}

function request(id, overrides = {}) {
  return {
    id,
    timestamp: '2026-07-26T12:34:56.000Z',
    protocol: 'https',
    method: 'GET',
    host: 'allowed.example',
    path: '/',
    url: 'https://allowed.example/',
    requestHeaders: {},
    requestBody: '',
    responseHeaders: {},
    responseBody: '',
    statusCode: 200,
    statusMessage: 'OK',
    duration: 12,
    source: 'proxy',
    ...overrides
  };
}

function requestJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: requestPath }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    req.once('error', reject);
  });
}

async function createApi(t, settingValues) {
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null,
    getStats: () => ({})
  };
  const api = new ApiServer(proxy, null, null);
  api.settings = {
    get(name, fallback) {
      return Object.hasOwn(settingValues, name) ? settingValues[name] : fallback;
    }
  };
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { api, port: server.address().port };
}

test('Traffic toolbar exposes independent accessible JSON and HAR export buttons', () => {
  const html = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(uiDir, 'styles.css'), 'utf8');
  const jsonButton = buttonById(html, 'exportJsonBtn');
  const harButton = buttonById(html, 'exportHarBtn');

  assert.match(jsonButton, /onclick="exportTraffic\('json'\)"/);
  assert.match(jsonButton, /title="Export traffic as JSON"/);
  assert.match(jsonButton, /aria-label="Export traffic as JSON"/);
  assert.match(jsonButton, /class="ph ph-brackets-curly"/);
  assert.match(harButton, /onclick="exportTraffic\('har'\)"/);
  assert.match(harButton, /title="Export traffic as HAR"/);
  assert.match(harButton, /aria-label="Export traffic as HAR"/);
  assert.ok(html.indexOf(jsonButton) < html.indexOf(harButton));

  for (const existingAction of ['exportHarToGenerator()', 'importHar()', 'clearTraffic()']) {
    assert.match(html, new RegExp(`onclick="${existingAction.replace(/[()]/g, '\\$&')}"`));
  }
  assert.match(html, /class="traffic-toolbar-actions" role="toolbar" aria-label="Traffic actions"/);
  assert.match(styles, /\.traffic-toolbar-actions\s*\{[\s\S]*?display:\s*flex;/);
  assert.match(styles, /@media \(max-width: 768px\)[\s\S]*?\.traffic-toolbar-actions\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
});

test('JSON traffic export downloads the existing named JSON payload', async () => {
  const serverPayload = {
    exported: '2026-07-26T12:34:56.000Z',
    tool: 'HTTP FreeKit',
    version: '1.0.0',
    requests: [{ id: 'eligible', method: 'GET', url: 'https://eligible.example/' }]
  };
  const { context, anchors, blobs, fetches, revokedUrls, toasts } = exportHarness(serverPayload);

  await context.runExport('json');

  assert.deepEqual(fetches, ['http://127.0.0.1:8080/api/traffic/export']);
  assert.equal(anchors.length, 1);
  assert.deepEqual(anchors[0], {
    href: 'blob:traffic-1',
    download: 'http-freekit-2026-07-26.json',
    clicked: true,
    click: anchors[0].click
  });
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].type, 'application/json');
  assert.deepEqual(JSON.parse(blobs[0].parts.join('')), serverPayload);
  assert.doesNotMatch(blobs[0].parts.join(''), /renderer-only-secret|hidden\.example/);
  assert.deepEqual(revokedUrls, ['blob:traffic-1']);
  assert.deepEqual(toasts, [['JSON exported', 'success']]);
});

test('HAR traffic export remains independently reachable and server-backed', async () => {
  const { context, anchors, blobs, fetches, revokedUrls, toasts } = exportHarness();

  await context.runExport('har');

  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].href, 'authenticated:http://127.0.0.1:8080/api/traffic/export.har');
  assert.equal(anchors[0].download, 'http-freekit-2026-07-26.har');
  assert.equal(anchors[0].clicked, true);
  assert.deepEqual(fetches, []);
  assert.deepEqual(blobs, []);
  assert.deepEqual(revokedUrls, []);
  assert.deepEqual(toasts, [['HAR download started', 'success']]);
});

test('JSON traffic export does not download an unsuccessful server response', async () => {
  const { context, anchors, blobs, fetches, revokedUrls, toasts } = exportHarness(undefined, {
    ok: false,
    status: 503,
    async blob() {
      assert.fail('an error response must not be downloaded');
    }
  });

  await context.runExport('json');

  assert.deepEqual(fetches, ['http://127.0.0.1:8080/api/traffic/export']);
  assert.deepEqual(anchors, []);
  assert.deepEqual(blobs, []);
  assert.deepEqual(revokedUrls, []);
  assert.deepEqual(toasts, [['Export failed: JSON export returned HTTP 503', 'error']]);
});

test('server JSON and HAR exports share saved visibility settings without losing eligible frames', async t => {
  const settingValues = {
    hideTunnelRequests: true,
    filterSafeFonts: true,
    trafficLists: [
      {
        id: 'default-exclusions',
        name: 'Default Exclusions',
        enabled: false,
        mode: 'blacklist',
        patterns: []
      },
      {
        id: 'allowed-hosts',
        name: 'Allowed hosts',
        enabled: true,
        mode: 'whitelist',
        patterns: [' ALLOWED.EXAMPLE ', 'FONTS.GSTATIC.COM', 'tunnel.example']
      },
      {
        id: 'private-paths',
        name: 'Private paths',
        enabled: true,
        mode: 'blacklist',
        patterns: ['HTTPS://ALLOWED.EXAMPLE/private']
      }
    ]
  };
  const { api, port } = await createApi(t, settingValues);
  const eligible = request('eligible', {
    path: '/public',
    url: 'https://allowed.example/public',
    requestHeaders: { 'x-exact': ['one', 'two'] },
    responseBody: 'complete eligible payload',
    exactMetadata: { retained: true }
  });
  const blocked = request('blocked', {
    path: '/private/token',
    url: 'https://allowed.example/private/token'
  });
  const outsideWhitelist = request('outside', {
    host: 'outside.example',
    url: 'https://outside.example/'
  });
  const safeFont = request('safe-font', {
    host: 'fonts.gstatic.com',
    path: '/font.woff2',
    url: 'https://fonts.gstatic.com/font.woff2'
  });
  const tunnel = request('tunnel', {
    protocol: 'tunnel',
    method: 'CONNECT',
    host: 'tunnel.example',
    url: 'https://tunnel.example/'
  });
  const socket = request('socket', {
    trafficLifecycleId: 'allowed-socket',
    protocol: 'wss',
    path: '/socket',
    url: 'wss://allowed.example/socket',
    statusCode: 101,
    statusMessage: 'Switching Protocols'
  });
  const socketFrame = request('socket-frame', {
    protocol: 'ws-frame',
    method: 'WS',
    host: 'outside.example',
    url: '',
    parentId: socket.id,
    parentTrafficLifecycleId: socket.trafficLifecycleId,
    statusCode: 0,
    statusMessage: 'text'
  });
  const hiddenSocket = request('hidden-socket', {
    trafficLifecycleId: 'hidden-socket-lifecycle',
    protocol: 'wss',
    path: '/private/socket',
    url: 'wss://allowed.example/private/socket',
    statusCode: 101,
    statusMessage: 'Switching Protocols'
  });
  const hiddenSocketFrame = request('hidden-socket-frame', {
    protocol: 'ws-frame',
    method: 'WS',
    host: 'allowed.example',
    path: '/public',
    url: '',
    parentId: hiddenSocket.id,
    parentTrafficLifecycleId: hiddenSocket.trafficLifecycleId,
    statusCode: 0,
    statusMessage: 'text'
  });
  const fontSocket = request('font-socket', {
    trafficLifecycleId: 'font-socket-lifecycle',
    protocol: 'wss',
    host: 'fonts.gstatic.com',
    path: '/socket',
    url: 'wss://fonts.gstatic.com/socket',
    statusCode: 101,
    statusMessage: 'Switching Protocols'
  });
  const fontSocketFrame = request('font-socket-frame', {
    protocol: 'ws-frame',
    method: 'WS',
    host: 'allowed.example',
    url: '',
    parentId: fontSocket.id,
    parentTrafficLifecycleId: fontSocket.trafficLifecycleId,
    statusCode: 0,
    statusMessage: 'text'
  });
  const orphanFrame = request('orphan-frame', {
    protocol: 'ws-frame',
    method: 'WS',
    parentId: 'missing-parent',
    statusCode: 0,
    statusMessage: 'text'
  });
  api.trafficLog.push(
    eligible,
    blocked,
    outsideWhitelist,
    safeFont,
    tunnel,
    socket,
    socketFrame,
    hiddenSocket,
    hiddenSocketFrame,
    fontSocket,
    fontSocketFrame,
    orphanFrame
  );

  const filteredJson = await requestJson(port, '/api/traffic/export');
  const filteredHar = await requestJson(port, '/api/traffic/export.har');
  assert.equal(filteredJson.statusCode, 200);
  assert.match(filteredJson.headers['content-disposition'], /http-freekit-export\.json/);
  assert.deepEqual(filteredJson.body.requests, [eligible, socket, socketFrame]);
  assert.deepEqual(
    filteredHar.body.log.entries.map(entry => entry.request.url),
    [eligible.url, socket.url]
  );

  settingValues.hideTunnelRequests = false;
  settingValues.filterSafeFonts = false;
  const unfilteredJson = await requestJson(port, '/api/traffic/export');
  const unfilteredHar = await requestJson(port, '/api/traffic/export.har');
  assert.deepEqual(unfilteredJson.body.requests, [
    eligible,
    safeFont,
    tunnel,
    socket,
    socketFrame,
    fontSocket,
    fontSocketFrame
  ]);
  assert.deepEqual(
    unfilteredJson.body.requests
      .filter(entry => entry.protocol !== 'ws-frame')
      .map(entry => entry.url),
    unfilteredHar.body.log.entries.map(entry => entry.request.url)
  );
});
