import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateExportSnippet } from '../../src/ui/request-export.js';

test('Wget multipart assembly reads literal filenames and stops on missing files', t => {
  const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh';
  if (!fs.existsSync(shell)) return t.skip('POSIX shell unavailable');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freekit-wget-files-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from([0, 255, 65, 10, 13, 128]);
  for (const filename of ['payload.bin', '-payload.bin', '--version', '-']) {
    fs.writeFileSync(path.join(directory, filename), bytes);
  }
  for (const filename of ['payload.bin', '-payload.bin', '--version', '-', 'missing.bin']) {
    const snippet = generateExportSnippet({
      method: 'POST', url: 'http://example.test/upload', bodyType: 'multipart',
      requestHeaders: {}, multipartBoundary: 'fixture-boundary',
      formFields: [{ key: 'upload', type: 'file', fileName: filename }]
    }, 'wget');
    const script = 'wget() { cat "$body_file"; };\n' + snippet;
    const child = spawnSync(shell, process.platform === 'win32'
      ? ['--noprofile', '--norc', '-c', script] : ['-c', script], {
      cwd: directory, windowsHide: true, input: Buffer.alloc(0)
    });
    if (filename === 'missing.bin') {
      assert.notEqual(child.status, 0);
      assert.equal(child.stdout.length, 0, 'Wget must not receive an incomplete body');
    } else {
      assert.equal(child.status, 0, child.stderr.toString());
      const expected = Buffer.concat([
        Buffer.from(`--fixture-boundary\r\nContent-Disposition: form-data; name="upload"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        bytes, Buffer.from('\r\n--fixture-boundary--\r\n')
      ]);
      assert.deepEqual(child.stdout, expected, filename);
    }
  }
});
