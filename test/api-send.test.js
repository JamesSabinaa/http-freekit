import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ApiServer } from '../src/api/api-server.js';

test('send API decodes base64 request bodies without corrupting binary data', async (t) => {
  let resolveReceived;
  const received = new Promise(resolve => { resolveReceived = resolve; });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      resolveReceived({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const expected = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);
  const address = server.address();
  const response = ApiServer.prototype._sendRequest.call(
    {},
    `http://127.0.0.1:${address.port}/upload`,
    'POST',
    { 'Content-Type': 'application/octet-stream' },
    expected.toString('base64'),
    'base64'
  );

  const request = await received;
  assert.deepEqual(request.body, expected);
  assert.equal(request.headers['content-type'], 'application/octet-stream');
  assert.equal((await response).statusCode, 200);
});
