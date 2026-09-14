import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';
import { promisify } from 'node:util';
import { generateExportSnippet } from '../../src/ui/request-export.js';

const run = promisify(execFile);

test('Node.js exports deliver body bytes with valid framing for all common methods', async t => {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
      res.end('ok');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const method of ['GET', 'DELETE', 'OPTIONS', 'HEAD', 'TRACE', 'POST', 'PATCH']) {
    for (const encoding of ['utf8', 'base64']) {
      for (const framing of ['none', 'content-type', 'length', 'chunked']) {
        await t.test(`${method} ${encoding} ${framing}`, async () => {
          const body = encoding === 'utf8' ? Buffer.from('hello café 🌍') : Buffer.from([0, 255, 128, 13, 10]);
          const headers = framing === 'none' ? {} : framing === 'length'
            ? { 'content-LENGTH': String(body.length) } : framing === 'chunked'
              ? { 'transfer-ENCODING': 'chunked' } : { 'Content-Type': 'application/octet-stream' };
          const snippet = generateExportSnippet({
            method,
            url: `http://127.0.0.1:${server.address().port}/body`,
            requestHeaders: headers,
            requestBody: encoding === 'base64' ? `data:application/octet-stream;base64,${body.toString('base64')}` : body.toString('utf8'),
            requestBodyEncoding: encoding
          }, 'javascript-node');
          const { stdout } = await run(process.execPath, ['--input-type=commonjs', '-e', snippet], { timeout: 10000, windowsHide: true });
          assert.match(stdout, /^200 /);
          const request = received.at(-1);
          assert.equal(request.method, method);
          assert.deepEqual(request.body, body);
          assert.ok(Number(request.headers['content-length']) === body.length || request.headers['transfer-encoding'] === 'chunked');
        });
      }
    }
  }
});
