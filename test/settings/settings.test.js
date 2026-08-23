import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Settings } from '../../src/settings.js';

test('falls back to empty settings when the settings file contains JSON null', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-settings-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), 'null');

  const settings = new Settings(dataDir);

  assert.equal(settings.get('missing', 'fallback'), 'fallback');
  assert.deepEqual(settings.getAll(), {});
  assert.throws(() => settings.set('theme', 'dark'), /cannot be saved.*could not be loaded/i);
  assert.throws(() => settings.setAll({ theme: 'light' }), /Repair or replace the settings file/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'), 'null');
});

test('malformed settings bytes are preserved until explicit recovery', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-settings-malformed-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const filePath = path.join(dataDir, 'settings.json');
  const malformed = '{"proxy":';
  fs.writeFileSync(filePath, malformed);

  const settings = new Settings(dataDir);
  assert.throws(() => settings.set('port', 9000), /settings\.json.*could not be loaded/i);
  assert.equal(fs.readFileSync(filePath, 'utf8'), malformed);
});
