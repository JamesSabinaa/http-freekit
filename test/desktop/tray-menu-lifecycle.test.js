import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');

class FakeTray extends EventEmitter {
  static instance = null;

  constructor() {
    super();
    this.contextMenus = [];
    this.destroyed = false;
    FakeTray.instance = this;
  }

  setToolTip() {}
  setContextMenu(menu) {
    this.contextMenus.push(menu);
    this.contextMenu = menu;
  }
  destroy() { this.destroyed = true; }
}

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.visible = true;
    this.hideCalls = 0;
    this.showCalls = 0;
    this.focusCalls = 0;
    this.webContentsFocusCalls = 0;
    this.webContents = {
      isDestroyed: () => false,
      focus: () => { this.webContentsFocusCalls++; }
    };
  }

  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return false; }
  hide() {
    this.hideCalls++;
    this.visible = false;
    this.emit('hide');
  }
  show() {
    this.showCalls++;
    this.visible = true;
    this.emit('show');
  }
  focus() { this.focusCalls++; }
}

function nextImmediate() {
  return new Promise(resolve => setImmediate(resolve));
}

function menuAction(tray) {
  return tray.contextMenu.template[0];
}

test('tray window toggles wait for the native menu callback to unwind', async () => {
  const electron = {
    Tray: FakeTray,
    Menu: { buildFromTemplate: template => ({ template }) },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => false, resize() { return this; } }),
      createFromBuffer: () => ({})
    },
    app: { quit() {} }
  };
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = require.resolve('../../electron/tray.cjs');
  delete require.cache[modulePath];
  let trayModule;
  try {
    trayModule = require(modulePath);
  } finally {
    Module._load = originalLoad;
  }

  try {
    const window = new FakeWindow();
    trayModule.createTray(window);
    const tray = FakeTray.instance;

    assert.equal(menuAction(tray).label, 'Hide Window');
    menuAction(tray).click();

    assert.equal(window.hideCalls, 0, 'the click callback must not hide synchronously');
    assert.equal(tray.contextMenus.length, 1, 'the active native menu must not be replaced');

    await nextImmediate();
    assert.equal(window.hideCalls, 1);
    assert.equal(menuAction(tray).label, 'Show Window');
    assert.equal(tray.contextMenus.length, 2);

    menuAction(tray).click();
    assert.equal(window.showCalls, 0, 'the click callback must not show synchronously');
    assert.equal(tray.contextMenus.length, 2, 'the active native menu must remain installed');

    await nextImmediate();
    assert.equal(window.showCalls, 1);
    assert.equal(window.focusCalls, 1);
    assert.equal(window.webContentsFocusCalls, 1);
    assert.equal(menuAction(tray).label, 'Hide Window');
    assert.equal(tray.contextMenus.length, 3);
  } finally {
    trayModule.destroyTray();
    delete require.cache[modulePath];
  }
});
