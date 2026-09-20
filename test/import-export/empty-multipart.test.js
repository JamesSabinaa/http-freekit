import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import test from 'node:test';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { parse } from 'acorn';
import { generateExportSnippet } from '../../src/ui/request-export.js';

const run = promisify(execFile);
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : '/bin/sh';
const configuredBoundary = '----empty-form-regression';
const emptyCases = [
  ['missing rows', undefined],
  ['no rows', []],
  ['disabled rows', [{ key: 'ignored', value: 'ignored', enabled: false },
    { key: 'file', type: 'file', fileName: 'must-not-read.bin', enabled: false }]],
  ['unnamed rows', [{ key: '', value: 'ignored' }, { key: '', type: 'file', fileName: 'must-not-read.bin' }]]
];
const staleHeaders = {
  'cOnTeNt-TyPe': 'multipart/form-data; boundary=obsolete-boundary',
  'Content-Encoding': 'obsolete-coding', 'Content-Length': '9999',
  'Transfer-Encoding': 'obsolete-framing', Trailer: 'obsolete-trailer', 'X-Marker': 'preserved'
};

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
      const lines = data.subarray(0, headerEnd).toString('latin1').split('\r\n');
      const headers = Object.fromEntries(lines.slice(1).map(line => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
      }));
      const length = Number(headers['content-length'] || 0);
      if (data.length < headerEnd + 4 + length) return;
      received.push({ method: lines[0].split(' ')[0], headers, lines,
        body: data.subarray(headerEnd + 4, headerEnd + 4 + length) });
      socket.removeAllListeners('data');
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}/form`, received };
}

async function execute(request, format) {
  const snippet = generateExportSnippet(request, format);
  const options = { windowsHide: true, timeout: 7000, env: { ...process.env, NO_PROXY: '*', no_proxy: '*' } };
  if (format === 'curl') return run(shell, ['-c', snippet.replace(/(^|\| )curl /,
    '$1curl -q --noproxy "*" --silent --show-error --max-time 5 ')], options);
  if (format === 'python') return run('python', ['-c', snippet], options);
  return run(process.execPath, ['--input-type=commonjs', '-e', snippet], options);
}

function assertEntity(captured, method, expectedBoundary, expectedPart = '') {
  assert.equal(captured.method, method);
  assert.equal(captured.headers['x-marker'], 'preserved');
  for (const name of ['content-encoding', 'transfer-encoding', 'trailer']) assert.equal(captured.headers[name], undefined);
  assert.equal(captured.lines.filter(line => /^content-type:/i.test(line)).length, 1);
  assert.equal(captured.lines.filter(line => /^content-length:/i.test(line)).length, 1);
  const match = /^multipart\/form-data; boundary=(?:"([^"]+)"|([^;\s]+))$/.exec(captured.headers['content-type']);
  assert.ok(match, captured.headers['content-type']);
  const boundary = match[1] || match[2];
  if (expectedBoundary !== undefined) assert.equal(boundary, expectedBoundary);
  assert.match(boundary, /^[0-9A-Za-z'()+_,./:=? -]{0,69}[0-9A-Za-z'()+_,./:=?-]$/);
  const expected = expectedPart
    ? `--${boundary}\r\nContent-Disposition: form-data; name="kept"\r\n\r\n${expectedPart}\r\n--${boundary}--\r\n`
    : `--${boundary}--\r\n`;
  assert.equal(captured.body.toString(), expected);
  assert.equal(Number(captured.headers['content-length']), Buffer.byteLength(expected));
  return boundary;
}

for (const format of ['curl', 'python', 'javascript-node']) {
  test(`${format}: empty multipart exports retain a valid entity and rebuilt headers`, { timeout: 45000 }, async t => {
    if (format === 'curl' && !fs.existsSync(shell)) return t.skip('POSIX shell is unavailable');
    if (format === 'python' && spawnSync('python', ['-c', 'import requests'], { windowsHide: true }).status !== 0) {
      return t.skip('Python Requests is unavailable');
    }
    const { url, received } = await rawOrigin(t);
    for (const [name, formFields] of emptyCases) {
      await t.test(name, async () => {
        await execute({ url, method: 'POST', bodyType: 'multipart', formFields,
          multipartBoundary: configuredBoundary, requestHeaders: staleHeaders }, format);
        assertEntity(received.at(-1), 'POST', configuredBoundary);
      });
    }
    await t.test('safe fallback boundary', async () => {
      await execute({ url, method: 'POST', bodyType: 'multipart', formFields: [], requestHeaders: staleHeaders }, format);
      assertEntity(received.at(-1), 'POST');
    });
    await t.test('omitted method defaults to POST on the wire', async () => {
      await execute({ url, bodyType: 'multipart', formFields: [], requestHeaders: staleHeaders }, format);
      assertEntity(received.at(-1), 'POST');
    });
    await t.test('nonempty filtered control', async () => {
      await execute({ url, method: 'POST', bodyType: 'multipart', requestHeaders: staleHeaders,
        formFields: [{ key: '', value: 'ignored' }, { key: 'disabled', enabled: false }, { key: 'kept', value: 'value' }] }, format);
      assertEntity(received.at(-1), 'POST', undefined, 'value');
    });
    await t.test('custom method retains exact case', async () => {
      await execute({ url, method: 'MiXeD', bodyType: 'multipart', formFields: [],
        multipartBoundary: configuredBoundary, requestHeaders: staleHeaders }, format);
      assertEntity(received.at(-1), 'MiXeD', configuredBoundary);
    });
    if (format !== 'javascript-node') {
      for (const boundary of ["safe 'quoted' boundary:()/=?", 'b'.repeat(70), '', 'b'.repeat(71), 'trailing ', 'bad\r\nboundary']) {
        await t.test(`boundary ${JSON.stringify(boundary)}`, async () => {
          await execute({ url, method: 'POST', bodyType: 'multipart', formFields: [],
            multipartBoundary: boundary, requestHeaders: staleHeaders }, format);
          const valid = boundary === "safe 'quoted' boundary:()/=?" || boundary.length === 70;
          const actualBoundary = assertEntity(received.at(-1), 'POST', valid ? boundary : undefined);
          if (!valid) assert.notEqual(actualBoundary, boundary);
        });
      }
    }
  });
}

test('empty export bytes agree with real Send preparation for every filtered-empty form', async () => {
  const source = fs.readFileSync(new URL('../../src/ui/app.js', import.meta.url), 'utf8');
  const functions = new Map(parse(source, { ecmaVersion: 'latest', sourceType: 'script' }).body
    .filter(node => node.type === 'FunctionDeclaration').map(node => [node.id.name, source.slice(node.start, node.end)]));
  const names = ['getSendBodyType', 'findHeaderKey', 'setDefaultHeader', 'prepareSendRequestPayload',
    'preflightMultipartSendRequest', 'multipartBodyByteLength', 'utf8StringByteLength', 'formatWholeMiB',
    'quoteMultipartDispositionValue', 'serializeMultipartFields', 'throwIfSendAborted', 'bytesToBase64', 'getMultipartDisplayBody'];
  for (const [, fields] of emptyCases) {
    const context = vm.createContext({ TextEncoder, Uint8Array, btoa,
      document: { getElementById: () => ({ value: 'multipart' }) } });
    vm.runInContext(`let sendMultipartFields = ${JSON.stringify(fields || [])};
      let sendMultipartBoundary = ${JSON.stringify(configuredBoundary)};
      const SEND_MANAGEMENT_JSON_MAX_BYTES = 50 * 1024 * 1024;
      ${names.map(name => { assert.ok(functions.has(name), name); return functions.get(name); }).join('\n')}`, context);
    const headers = {};
    const payload = await context.prepareSendRequestPayload(headers);
    assert.equal(headers['Content-Type'], `multipart/form-data; boundary=${configuredBoundary}`);
    assert.equal(payload.bodyEncoding, 'base64');
    assert.equal(Buffer.from(payload.body, 'base64').toString(), `--${configuredBoundary}--\r\n`);
    assert.equal(payload.byteLength, Buffer.byteLength(`--${configuredBoundary}--\r\n`));
  }
});
