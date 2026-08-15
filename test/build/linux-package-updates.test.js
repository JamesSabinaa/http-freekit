import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { shouldForceLinuxUpdateChecks } = require('../../electron/update-platform.cjs');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('packaged DEB and RPM apps bypass AppImage-only update activation', () => {
  assert.equal(shouldForceLinuxUpdateChecks('linux', true, {}), true);
  assert.equal(shouldForceLinuxUpdateChecks('linux', true, { APPIMAGE: '/tmp/app.AppImage' }), false);
  assert.equal(shouldForceLinuxUpdateChecks('linux', true, { SNAP: '/snap/app' }), false);
  assert.equal(shouldForceLinuxUpdateChecks('linux', false, {}), false);
  assert.equal(shouldForceLinuxUpdateChecks('darwin', true, {}), false);
});

test('Linux package activation enables checks while downloads remain disabled', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'electron/updater.cjs'), 'utf8');
  assert.match(source, /autoUpdater\.autoDownload = false/);
  assert.match(source, /autoUpdater\.forceDevUpdateConfig = true/);
  assert.match(source, /shouldForceLinuxUpdateChecks\(process\.platform, app\.isPackaged, process\.env\)/);
});

test('README distinguishes managed desktop updates from the manual Linux flow', () => {
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const updateClaim = readme.split('\n').find(line => line.includes('**Auto-updates**')) || '';

  assert.match(updateClaim, /Windows and macOS can download an approved update in the background/);
  assert.match(updateClaim, /install it after you choose to restart/);
  assert.match(updateClaim, /Linux \(including AppImage, `\.deb`, and `\.rpm`\) opens the release page for a manual download and install/);
});
