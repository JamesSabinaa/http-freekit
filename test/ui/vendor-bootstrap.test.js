import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { gzipSync, deflateSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const root = new URL('../../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');
const vendorFiles = new Map([
  ['/vendor/js-yaml/js-yaml.umd.min.js', 'node_modules/js-yaml/dist/browser/js-yaml.umd.min.js'],
  ['/vendor/protobufjs/protobuf.min.js', 'node_modules/protobufjs/dist/protobuf.min.js'],
  ['/vendor/pako/pako.umd.min.js', 'node_modules/pako/dist/browser/pako.umd.min.js'],
  ['/vendor/beautifier/beautifier.min.js', 'node_modules/js-beautify/js/lib/beautifier.min.js'],
  ['/vendor/acorn/acorn.js', 'node_modules/acorn/dist/acorn.js'],
  ['/vendor/css-tree/csstree.js', 'node_modules/css-tree/dist/csstree.js'],
  ['/vendor/monaco/vs/loader.js', 'node_modules/monaco-editor/min/vs/loader.js']
]);

test('shipped vendor script sequence exposes codecs without contaminating the AMD loader', () => {
  const context = vm.createContext({ console, setTimeout, clearTimeout, TextEncoder, TextDecoder });
  vm.runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', context);
  const loaded = [];
  for (const [, url] of read('src/ui/index.html').matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)) {
    const file = vendorFiles.get(url);
    if (!file) continue;
    vm.runInContext(read(file), context, { filename: url });
    loaded.push(url);
  }
  assert.equal(loaded.length, vendorFiles.size);
  assert.equal(typeof context.pako?.Inflate, 'function');
  assert.equal(typeof context.protobuf?.parse, 'function');
  assert.equal(context.jsyaml.load('ready: true').ready, true);
  assert.equal(typeof context.beautifier?.js, 'function');
  assert.equal(typeof context.beautifier?.css, 'function');
  assert.equal(typeof context.acorn?.parse, 'function');
  assert.equal(typeof context.csstree?.parse, 'function');

  const payload = Buffer.from([0x08, 0x96, 0x01]);
  for (const encoded of [gzipSync(payload), deflateSync(payload)]) {
    const inflator = new context.pako.Inflate();
    inflator.push(encoded, true);
    assert.equal(inflator.err, 0);
    assert.deepEqual(Buffer.from(inflator.result), payload);
  }
  assert.equal(vm.runInContext(`protobuf.parse('syntax = "proto3"; message Value { int32 n = 1; }')
    .root.lookupType('Value').decode(Uint8Array.from([8, 150, 1])).n`, context), 150);

  let resolved;
  context.define('bootstrap-control', [], () => 'ready');
  context.require(['bootstrap-control'], value => { resolved = value; });
  assert.equal(resolved, 'ready');
});

const browser = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].find(candidate => fs.existsSync(candidate));

test('browser loads the shipped codec sequence without startup exceptions', {
  skip: browser ? false : 'Chrome/Chromium unavailable; set CHROME_PATH to run the browser check',
  timeout: 30000
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'freekit-vendor-bootstrap-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const scripts = [...read('src/ui/index.html').matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)]
    .filter(([, url]) => vendorFiles.has(url))
    .map(([, url]) => `<script src="${new URL(vendorFiles.get(url), root).href}"></script>`).join('\n');
  const payload = Buffer.from([8, 150, 1]);
  const compressed = [gzipSync(payload), deflateSync(payload)].map(bytes => Array.from(bytes));
  const html = `<!doctype html><body><pre id="result"></pre>
    <script>const errors = []; window.addEventListener('error', e => errors.push(e.message));</script>
    ${scripts}
    <script>
      const result = { errors, pako: typeof window.pako?.Inflate, protobuf: typeof window.protobuf?.parse };
      result.formatters = [typeof beautifier.js, typeof beautifier.css, typeof acorn.parse, typeof csstree.parse];
      try {
        result.decoded = ${JSON.stringify(compressed)}.map(bytes => {
          const inflator = new pako.Inflate(); inflator.push(Uint8Array.from(bytes), true);
          if (inflator.err) throw Error(inflator.msg);
          return Array.from(inflator.result);
        });
        define('bootstrap-control', [], () => 'ready');
        require(['bootstrap-control'], value => { result.amd = value; });
      } catch (error) { errors.push(error.message); }
      document.getElementById('result').textContent = encodeURIComponent(JSON.stringify(result));
    </script></body>`;
  const page = path.join(directory, 'index.html');
  fs.writeFileSync(page, html);
  const { stdout } = await promisify(execFile)(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', `--user-data-dir=${path.join(directory, 'profile')}`,
    '--dump-dom', pathToFileURL(page).href
  ], { windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  const encodedResult = stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
  assert.ok(encodedResult, 'browser must execute the final bootstrap check');
  assert.deepEqual(JSON.parse(decodeURIComponent(encodedResult)), {
    errors: [], pako: 'function', protobuf: 'function',
    formatters: ['function', 'function', 'function', 'function'],
    decoded: [[8, 150, 1], [8, 150, 1]], amd: 'ready'
  });
});
