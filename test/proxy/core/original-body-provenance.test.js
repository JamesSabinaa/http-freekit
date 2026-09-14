import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { ProxyServer } from '../../../src/proxy/proxy-server.js';
import { McpServerBridge } from '../../../src/mcp/mcp-server.js';
import { ApiServer } from '../../../src/api/api-server.js';

const source = fs.readFileSync(new URL('../../../src/ui/app.js', import.meta.url), 'utf8');
const viewSource = source.slice(source.indexOf('    function getEffectiveRequest('), source.indexOf('    function toggleUrlBreakdown('));
const bytesSource = source.slice(source.indexOf('    function bodyToBytes('), source.indexOf('    function readProtoVarint('));
const renderer = vm.createContext({ URL, TextEncoder, Uint8Array, atob });
vm.runInContext(`let _transformPerspective = 'original';\n${viewSource}\n${bytesSource}`, renderer);

for (const kind of ['binary', 'decoded binary', 'truncated text', 'complete text']) {
  test(`original ${kind} retains its own provenance through JSON and renderer/MCP views`, async t => {
    const proxy = new ProxyServer(null);
    const binary = Buffer.from([0, 255, 16, 128]);
    const original = kind === 'truncated text' ? Buffer.alloc(512 * 1024 + 17, 'x')
      : kind === 'complete text' ? Buffer.from('original text') : binary;
    const wire = kind === 'decoded binary' ? zlib.gzipSync(original) : original;
    const capture = {
      id: 'original-test', method: 'POST', url: 'http://example.test/changed',
      timestamp: Date.now(), statusCode: 200, protocol: 'http',
      requestHeaders: { 'content-type': 'text/plain' }, requestBody: 'changed',
      requestBodyEncoding: 'utf8', requestBodySize: 7,
      requestBodyTruncated: true, requestBodyCapturedSize: 7, requestBodyDecodedSize: 100,
      requestBodyContentDecoded: true,
      originalRequest: proxy._snapshotMockRequest({
        method: 'POST', url: 'http://example.test/original', body: wire,
        headers: {
          'content-type': kind.includes('binary') ? 'application/octet-stream' : 'text/plain',
          ...(kind === 'decoded binary' ? { 'content-encoding': 'gzip' } : {})
        }
      })
    };
    proxy._normalizeCapturedBodies(capture);
    const api = new ApiServer(proxy, null, null);
    api.port = 0;
    await api.start();
    t.after(() => api.stop());
    const base = `http://127.0.0.1:${api.httpServer.address().port}`;
    const imported = await fetch(`${base}/api/traffic/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requests: [capture] })
    });
    assert.equal(imported.status, 200, await imported.text());
    const exported = await fetch(`${base}/api/traffic/export`);
    assert.equal(exported.status, 200);
    const serialized = (await exported.json()).requests.find(record => record.id === capture.id);
    assert.ok(serialized);
    assert.equal(typeof serialized.originalRequest.body, 'string');
    assert.equal(serialized.originalRequest.bodyEncoding, kind.includes('binary') ? 'base64' : 'utf8');
    assert.equal(serialized.originalRequest.bodySize, wire.length);
    const view = renderer.getEffectiveRequest(serialized);
    const bytes = Buffer.from(renderer.bodyToBytes(view.requestBody, { section: 'request', request: view }));
    const retained = original.subarray(0, 512 * 1024);
    assert.deepEqual(bytes, retained);
    assert.equal(view.requestBodySize, wire.length);
    assert.equal(view.requestBodyTruncated, kind === 'truncated text');
    assert.equal(view.requestBodyContentDecoded, kind === 'decoded binary');
    if (kind === 'truncated text') {
      assert.equal(view.requestBodyCapturedSize, retained.length);
      assert.equal(view.requestBodyDecodedSize, original.length);
    } else {
      assert.notEqual(view.requestBodyDecodedSize, 100);
      assert.notEqual(view.requestBodyCapturedSize, 7);
    }
    const bridge = new McpServerBridge({ apiServer: { trafficLog: [serialized], _broadcast() {} }, proxyServer: {}, interceptorManager: {} });
    const detail = JSON.parse(bridge._handleGetRequestDetail({ request_id: serialized.id }).content[0].text);
    assert.equal(detail.bodies.original_request.encoding, kind.includes('binary') ? 'base64' : 'utf8');
    assert.equal(detail.bodies.original_request.truncated, kind === 'truncated text');
    if (kind === 'truncated text') assert.equal(detail.bodies.original_request.decodedSize, original.length);
  });
}
