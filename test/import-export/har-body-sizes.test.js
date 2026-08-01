import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { ApiServer } from '../../src/api/api-server.js';
import { trafficToHar } from '../../src/api/har-converter.js';
import { normalizeHarEntries } from '../../src/ui/har-import.js';

function sizeEntry(url, requestSize, responseWireSize, responseDecodedSize, headers = []) {
  return {
    startedDateTime: '2026-01-01T00:00:00.000Z',
    time: 1,
    request: {
      method: 'POST',
      url,
      headers: [],
      postData: { mimeType: 'text/plain', text: 'request' },
      bodySize: requestSize
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers,
      content: { mimeType: 'text/plain', text: 'response', size: responseDecodedSize },
      bodySize: responseWireSize
    }
  };
}

function sizeHar() {
  return {
    log: {
      version: '1.2',
      entries: [
        sizeEntry(
          'https://example.test/compressed',
          50,
          100,
          1000,
          [{ name: 'Content-Encoding', value: 'gzip' }]
        ),
        sizeEntry('https://example.test/uncompressed', 200, 300, 300),
        sizeEntry('https://example.test/unknown', -1, -1, -1)
      ]
    }
  };
}

function expectedSizes(records) {
  return records.map(record => [
    record.requestBodySize,
    record.responseBodySize,
    record.responseBodyDecodedSize
  ]);
}

function exportedSizes(har) {
  return har.log.entries.map(entry => [
    entry.request.bodySize,
    entry.response.bodySize,
    entry.response.content.size
  ]);
}

function postHar(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/traffic/import-har',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

test('server HAR import and export preserve request, response wire, and decoded sizes', async (t) => {
  const proxy = {
    port: 8081,
    mockRules: [],
    onBreakpoint: null,
    onUpstreamProxyRetry: null,
    matchApiSpec: () => null
  };
  const api = new ApiServer(proxy, null, null);
  const server = http.createServer(api.app);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await postHar(server.address().port, sizeHar());

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(expectedSizes(api.trafficLog), [
    [50, 100, 1000],
    [200, 300, 300],
    [-1, -1, -1]
  ]);
  assert.deepEqual(
    exportedSizes(trafficToHar(api.trafficLog, { maskSensitive: false })),
    [[50, 100, 1000], [200, 300, 300], [-1, -1, -1]]
  );
});

test('visible renderer HAR import and export preserve the same size model', async () => {
  const rendererSource = fs.readFileSync(path.join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');
  const start = rendererSource.indexOf('function importHar()');
  const end = rendererSource.indexOf('// ============ ACTIONS ============', start);
  assert.ok(start >= 0 && end > start);

  const added = [];
  const inputs = [];
  let nextId = 0;
  const context = {
    API_BASE: '',
    URL,
    addRequest: request => added.push(request),
    normalizeHarEntries: document => normalizeHarEntries(document, {
      createId: () => `renderer-size-${++nextId}`
    }),
    fetch: async (_url, options) => {
      const requests = JSON.parse(options.body).requests;
      added.push(...requests);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, imported: requests.length })
      };
    },
    document: {
      createElement: () => {
        const input = { click: () => {} };
        inputs.push(input);
        return input;
      }
    },
    toast: () => {}
  };
  vm.createContext(context);
  vm.runInContext(`
    ${rendererSource.slice(start, end)}
    globalThis.importHarForTest = importHar;
  `, context);

  context.importHarForTest();
  await inputs[0].onchange({
    target: { files: [{ text: async () => JSON.stringify(sizeHar()) }] }
  });

  assert.deepEqual(expectedSizes(added), [
    [50, 100, 1000],
    [200, 300, 300],
    [-1, -1, -1]
  ]);
  assert.deepEqual(
    exportedSizes(trafficToHar(added, { maskSensitive: false })),
    [[50, 100, 1000], [200, 300, 300], [-1, -1, -1]]
  );
});

test('legacy traffic without decoded size keeps the previous response-size fallback', () => {
  const exported = trafficToHar([{
    timestamp: 0,
    method: 'GET',
    url: 'https://example.test/legacy',
    requestBodySize: 0,
    responseBody: 'legacy body',
    responseBodySize: 11
  }], { maskSensitive: false }).log.entries[0];

  assert.equal(exported.response.bodySize, 11);
  assert.equal(exported.response.content.size, 11);
});
