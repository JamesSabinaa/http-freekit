import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { isHarTarget, loadHarTarget } = require('../../electron/har-deep-link.cjs');
const { parseOpenDeepLink } = require('../../electron/deep-link.cjs');

test('recognizes remote and local HAR targets by URL path', () => {
  assert.equal(isHarTarget('https://example.test/capture.har?download=1'), true);
  assert.equal(isHarTarget('https://example.test/CAPTURE.HAR#traffic'), true);
  assert.equal(isHarTarget('file:///C:/captures/session.har'), true);
  assert.equal(isHarTarget('https://example.test/capture.har.json'), false);
  assert.equal(isHarTarget('not a URL'), false);
});

test('deep links accept local HAR files but reject other local file URLs', () => {
  const harTarget = 'file:///C:/captures/session.har';
  assert.equal(
    parseOpenDeepLink(`http-freekit://open?url=${encodeURIComponent(harTarget)}`),
    harTarget
  );
  assert.throws(
    () => parseOpenDeepLink(
      `http-freekit://open?url=${encodeURIComponent('file:///C:/captures/session.json')}`
    ),
    /Only HTTP, HTTPS, and \.har file URLs/
  );
});

test('loads a local HAR file and enforces the import size limit', async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'http-freekit-har-link-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, 'capture.har');
  const contents = '{"log":{"entries":[]}}';
  await fs.writeFile(filePath, contents);

  const target = pathToFileURL(filePath).href;
  assert.equal((await loadHarTarget(target)).toString('utf8'), contents);
  await assert.rejects(loadHarTarget(target, { maxBytes: 5 }), /5 bytes or smaller/);
});

test('downloads a remote HAR and rejects oversized responses', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response('{"log":{"entries":[]}}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  const target = 'https://example.test/capture.har?download=1';
  assert.equal(
    (await loadHarTarget(target, { fetchImpl })).toString('utf8'),
    '{"log":{"entries":[]}}'
  );
  assert.equal(calls[0].url, target);
  assert.equal(calls[0].options.redirect, 'follow');
  assert.ok(calls[0].options.signal instanceof AbortSignal);

  await assert.rejects(
    loadHarTarget(target, {
      maxBytes: 5,
      fetchImpl: async () => new Response('oversized', {
        status: 200,
        headers: { 'content-length': '9' }
      })
    }),
    /5 bytes or smaller/
  );
});

test('reports unsuccessful HAR downloads without importing their bodies', async () => {
  await assert.rejects(
    loadHarTarget('https://example.test/missing.har', {
      fetchImpl: async () => new Response('missing', { status: 404 })
    }),
    /HAR download returned HTTP 404/
  );
});
