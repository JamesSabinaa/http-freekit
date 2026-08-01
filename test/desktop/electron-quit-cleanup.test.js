import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.cjs'), 'utf8');

test('every Electron quit path is gated by child-server cleanup', () => {
  const start = source.indexOf("app.on('before-quit'");
  const end = source.indexOf('app.whenReady()', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = source.slice(start, end);

  assert.match(handler, /event\.preventDefault\(\)/);
  assert.match(handler, /runQuitCleanup\(\{[\s\S]*stopAutoUpdater,[\s\S]*destroyTray,[\s\S]*shutdownServer/);
  assert.match(handler, /if \(shouldQuit\) \{[\s\S]*quitCleanupComplete = true;[\s\S]*app\.quit\(\)/);
  assert.match(handler, /isShuttingDown = false;[\s\S]*relaunchRequested = false;[\s\S]*showMainWindow\(\)/);
});

test('renderer restart uses the cleanup-aware quit path', () => {
  const start = source.indexOf("ipcMain.handle('restart-app'");
  const end = source.indexOf("app.on('second-instance'", start);
  const handler = source.slice(start, end);

  assert.match(handler, /relaunchRequested = true;[\s\S]*app\.quit\(\)/);
  assert.doesNotMatch(handler, /app\.relaunch\(/);
  assert.match(source, /relaunch: relaunchRequested \? \(\) => app\.relaunch\(\) : null/);
  assert.doesNotMatch(handler, /app\.exit\(/);
});
