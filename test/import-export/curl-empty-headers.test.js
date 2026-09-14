import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { promisify } from 'node:util';
import { generateExportSnippet } from '../../src/ui/request-export.js';

const run = promisify(execFile);
const shell = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\sh.exe' : '/bin/sh';

test('generated cURL commands send empty and repeated headers on the wire', async t => {
  if (!fs.existsSync(shell)) return t.skip('POSIX shell is unavailable');
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => res.end(JSON.stringify(req.rawHeaders)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const bodyType of ['raw', 'urlencoded', 'multipart']) {
    await t.test(bodyType, async () => {
      const snippet = generateExportSnippet({
        method: 'POST',
        url: `http://127.0.0.1:${server.address().port}/`,
        bodyType,
        requestBody: 'payload',
        formFields: [{ key: 'field', value: 'payload', enabled: true }],
        requestHeaders: {
          'X-Empty': '',
          "X-Quote'Empty": '',
          'X-Repeated': ['', 'middle', ''],
          'X-Normal': "value 'quoted'"
        }
      }, 'curl');
      const { stdout } = await run(shell, ['-c', snippet.replace(/^curl /, 'curl -q --noproxy "*" --silent --show-error --max-time 5 ')], { timeout: 10000, windowsHide: true });
      const raw = JSON.parse(stdout);
      const values = name => raw.filter((_, i) => i % 2 === 1 && raw[i - 1].toLowerCase() === name.toLowerCase());
      assert.deepEqual(values('X-Empty'), ['']);
      assert.deepEqual(values("X-Quote'Empty"), ['']);
      assert.deepEqual(values('X-Repeated'), ['', 'middle', '']);
      assert.deepEqual(values('X-Normal'), ["value 'quoted'"]);
      assert.deepEqual(values('X-Absent'), []);
    });
  }
});
