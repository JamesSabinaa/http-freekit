import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installWindowToTray, showTrayWindow } = require('../electron/window-to-tray.cjs');

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.visible = true;
    this.minimized = false;
    this.hideCalls = 0;
    this.showCalls = 0;
    this.restoreCalls = 0;
    this.focusCalls = 0;
  }

  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  hide() { this.hideCalls += 1; this.visible = false; }
  show() { this.showCalls += 1; this.visible = true; }
  restore() { this.restoreCalls += 1; this.minimized = false; }
  focus() { this.focusCalls += 1; }
}

function cancellableEvent() {
  return {
    prevented: false,
    preventDefault() { this.prevented = true; }
  };
}

test('minimize and ordinary close hide the live window without ending its session', () => {
  const window = new FakeWindow();
  const remove = installWindowToTray(window);

  const minimize = cancellableEvent();
  window.emit('minimize', minimize);
  assert.equal(minimize.prevented, true);
  assert.equal(window.hideCalls, 1);

  window.visible = true;
  const close = cancellableEvent();
  window.emit('close', close);
  assert.equal(close.prevented, true);
  assert.equal(window.hideCalls, 2);

  remove();
  window.visible = true;
  const detached = cancellableEvent();
  window.emit('close', detached);
  assert.equal(detached.prevented, false);
  assert.equal(window.hideCalls, 2);
});

test('cleanup-approved Quit can close while tray restoration restores and focuses', () => {
  const window = new FakeWindow();
  let allowClose = false;
  installWindowToTray(window, { shouldAllowClose: () => allowClose });

  allowClose = true;
  const close = cancellableEvent();
  window.emit('close', close);
  assert.equal(close.prevented, false);
  assert.equal(window.hideCalls, 0);

  window.visible = false;
  window.minimized = true;
  assert.equal(showTrayWindow(window), true);
  assert.equal(window.restoreCalls, 1);
  assert.equal(window.showCalls, 1);
  assert.equal(window.focusCalls, 1);

  window.destroyed = true;
  assert.equal(showTrayWindow(window), false);
  assert.equal(window.focusCalls, 1);
});

test('Electron main and tray wire hide/restore to the cleanup-aware lifecycle', () => {
  const main = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const tray = fs.readFileSync(new URL('../electron/tray.cjs', import.meta.url), 'utf8');

  assert.match(main, /installWindowToTray\(mainWindow,\s*\{[\s\S]*shouldAllowClose:\s*\(\) => quitCleanupComplete/);
  assert.match(main, /function showMainWindow\(\)[\s\S]*showTrayWindow\(mainWindow\)/);
  assert.match(tray, /showTrayWindow\(mainWindow\)/);
  assert.match(main, /app\.on\('before-quit'[\s\S]*runQuitCleanup\(/);
});
