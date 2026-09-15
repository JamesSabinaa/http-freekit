import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { ProxyServer } from '../../src/proxy/proxy-server.js';

// Check actual bytes and encoding headers at both network boundaries.
test('text replacement preserves binary and unchanged compressed bodies in both directions', async t => {
  let received;
  const origin = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { body: Buffer.concat(chunks), encoding: request.headers['content-encoding'] };
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': received.body.length,
      ...(received.encoding ? { 'content-encoding': received.encoding } : {})
    });
    response.end(received.body);
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  t.after(() => new Promise(resolve => origin.close(resolve)));
  const proxy = new ProxyServer(null, { port: 0 });
  await proxy.start();
  t.after(() => proxy.stop());
  const cases = [
    { name: 'invalid UTF-8 without match', body: Buffer.from('00ff1080', 'hex'), pattern: 'absent' },
    { name: 'invalid UTF-8 with text match', body: Buffer.from([0xff, ...Buffer.from('hello'), 0x80]), pattern: 'hello' },
    { name: 'truncated UTF-8', body: Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xe2, 0x82]), pattern: 'hello' },
    { name: 'unmatched Unicode', body: Buffer.from('héllo 世界'), pattern: 'absent' },
    { name: 'identical replacement', body: Buffer.from('hello'), pattern: 'hello', replacement: 'hello' },
    { name: 'Unicode replacement', body: Buffer.from('héllo 世界 héllo'), pattern: 'héllo', replacement: '你好', changed: true },
    { name: 'empty replacement', body: Buffer.from('hello world'), pattern: 'hello', replacement: '', changed: true }
  ];
  for (const direction of ['request', 'response']) for (const compressed of [false, true]) for (const fixture of cases) {
    await t.test(`${direction}, gzip=${compressed}: ${fixture.name}`, async () => {
      const body = compressed ? gzipSync(fixture.body) : fixture.body;
      const replacement = fixture.replacement ?? 'changed';
      const expected = fixture.changed ? Buffer.from(fixture.body.toString('utf8').split(fixture.pattern).join(replacement)) : body;
      proxy.mockRules = [{ enabled: true, matchers: [{ type: 'wildcard' }], action: {
        type: 'transform-' + direction, bodyMode: 'match-replace',
        bodyMatchPattern: fixture.pattern, bodyReplaceWith: replacement
      } }];
      const response = await new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port: proxy.server.address().port,
          path: `http://127.0.0.1:${origin.address().port}/`, method: 'POST',
          headers: { 'content-length': body.length, ...(compressed ? { 'content-encoding': 'gzip' } : {}) }
        }, async res => {
          try { const chunks = []; for await (const chunk of res) chunks.push(chunk);
            resolve({ body: Buffer.concat(chunks), encoding: res.headers['content-encoding'] });
          } catch (error) { reject(error); }
        });
        request.on('error', reject); request.end(body);
      });
      assert.deepEqual(received.body, direction === 'request' ? expected : body);
      assert.deepEqual(response.body, expected);
      assert.equal(response.encoding, compressed && !fixture.changed ? 'gzip' : undefined);
      assert.equal(received.encoding, compressed && !(direction === 'request' && fixture.changed) ? 'gzip' : undefined);
    });
  }
});
