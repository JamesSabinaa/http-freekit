import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Settings } from '../src/settings.js';

test('falls back to empty settings when the settings file contains JSON null', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-settings-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), 'null');

  const settings = new Settings(dataDir);

  assert.equal(settings.get('missing', 'fallback'), 'fallback');
  assert.deepEqual(settings.getAll(), {});
});
