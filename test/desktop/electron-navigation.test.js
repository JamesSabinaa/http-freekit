import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { isSafeExternalUrl } = require('../../electron/security.cjs');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Electron only hands safe HTTP links to the external browser', () => {
  assert.equal(isSafeExternalUrl('https://example.com/download'), true);
  assert.equal(isSafeExternalUrl('http://example.com/'), true);
  assert.equal(isSafeExternalUrl('file:///etc/passwd'), false);
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
  assert.equal(isSafeExternalUrl('https://user@example.com/'), false);
  assert.equal(isSafeExternalUrl('not a URL'), false);
});

test('privileged Electron window denies popups and blocks off-origin navigation', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'electron/main.cjs'), 'utf8');
  assert.match(source, /webContents\.on\('will-navigate'/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /webContents\.setWindowOpenHandler/);
  assert.match(source, /return \{ action: 'deny' \}/);
});
