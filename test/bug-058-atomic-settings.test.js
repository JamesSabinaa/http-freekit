import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Settings } from '../src/settings.js';

test('failed atomic replacement preserves the previous settings file', { concurrency: false }, (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-atomic-settings-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const settingsPath = path.join(dataDir, 'settings.json');
  const settings = new Settings(dataDir);
  settings.set('mode', 'saved');
  const originalFile = fs.readFileSync(settingsPath, 'utf8');

  const originalRenameSync = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated interrupted replacement'); };
  t.after(() => { fs.renameSync = originalRenameSync; });

  assert.throws(() => settings.set('mode', 'unsaved'), /simulated interrupted replacement/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), originalFile);
  assert.equal(settings.get('mode'), 'saved');
  assert.deepEqual(
    fs.readdirSync(dataDir).filter(name => name.endsWith('.tmp')),
    []
  );
});
