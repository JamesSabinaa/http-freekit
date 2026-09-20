import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';

import { ApiServer } from '../../src/api/api-server.js';

function traffic(id, apiMatch) {
  return {
    id, timestamp: '2026-01-01T00:00:00.000Z', protocol: 'http',
    method: 'GET', url: 'http://example.test/items', host: 'example.test', path: '/items',
    requestHeaders: {}, responseHeaders: {}, statusCode: 200, duration: 1,
    ...(apiMatch === undefined ? {} : { apiMatch })
  };
}

function postImport(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1', port, path: '/api/traffic/import', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString())
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

async function createApi(t) {
  const api = new ApiServer({ mockRules: [], matchApiSpec: () => null });
  const broadcasts = [];
  api._broadcast = message => broadcasts.push(message);
  const server = http.createServer(api.app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    api._trafficImportTransactions.dispose();
    await new Promise(resolve => server.close(resolve));
  });
  return { api, broadcasts, port: server.address().port };
}

test('traffic imports reject malformed API metadata without appending or evicting any rows', async t => {
  const { api, broadcasts, port } = await createApi(t);
  const retained = traffic('retained', { parameters: [{ name: 'existing' }] });
  api.trafficLog.push(retained);
  api.maxTrafficLog = 1;
  const originalLog = api.trafficLog;
  const originalRows = structuredClone(api.trafficLog);
  const malformed = [
    { parameters: 'invalid' }, { parameters: {} },
    ...[null, [], 'invalid', false, 1].map(parameter => ({ parameters: [parameter] })),
    'invalid', [], false, 1,
    ...['operationId', 'summary', 'description', 'pathPattern'].map(field => ({ [field]: {} })),
    { tags: 'items' }, { tags: [null] }, { tags: [{}] },
    ...['name', 'in', 'description'].map(field => ({ parameters: [{ [field]: {} }] })),
    { parameters: [{ required: 'false' }] }
  ];
  for (const apiMatch of malformed) {
    const result = await postImport(port, {
      requests: [traffic('valid-prefix', {}), traffic('invalid', apiMatch)]
    });
    assert.equal(result.status, 400, JSON.stringify(apiMatch));
    assert.match(result.body.error, /requests\[1\]\.apiMatch/);
    assert.equal(api.trafficLog, originalLog);
    assert.deepEqual(api.trafficLog, originalRows);
    assert.deepEqual(broadcasts, []);
  }
});

test('malformed API metadata discards all staged import batches and allows a clean retry', async t => {
  const { api, broadcasts, port } = await createApi(t);
  const retained = traffic('retained');
  api.trafficLog.push(retained);
  const metadata = { id: 'api-metadata', count: 2 };
  const first = await postImport(port, {
    requests: [traffic('prefix', { parameters: [{ name: 'valid' }] })],
    importTransaction: { ...metadata, index: 0 }
  });
  assert.equal(first.status, 202);
  assert.deepEqual(api.trafficLog, [retained]);
  const invalid = await postImport(port, {
    requests: [traffic('invalid', { parameters: [null] })],
    importTransaction: { ...metadata, index: 1 }
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /apiMatch\.parameters\[0\]/);
  assert.equal(invalid.body.code, 'ERR_TRAFFIC_IMPORT_TRANSACTION');
  assert.equal(api._trafficImportTransactions.transactions.size, 0);
  assert.equal(api._trafficImportTransactions.totalExpandedBytes, 0);
  assert.deepEqual(api.trafficLog, [retained]);
  assert.deepEqual(broadcasts, []);

  const resumed = await postImport(port, {
    requests: [traffic('replacement')], importTransaction: { ...metadata, index: 1 }
  });
  assert.equal(resumed.status, 400);
  assert.deepEqual(api.trafficLog, [retained]);
  const retry = await postImport(port, {
    requests: [traffic('prefix')], importTransaction: { ...metadata, index: 0 }
  });
  assert.equal(retry.status, 202);
  const completed = await postImport(port, {
    requests: [traffic('replacement')], importTransaction: { ...metadata, index: 1 }
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.imported, 2);
  assert.deepEqual(api.trafficLog.map(row => row.id), ['retained', 'prefix', 'replacement']);
});

function createDetailRenderer() {
  const source = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
  const names = [
    'renderDetailCards', 'getEffectiveRequest', 'getResponseStatusPillBackground',
    'formatRemoteEndpoint', 'isConnectedWebSocket', 'isWebSocketConnection', 'formatSize'
  ];
  const nodes = parse(source, { ecmaVersion: 'latest' }).body
    .filter(node => node.type === 'FunctionDeclaration' && names.includes(node.id.name));
  assert.equal(nodes.length, names.length);
  const content = { innerHTML: '' };
  const escape = value => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const context = vm.createContext({
    document: { getElementById: id => id === 'detailContent' ? content : null }, window: {},
    _detailRenderedRequestIdentity: null, _detailHeaderScope: 0, _transformPerspective: 'transformed',
    _headerCollapsed: {}, _urlBreakdownOpen: false, SOURCE_ICONS: { Other: '' },
    esc: escape, escapeHtmlAttribute: escape, disposeBodyEditor() {},
    renderUrlBreakdown: () => '', renderHeadersGrid: () => '',
    getCombinedHeaderValue: () => '', initializeDetailCardDisclosures() {}
  });
  vm.runInContext(nodes.map(node => source.slice(node.start, node.end)).join('\n'), context);
  return row => {
    context.renderDetailCards(row);
    return content.innerHTML;
  };
}

test('imported optional API metadata retains valid documentation and renders its detail card', async t => {
  const { api, port } = await createApi(t);
  const documented = {
    operationId: 'listItems', summary: 'List <items>', description: 'Lists all available items',
    pathPattern: '/items', tags: ['Items', 'Public'],
    parameters: [
      { name: 'limit', in: 'query', description: 'Maximum <count>', required: true,
        schema: { type: 'integer', minimum: 0 }, example: 10, 'x-extra': { nested: true } },
      { name: 'filter', in: 'query', required: false, content: { 'application/json': { schema: {} } } },
      { $ref: '#/components/parameters/TraceId' }, {},
      { name: null, in: null, description: null, required: null }
    ],
    'x-extra': { preserved: ['value'] }
  };
  const matches = [undefined, null, {}, { parameters: [], tags: [] },
    { operationId: null, summary: null, description: null, pathPattern: null, parameters: null, tags: null },
    documented];
  const result = await postImport(port, { requests: matches.map((match, index) => traffic(`valid-${index}`, match)) });
  assert.equal(result.status, 200, result.body.error);
  assert.equal(result.body.imported, matches.length);
  const render = createDetailRenderer();
  for (const [index, row] of api.trafficLog.entries()) {
    assert.deepEqual(row.apiMatch, matches[index]);
    assert.doesNotThrow(() => render(row));
  }
  const html = render(api.trafficLog.at(-1));
  for (const text of ['Items', 'listItems', 'List &lt;items&gt;', 'Maximum &lt;count&gt;', 'limit', '(query)', 'required', 'Path: /items']) {
    assert.ok(html.includes(text), text);
  }
});
