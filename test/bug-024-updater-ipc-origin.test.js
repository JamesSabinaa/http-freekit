import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('updater IPC handlers validate the invoking renderer', () => {
  const updater = fs.readFileSync(path.join(repoRoot, 'electron/updater.cjs'), 'utf8');
  const main = fs.readFileSync(path.join(repoRoot, 'electron/main.cjs'), 'utf8');

  assert.match(main, /initAutoUpdater\(mainWindow,\s*\{\s*validateSender,/);
  assert.match(
    updater,
    /ipcMain\.handle\('updater-check-now', \(event\) => \{\s*if \(!validateIpcSender\(event\)\) return null;/
  );
  assert.match(
    updater,
    /ipcMain\.handle\('updater-install', async \(event\) => \{\s*if \(!validateIpcSender\(event\)\) return null;/
  );
});
