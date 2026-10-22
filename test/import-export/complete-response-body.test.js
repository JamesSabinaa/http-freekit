import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import vm from 'node:vm';
import zlib from 'node:zlib';
import * as acorn from 'acorn';
import beautifier from 'js-beautify';
import { ProxyServer } from '../../src/proxy/proxy-server.js';
import { ApiServer } from '../../src/api/api-server.js';

const source = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
const viewer = vm.createContext({ acorn, beautifier: { js: beautifier.js } });
for (const [start, end] of [
  ['function formatCodeWithSyntaxChecks(', 'function wrapWithLineNumbers('],
  ['function getMonacoBodyValue(', 'async function initBodyMonacoEditor(']
]) {
  vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), viewer);
}

const javascript = Buffer.from(`/*${'padding '.repeat(70_000)}*/\nconst result = "complete tail";\nglobalThis.result = result;`);
for (const [name, body, contentType, compressed] of [
  ['JavaScript', javascript, 'application/javascript', false],
  ['compressed JavaScript', javascript, 'application/javascript', true],
  ['binary', Buffer.alloc(2 * 1024 * 1024 + 1, 0xff), 'application/octet-stream', false]
]) {
  test(`${name} survives proxy capture, renderer detail, and HAR download in full`, async t => {
    const wire = compressed ? zlib.gzipSync(body) : body;
    const origin = http.createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': wire.length,
        ...(compressed ? { 'content-encoding': 'gzip' } : {})
      });
      res.end(wire);
    });
    origin.listen(0, '127.0.0.1');
    await once(origin, 'listening');
    t.after(() => new Promise(resolve => origin.close(resolve)));
    let api;
    const proxy = new ProxyServer(null, { port: 0, onRequest: data => api.onTrafficEvent(data) });
    api = new ApiServer(proxy, null, null, { port: 0 });
    api.port = 0;
    await api.start();
    t.after(() => api.stop());
    await proxy.start();
    t.after(() => proxy.stop());

    const target = `http://127.0.0.1:${origin.address().port}/bundle.js`;
    const received = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: proxy.server.address().port, path: target }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
    assert.deepEqual(received, wire);
    const record = api.trafficLog.find(item => item.url === target && item.statusCode === 200);
    assert.ok(record);
    const base = `http://127.0.0.1:${api.httpServer.address().port}`;
    const detailResponse = await fetch(`${base}/api/traffic/${encodeURIComponent(record.id)}`);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.notEqual(detail.responseBodyTruncated, true);
    if (contentType === 'application/javascript') {
      assert.equal(detail.responseBody, body.toString());
      // This is the complete text supplied to the read-only editor used for copying.
      const displayed = viewer.getMonacoBodyValue(detail.responseBody, 'javascript');
      assert.ok(displayed.endsWith('globalThis.result = result;'));
      const executed = {};
      vm.runInNewContext(displayed, executed);
      assert.equal(executed.result, 'complete tail');
      assert.equal(viewer.getMonacoBodyValue(detail.responseBody, 'text'), body.toString());
    } else {
      assert.equal(detail.responseBodyEncoding, 'base64');
      assert.deepEqual(Buffer.from(detail.responseBody.split(',')[1], 'base64'), body);
    }

    const exportResponse = await fetch(`${base}/api/traffic/export.har`);
    assert.equal(exportResponse.status, 200);
    const har = await exportResponse.json();
    const exported = har.log.entries.find(entry => entry.request.url === target).response;
    const exportedBytes = Buffer.from(exported.content.text, exported.content.encoding || 'utf8');
    assert.deepEqual(exportedBytes, body);
    assert.equal(exported.content.size, body.length);
    assert.equal(exported.bodySize, wire.length);
    assert.equal(exported.content._truncated, undefined);
  });
}
