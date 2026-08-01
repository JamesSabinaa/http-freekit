import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const mainSource = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.cjs'), 'utf8');
const requestStart = mainSource.indexOf('async function requestImportHar(targetUrl)');
const requestEnd = mainSource.indexOf('function scheduleDeepLink(', requestStart);
assert.ok(requestStart >= 0 && requestEnd > requestStart, 'HAR import request function must be present');
const requestSource = mainSource.slice(requestStart, requestEnd);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('desktop HAR deep links send the loaded document to the authenticated import API', async t => {
  const har = Buffer.from('{"log":{"entries":[]}}');
  const received = {};
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received.path = req.url;
      received.authorization = req.headers.authorization;
      received.contentType = req.headers['content-type'];
      received.body = Buffer.concat(chunks);
      const response = JSON.stringify({ success: true, imported: 0 });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(response)
      });
      res.end(response);
    });
  });
  const port = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));

  const loadedTargets = [];
  const context = { Buffer, har, http, loadedTargets };
  vm.createContext(context);
  vm.runInContext(`
    const apiPort = ${port};
    const authToken = 'desktop-secret';
    async function loadHarTarget(targetUrl) {
      loadedTargets.push(targetUrl);
      return har;
    }
    ${requestSource}
    globalThis.requestImportHar = requestImportHar;
  `, context);

  const result = await context.requestImportHar('https://example.test/capture.har');
  assert.equal(result.imported, 0);
  assert.deepEqual(loadedTargets, ['https://example.test/capture.har']);
  assert.equal(received.path, '/api/traffic/import-har');
  assert.equal(received.authorization, 'Bearer desktop-secret');
  assert.equal(received.contentType, 'application/json');
  assert.deepEqual(received.body, har);
});
