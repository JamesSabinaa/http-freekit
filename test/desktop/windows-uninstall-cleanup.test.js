import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  cleanupWindowsInstallation,
  collectOwnedCaFingerprints
} from '../../src/windows-uninstall-cleanup.js';

function createDataDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-uninstall-'));
  const dataDir = path.join(root, 'http-freekit', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return dataDir;
}

test('Windows uninstall removes every exact owned fingerprint before deleting the private data', t => {
  const dataDir = createDataDirectory(t);
  const activeFingerprint = 'AB'.repeat(20);
  const replacedFingerprint = 'CD'.repeat(20);
  const migratedFingerprint = '12'.repeat(20);
  fs.writeFileSync(path.join(dataDir, 'ca.key'), 'private-key-evidence');
  fs.writeFileSync(path.join(dataDir, 'ca-active.json'), JSON.stringify({
    version: 1,
    fingerprint: activeFingerprint
  }));
  fs.writeFileSync(path.join(dataDir, 'ca-replacements.json'), JSON.stringify({
    version: 2,
    fingerprints: [replacedFingerprint]
  }));
  fs.writeFileSync(path.join(dataDir, 'ca-migration.json'), JSON.stringify({
    version: 1,
    previousFingerprint: migratedFingerprint
  }));
  const calls = [];

  const result = cleanupWindowsInstallation(dataDir, {
    platform: 'win32',
    run(executable, args) { calls.push({ executable, args }); }
  });

  assert.deepEqual(result.fingerprints, [activeFingerprint, replacedFingerprint, migratedFingerprint]);
  assert.deepEqual(calls.map(call => call.args), [
    ['-delstore', '-user', 'Root', activeFingerprint],
    ['-delstore', '-user', 'Root', replacedFingerprint],
    ['-delstore', '-user', 'Root', migratedFingerprint]
  ]);
  assert.equal(fs.existsSync(dataDir), false);
});

test('failed trust removal preserves the private data for recovery', t => {
  const dataDir = createDataDirectory(t);
  const activeFingerprint = 'EF'.repeat(20);
  fs.writeFileSync(path.join(dataDir, 'ca.key'), 'private-key-evidence');
  fs.writeFileSync(path.join(dataDir, 'ca-active.json'), JSON.stringify({
    version: 1,
    fingerprint: activeFingerprint
  }));

  assert.throws(() => cleanupWindowsInstallation(dataDir, {
    platform: 'win32',
    run() { throw new Error('simulated certificate-store failure'); }
  }), /Could not remove 1 trusted CA certificate/);
  assert.equal(fs.existsSync(path.join(dataDir, 'ca.key')), true);
});

test('uninstall cleanup rejects broad paths and malformed ownership journals', t => {
  const dataDir = createDataDirectory(t);
  fs.writeFileSync(path.join(dataDir, 'ca-active.json'), '{not-json');

  assert.throws(() => collectOwnedCaFingerprints(dataDir), SyntaxError);
  assert.throws(
    () => cleanupWindowsInstallation(path.dirname(dataDir), { platform: 'win32' }),
    /unexpected data directory/
  );
});

test('NSIS runs cleanup only for a true uninstall and retains updater replacements', () => {
  const config = fs.readFileSync('electron-builder.config.cjs', 'utf8');
  const include = fs.readFileSync('build/installer.nsh', 'utf8');

  assert.match(config, /include:\s*['"]build\/installer\.nsh['"]/);
  assert.match(include, /\$\{ifNot\}\s+\$\{isUpdated\}/);
  assert.match(include, /windows-uninstall-cleanup\.js/);
  assert.match(include, /\$APPDATA\\http-freekit\\data/);
});
