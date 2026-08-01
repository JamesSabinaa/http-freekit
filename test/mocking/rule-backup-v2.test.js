import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../../src/api/api-server.js';
import { ProxyServer } from '../../src/proxy/proxy-server.js';
import { Settings } from '../../src/settings.js';

function mockRule(id, title = id) {
  return {
    id,
    title,
    enabled: true,
    matchers: [{ type: 'method', value: 'GET' }],
    action: { type: 'fixed-response', status: 200 }
  };
}

function breakpointRule(id, phase = 'request') {
  return {
    id,
    enabled: true,
    phase,
    matchers: [{ type: 'method', value: 'GET' }]
  };
}

function requestJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: response.statusCode,
          body: text ? JSON.parse(text) : null
        });
      });
    });
    request.once('error', reject);
    request.end(payload);
  });
}

async function createServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-341-'));
  const settings = new Settings(dataDir);
  const proxy = new ProxyServer(null);
  const api = new ApiServer(proxy, null, null);
  api.settings = settings;
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { proxy, settings, port: server.address().port };
}

function savedSettings(settings) {
  return JSON.parse(fs.readFileSync(settings.filePath, 'utf8'));
}

const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
const exportStart = rendererSource.indexOf('function exportMockRules()');
const importStart = rendererSource.indexOf('function importMockRules()', exportStart);
const importEnd = rendererSource.indexOf('// ============ TRANSFORM HEADER HELPERS', importStart);
assert.notEqual(exportStart, -1);
assert.notEqual(importStart, -1);
assert.notEqual(importEnd, -1);
const exportSource = rendererSource.slice(exportStart, importStart);
const importSource = rendererSource.slice(importStart, importEnd);

async function exportRules(mockRules, breakpointRules, pendingBreakpoints = []) {
  const toasts = [];
  let exportedBlob;
  let clicks = 0;
  const context = {
    mockRules,
    breakpointRules,
    pendingBreakpoints,
    Blob,
    Date,
    JSON,
    URL: {
      createObjectURL(blob) {
        exportedBlob = blob;
        return 'blob:rules';
      },
      revokeObjectURL() {}
    },
    document: {
      createElement(tagName) {
        assert.equal(tagName, 'a');
        return { click() { clicks += 1; } };
      }
    },
    toast: (message, type) => toasts.push({ message, type })
  };
  vm.createContext(context);
  vm.runInContext(`${exportSource}\nthis.exportMockRules = exportMockRules;`, context);
  context.exportMockRules();
  return {
    clicks,
    toasts,
    data: exportedBlob ? JSON.parse(await exportedBlob.text()) : null
  };
}

function createImportRenderer({ fileData, mockRules = [], breakpointRules = [], replace = false }) {
  const requests = [];
  const toasts = [];
  let completion;
  let confirmCalls = 0;
  let mockReloads = 0;
  let breakpointReloads = 0;
  const input = {
    click() {
      completion = input.onchange({
        target: { files: [{ text: async () => JSON.stringify(fileData) }] }
      });
    }
  };
  const mockDraftRules = new Map([['draft', { id: 'draft' }]]);
  const mockNewDraftIds = new Set(['draft']);
  const context = {
    API_BASE: '',
    mockRules: structuredClone(mockRules),
    breakpointRules: structuredClone(breakpointRules),
    mockDraftRules,
    mockNewDraftIds,
    mockSaveInProgress: false,
    mockRevertInProgress: false,
    mockResetInProgress: false,
    mockCollectionMutationCount: 0,
    _queueMockCollectionMutation: mutation => mutation(),
    document: {
      createElement(tagName) {
        assert.equal(tagName, 'input');
        return input;
      }
    },
    confirm() {
      confirmCalls += 1;
      return replace;
    },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, method: options.method, body });
      if (url === '/api/rules') {
        return {
          ok: true,
          json: async () => ({
            success: true,
            mockRules: body.mockRules,
            breakpointRules: body.breakpointRules
          })
        };
      }
      if (url === '/api/mock-rules') {
        return {
          ok: true,
          json: async () => ({ success: true, rules: body.rules })
        };
      }
      return {
        ok: true,
        json: async () => ({ success: true, rule: body })
      };
    },
    toast: (message, type) => toasts.push({ message, type }),
    loadMockRules: () => { mockReloads += 1; },
    loadBreakpointRules: () => { breakpointReloads += 1; }
  };
  vm.createContext(context);
  vm.runInContext(`${importSource}\nthis.importMockRules = importMockRules;`, context);
  return {
    requests,
    toasts,
    mockDraftRules,
    get confirmCalls() { return confirmCalls; },
    get mockReloads() { return mockReloads; },
    get breakpointReloads() { return breakpointReloads; },
    async importRules() {
      context.importMockRules();
      await completion;
    }
  };
}

test('version 2 exports support breakpoint-only and mixed backups without pending requests', async t => {
  await t.test('breakpoint-only', async () => {
    const breakpoint = breakpointRule('persisted-breakpoint');
    const exported = await exportRules([], [breakpoint], [{ id: 'pending-request' }]);

    assert.equal(exported.clicks, 1);
    assert.deepEqual(exported.data, {
      version: 2,
      mockRules: [],
      breakpointRules: [breakpoint]
    });
    assert.equal(JSON.stringify(exported.data).includes('pending-request'), false);
  });

  await t.test('mixed', async () => {
    const mock = mockRule('mock');
    const breakpoint = breakpointRule('breakpoint', 'response');
    const exported = await exportRules([mock], [breakpoint]);

    assert.deepEqual(exported.data, {
      version: 2,
      mockRules: [mock],
      breakpointRules: [breakpoint]
    });
  });
});

test('version 2 renderer import considers breakpoint-only state and sends both collections together', async () => {
  const importedMock = mockRule('imported-mock');
  const importedBreakpoint = breakpointRule('imported-breakpoint');
  const renderer = createImportRenderer({
    fileData: {
      version: 2,
      mockRules: [importedMock],
      breakpointRules: [importedBreakpoint]
    },
    breakpointRules: [breakpointRule('existing-breakpoint')],
    replace: false
  });

  await renderer.importRules();

  assert.equal(renderer.confirmCalls, 1);
  assert.deepEqual(renderer.requests, [{
    url: '/api/rules',
    method: 'PUT',
    body: {
      mockRules: [importedMock],
      breakpointRules: [importedBreakpoint],
      mode: 'append'
    }
  }]);
  assert.equal(renderer.mockReloads, 1);
  assert.equal(renderer.breakpointReloads, 1);
  assert.equal(renderer.mockDraftRules.size, 1);
  assert.deepEqual(renderer.toasts, [{ message: 'Imported 2 rules', type: 'success' }]);
});

test('version 2 append commits and persists both collections in one write', async t => {
  const { proxy, settings, port } = await createServer(t);
  const existingMock = mockRule('existing-mock');
  const existingBreakpoint = breakpointRule('existing-breakpoint');
  proxy.loadMockRules([existingMock]);
  proxy.loadBreakpoints([existingBreakpoint]);
  settings.setAll({
    mockRules: proxy.mockRules,
    breakpointRules: proxy.breakpointRules
  });
  proxy.pendingBreakpoints.set('pending-request', { method: 'GET' });

  const originalSetAll = settings.setAll.bind(settings);
  let writes = 0;
  settings.setAll = values => {
    writes += 1;
    return originalSetAll(values);
  };
  const result = await requestJson(port, '/api/rules', {
    mode: 'append',
    mockRules: [mockRule('exported-id', 'Imported Mock')],
    breakpointRules: [breakpointRule('exported-id', 'response')]
  });

  assert.equal(result.statusCode, 200);
  assert.equal(writes, 1);
  assert.deepEqual(proxy.mockRules.map(rule => rule.title), ['existing-mock', 'Imported Mock']);
  assert.deepEqual(proxy.breakpointRules.map(rule => rule.phase), ['request', 'response']);
  assert.equal(proxy.pendingBreakpoints.has('pending-request'), true);
  assert.notEqual(proxy.mockRules[1].id, 'exported-id');
  assert.notEqual(proxy.breakpointRules[1].id, 'exported-id');
  assert.deepEqual(savedSettings(settings).mockRules, proxy.mockRules);
  assert.deepEqual(savedSettings(settings).breakpointRules, proxy.breakpointRules);
});

test('version 2 replace removes both old collections together', async t => {
  const { proxy, settings, port } = await createServer(t);
  proxy.loadMockRules([mockRule('old-mock')]);
  proxy.loadBreakpoints([breakpointRule('old-breakpoint')]);
  settings.setAll({ mockRules: proxy.mockRules, breakpointRules: proxy.breakpointRules });

  const result = await requestJson(port, '/api/rules', {
    mockRules: [mockRule('new-mock')],
    breakpointRules: [breakpointRule('new-breakpoint', 'response')]
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(proxy.mockRules.map(rule => rule.title), ['new-mock']);
  assert.deepEqual(proxy.breakpointRules.map(rule => rule.phase), ['response']);
  assert.deepEqual(settings.get('mockRules'), proxy.mockRules);
  assert.deepEqual(settings.get('breakpointRules'), proxy.breakpointRules);
});

test('legacy mock-only replacement never changes persisted or runtime breakpoints', async t => {
  const { proxy, settings, port } = await createServer(t);
  const breakpoint = breakpointRule('keep-breakpoint');
  proxy.loadMockRules([mockRule('old-mock')]);
  proxy.loadBreakpoints([breakpoint]);
  settings.setAll({ mockRules: proxy.mockRules, breakpointRules: proxy.breakpointRules });
  const breakpointReference = proxy.breakpointRules;
  const savedBreakpoint = structuredClone(settings.get('breakpointRules'));

  const result = await requestJson(port, '/api/mock-rules', {
    rules: [mockRule('legacy-import')]
  });

  assert.equal(result.statusCode, 200);
  assert.equal(proxy.breakpointRules, breakpointReference);
  assert.deepEqual(proxy.breakpointRules, [breakpoint]);
  assert.deepEqual(settings.get('breakpointRules'), savedBreakpoint);
  assert.deepEqual(savedSettings(settings).breakpointRules, savedBreakpoint);
});

test('version 1 and raw-array renderer imports atomically use the mock-only route and keep prompt semantics', async t => {
  for (const fileData of [
    { version: 1, rules: [mockRule('v1')] },
    [mockRule('raw')]
  ]) {
    await t.test(Array.isArray(fileData) ? 'raw array' : 'version 1', async () => {
      const renderer = createImportRenderer({
        fileData,
        breakpointRules: [breakpointRule('existing-breakpoint')]
      });

      await renderer.importRules();

      assert.equal(renderer.confirmCalls, 0);
      assert.deepEqual(renderer.requests.map(request => request.url), ['/api/mock-rules']);
      assert.deepEqual(renderer.requests.map(request => request.method), ['PUT']);
      assert.deepEqual(renderer.requests[0].body, { rules: fileData.rules || fileData });
      assert.equal(renderer.mockReloads, 1);
      assert.equal(renderer.breakpointReloads, 0);
    });
  }
});

test('invalid mixed version 2 imports leave both runtime and persisted collections unchanged', async t => {
  const { proxy, settings, port } = await createServer(t);
  const oldMock = mockRule('old-mock');
  const oldBreakpoint = breakpointRule('old-breakpoint');
  proxy.loadMockRules([oldMock]);
  proxy.loadBreakpoints([oldBreakpoint]);
  settings.setAll({ mockRules: proxy.mockRules, breakpointRules: proxy.breakpointRules });
  const beforeFile = savedSettings(settings);
  let writes = 0;
  const originalSetAll = settings.setAll.bind(settings);
  settings.setAll = values => {
    writes += 1;
    return originalSetAll(values);
  };

  const result = await requestJson(port, '/api/rules', {
    mockRules: [mockRule('valid-mock')],
    breakpointRules: [{ id: 'invalid-breakpoint', matchers: {} }]
  });

  assert.equal(result.statusCode, 400);
  assert.equal(writes, 0);
  assert.deepEqual(proxy.mockRules, [oldMock]);
  assert.deepEqual(proxy.breakpointRules, [oldBreakpoint]);
  assert.deepEqual(savedSettings(settings), beforeFile);
});

test('version 2 persistence failure rolls back both collections and leaves the settings file intact', async t => {
  t.mock.method(console, 'error', () => {});
  const { proxy, settings, port } = await createServer(t);
  const oldMock = mockRule('old-mock');
  const oldBreakpoint = breakpointRule('old-breakpoint');
  proxy.loadMockRules([oldMock]);
  proxy.loadBreakpoints([oldBreakpoint]);
  settings.setAll({ mockRules: proxy.mockRules, breakpointRules: proxy.breakpointRules });
  const beforeFile = savedSettings(settings);
  const mockReference = proxy.mockRules;
  const breakpointReference = proxy.breakpointRules;
  settings._save = () => { throw new Error('disk full'); };

  const result = await requestJson(port, '/api/rules', {
    mockRules: [mockRule('replacement-mock')],
    breakpointRules: [breakpointRule('replacement-breakpoint')]
  });

  assert.equal(result.statusCode, 500);
  assert.match(result.body.error, /disk full/);
  assert.equal(proxy.mockRules, mockReference);
  assert.equal(proxy.breakpointRules, breakpointReference);
  assert.deepEqual(proxy.mockRules, [oldMock]);
  assert.deepEqual(proxy.breakpointRules, [oldBreakpoint]);
  assert.deepEqual(settings.getAll(), beforeFile);
  assert.deepEqual(savedSettings(settings), beforeFile);
});
