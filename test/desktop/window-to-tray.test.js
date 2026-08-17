import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installWindowToTray, showTrayWindow } = require('../../electron/window-to-tray.cjs');

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
    this.webContentsFocusCalls = 0;
    this.webContentsDestroyed = false;
    this.focusOrder = [];
    this.webContents = {
      isDestroyed: () => this.webContentsDestroyed,
      focus: () => {
        this.webContentsFocusCalls += 1;
        this.focusOrder.push('contents');
      }
    };
  }

  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  hide() { this.hideCalls += 1; this.visible = false; }
  show() { this.showCalls += 1; this.visible = true; }
  restore() { this.restoreCalls += 1; this.minimized = false; }
  focus() {
    this.focusCalls += 1;
    this.focusOrder.push('window');
  }
}

function cancellableEvent() {
  return {
    prevented: false,
    preventDefault() { this.prevented = true; }
  };
}

test('minimize and ordinary close hide only after the native transition finishes', async () => {
  const window = new FakeWindow();
  const remove = installWindowToTray(window);

  const minimize = cancellableEvent();
  window.minimized = true;
  window.emit('minimize', minimize);
  assert.equal(minimize.prevented, true);
  assert.equal(window.hideCalls, 0, 'minimize must not hide during native event dispatch');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(window.restoreCalls, 1, 'the native minimized state must be cleared before hiding');
  assert.equal(window.minimized, false);
  assert.equal(window.hideCalls, 1);

  window.visible = true;
  const close = cancellableEvent();
  window.emit('close', close);
  assert.equal(close.prevented, true);
  assert.equal(window.hideCalls, 1, 'close must not hide during native event dispatch');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(window.hideCalls, 2);

  remove();
  window.visible = true;
  const detached = cancellableEvent();
  window.emit('close', detached);
  assert.equal(detached.prevented, false);
  assert.equal(window.hideCalls, 2);
});

test('prepared updater or cleanup-approved Quit can close while tray restoration restores and focuses', () => {
  const window = new FakeWindow();
  let updatePrepared = false;
  let cleanupComplete = false;
  installWindowToTray(window, {
    shouldAllowClose: () => updatePrepared || cleanupComplete
  });

  updatePrepared = true;
  const close = cancellableEvent();
  window.emit('close', close);
  assert.equal(close.prevented, false);
  assert.equal(window.hideCalls, 0);

  updatePrepared = false;
  cleanupComplete = true;
  const finalClose = cancellableEvent();
  window.emit('close', finalClose);
  assert.equal(finalClose.prevented, false);
  assert.equal(window.hideCalls, 0);

  window.visible = false;
  window.minimized = true;
  assert.equal(showTrayWindow(window), true);
  assert.equal(window.restoreCalls, 1);
  assert.equal(window.showCalls, 1);
  assert.equal(window.focusCalls, 1);
  assert.equal(window.webContentsFocusCalls, 1);
  assert.deepEqual(window.focusOrder, ['window', 'contents']);

  window.destroyed = true;
  assert.equal(showTrayWindow(window), false);
  assert.equal(window.focusCalls, 1);
  assert.equal(window.webContentsFocusCalls, 1);
});

test('tray restoration skips page focus after the renderer is destroyed', () => {
  const window = new FakeWindow();
  window.webContentsDestroyed = true;

  assert.equal(showTrayWindow(window), true);
  assert.equal(window.focusCalls, 1);
  assert.equal(window.webContentsFocusCalls, 0);
  assert.deepEqual(window.focusOrder, ['window']);
});

test('delayed native focus after tray restoration refocuses the renderer', () => {
  const window = new FakeWindow();
  const remove = installWindowToTray(window);

  window.emit('focus');
  assert.equal(window.webContentsFocusCalls, 1);

  window.webContentsDestroyed = true;
  window.emit('focus');
  assert.equal(window.webContentsFocusCalls, 1);

  window.webContentsDestroyed = false;
  remove();
  window.emit('focus');
  assert.equal(window.webContentsFocusCalls, 1);
});

test('the close button requests a full quit when configured while minimize still hides', async () => {
  const window = new FakeWindow();
  let quitCalls = 0;
  installWindowToTray(window, {
    shouldQuitOnClose: () => true,
    onQuitRequested: () => { quitCalls++; }
  });

  const minimize = cancellableEvent();
  window.minimized = true;
  window.emit('minimize', minimize);
  assert.equal(minimize.prevented, true);
  assert.equal(window.hideCalls, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(window.restoreCalls, 1);
  assert.equal(window.hideCalls, 1);
  assert.equal(quitCalls, 0);

  window.visible = true;
  const close = cancellableEvent();
  window.emit('close', close);
  assert.equal(close.prevented, true);
  assert.equal(window.hideCalls, 1);
  assert.equal(quitCalls, 1);
});

test('Electron main and tray wire hide/restore to the cleanup-aware lifecycle', () => {
  const main = fs.readFileSync(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
  const tray = fs.readFileSync(new URL('../../electron/tray.cjs', import.meta.url), 'utf8');
  const styles = fs.readFileSync(new URL('../../src/ui/styles.css', import.meta.url), 'utf8');

  assert.match(main, /installWindowToTray\(mainWindow,\s*\{[\s\S]*shouldAllowClose:\s*\(\) => quitCleanupComplete \|\| updateInstallPrepared/);
  assert.match(main, /shouldQuitOnClose:\s*\(\) => getCloseWindowBehavior\(\) === CLOSE_WINDOW_BEHAVIORS\.QUIT/);
  assert.match(main, /onQuitRequested:\s*\(\) => app\.quit\(\)/);
  assert.match(main, /webPreferences:\s*\{[\s\S]*backgroundThrottling:\s*false/);
  assert.match(main, /function showMainWindow\(\)[\s\S]*showTrayWindow\(mainWindow\)/);
  assert.match(tray, /showTrayWindow\(mainWindow\)/);
  assert.match(main, /app\.on\('before-quit'[\s\S]*runQuitCleanup\(/);
  assert.match(main, /useWaylandWindowControlsOverlay[\s\S]*titleBarStyle:\s*'hidden'[\s\S]*titleBarOverlay:/);
  assert.match(styles, /body::before[\s\S]*env\(titlebar-area-height, 0px\)[\s\S]*-webkit-app-region:\s*drag/);
  assert.match(styles, /height:\s*calc\(100vh - env\(titlebar-area-height, 0px\)\)/);
});
