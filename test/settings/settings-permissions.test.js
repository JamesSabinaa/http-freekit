import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Settings } from '../../src/settings.js';

function createSettingsFile(dataDir) {
  const filePath = path.join(dataDir, 'settings.json');
  fs.writeFileSync(filePath, JSON.stringify({ secret: 'persisted' }), { mode: 0o644 });
  fs.chmodSync(filePath, 0o644);
  return filePath;
}

test('validated existing settings are repaired to owner-only permissions', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-settings-mode-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const filePath = createSettingsFile(dataDir);
  const chmodSync = fs.chmodSync;
  const chmodCalls = [];
  t.mock.method(Settings.prototype, '_platform', () => 'linux');
  t.mock.method(fs, 'chmodSync', (targetPath, mode) => {
    chmodCalls.push([targetPath, mode]);
    return chmodSync(targetPath, mode);
  });

  const settings = new Settings(dataDir);

  assert.equal(settings.get('secret'), 'persisted');
  assert.deepEqual(chmodCalls, [[filePath, 0o600]]);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }
});

test('settings startup fails actionably when a validated file cannot be hardened', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-settings-denied-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const filePath = createSettingsFile(dataDir);
  const originalFile = fs.readFileSync(filePath, 'utf8');
  t.mock.method(Settings.prototype, '_platform', () => 'linux');
  t.mock.method(fs, 'chmodSync', (targetPath) => {
    assert.equal(targetPath, filePath);
    throw new Error('simulated permission denial');
  });

  assert.throws(
    () => new Settings(dataDir),
    error => {
      assert.match(error.message, /Could not secure existing settings file/);
      assert.match(error.message, /owner-only access/);
      assert.match(error.message, /simulated permission denial/);
      assert.match(error.message, /owned by the current user/);
      return true;
    }
  );
  assert.equal(fs.readFileSync(filePath, 'utf8'), originalFile);
});

test('Windows does not claim POSIX chmod hardening for existing settings', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-settings-windows-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  createSettingsFile(dataDir);
  t.mock.method(Settings.prototype, '_platform', () => 'win32');
  t.mock.method(fs, 'chmodSync', () => assert.fail('Windows must not use chmod as access hardening'));

  const settings = new Settings(dataDir);

  assert.equal(settings.get('secret'), 'persisted');
});
