import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import net from 'node:net';
import test from 'node:test';
import { promisify } from 'node:util';
import { generateExportSnippet } from '../../src/ui/request-export.js';

const run = promisify(execFile);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const binary = Buffer.from([0, 255, 128, 13, 10]);
const bodies = [
  ['raw', { requestBody: 'literal body' }, Buffer.from('literal body')],
  ['binary', { requestBody: `data:application/octet-stream;base64,${binary.toString('base64')}`, requestBodyEncoding: 'base64' }, binary],
  ['urlencoded', { bodyType: 'urlencoded', formFields: [{ key: 'name', value: 'a b' }] }, Buffer.from('name=a+b')],
  ['multipart', { bodyType: 'multipart', formFields: [{ key: 'name', value: 'first' }, { key: 'name', value: 'second' }] }, null]
];

async function rawOrigin(t) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let data = Buffer.alloc(0);
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      const headerEnd = data.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const headers = data.subarray(0, headerEnd).toString('latin1');
      const length = Number(headers.match(/\r\ncontent-length: (\d+)/i)?.[1] || 0);
      if (data.length < headerEnd + 4 + length) return;
      const method = headers.split(' ', 1)[0];
      received.push({ method, headers, body: data.subarray(headerEnd + 4, headerEnd + 4 + length) });
      socket.removeAllListeners('data');
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n' + (method === 'HEAD' ? '' : 'ok'));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}/literal`, received };
}

function assertRequest(actual, method, expectedBody) {
  assert.equal(actual.method, method);
  assert.match(actual.headers, /\r\nx-marker: preserved\r\n/i);
  assert.doesNotMatch(actual.headers, /\r\ntransfer-encoding:/i);
  if (expectedBody !== null) assert.deepEqual(actual.body, expectedBody);
  else {
    const boundary = actual.headers.match(/boundary=([^\r\n;]+)/i)?.[1];
    assert.ok(boundary, actual.headers);
    assert.equal(actual.body.toString(),
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nfirst\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nsecond\r\n--${boundary}--\r\n`);
  }
}

test('Python Requests exports preserve exact method tokens and every body format on the wire', { timeout: 60000 }, async t => {
  const available = spawnSync('python', ['-c', 'import requests'], { windowsHide: true });
  if (available.error?.code === 'ENOENT' || available.status !== 0) return t.skip('Python Requests is unavailable');
  const { url, received } = await rawOrigin(t);
  for (const method of ['MiXeD', 'pOsT', 'gEt', 'get', 'hEaD', 'POST', 'GET', 'HEAD']) {
    for (const [name, body, expected] of bodies) {
      await t.test(`${method} ${name}`, async () => {
        const snippet = generateExportSnippet({ method, url, requestHeaders: { 'X-Marker': 'preserved' }, ...body }, 'python');
        const { stdout } = await run('python', ['-c', snippet], {
          windowsHide: true, timeout: 5000, env: { ...process.env, NO_PROXY: '*', no_proxy: '*' }
        });
        assert.match(stdout, /^200\r?\n/);
        assertRequest(received.at(-1), method, expected);
      });
    }
  }
});

test('Fetch rejects method spellings it would normalize before generating a request', async () => {
  for (const method of ['get', 'hEaD', 'pOsT', 'put', 'dElEtE', 'oPtIoNs']) {
    for (const [, body] of [['empty', {}], ...bodies]) {
      const snippet = generateExportSnippet({ method, url: 'http://example.test/', ...body }, 'javascript-fetch');
      assert.match(snippet, /EXACT REPLAY UNAVAILABLE/);
      assert.ok(snippet.includes(`method ${method} to ${method.toUpperCase()}`));
      assert.match(snippet, /Node.js export/);
      await new AsyncFunction('fetch', snippet)(() => assert.fail('unsupported export must not call fetch'));
    }
  }
});

test('Fetch retains custom case-sensitive methods and uppercase controls on the wire', { timeout: 15000 }, async t => {
  const { url, received } = await rawOrigin(t);
  for (const method of ['MiXeD', 'pAtCh', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
    for (const [name, body, expected] of bodies) {
      await t.test(`${method} ${name}`, async () => {
        const snippet = generateExportSnippet({ method, url, requestHeaders: { 'X-Marker': 'preserved' }, ...body }, 'javascript-fetch');
        assert.doesNotMatch(snippet, /EXACT REPLAY UNAVAILABLE/);
        await new AsyncFunction('console', snippet)({ log() {} });
        assertRequest(received.at(-1), method, expected);
      });
    }
  }
  for (const method of ['GET', 'HEAD']) {
    await new AsyncFunction('console', generateExportSnippet({ method, url,
      requestHeaders: { 'X-Marker': 'preserved' } }, 'javascript-fetch'))({ log() {} });
    assertRequest(received.at(-1), method, Buffer.alloc(0));
  }
});
