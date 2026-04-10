const { Tray, Menu, nativeImage, app } = require('electron');

let tray = null;

/**
 * Create a minimal 16x16 tray icon using nativeImage.
 * Draws a simple "H" letterform in the HTTP Toolkit blue (#4775e2).
 */
function createTrayIcon() {
  // 16x16 RGBA pixel buffer
  const size = 16;
  const buf = Buffer.alloc(size * size * 4, 0);

  function setPixel(x, y, r, g, b, a) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const offset = (y * size + x) * 4;
    buf[offset] = r;
    buf[offset + 1] = g;
    buf[offset + 2] = b;
    buf[offset + 3] = a;
  }

  // Draw "H" shape in #4775e2 (71, 117, 226) on transparent background
  const r = 71, g = 117, b = 226, a = 255;

  // Background circle
  const cx = 7.5, cy = 7.5, radius = 7.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) {
        setPixel(x, y, r, g, b, a);
      }
    }
  }

  // Draw "H" in white
  const wr = 255, wg = 255, wb = 255;
  // Left vertical bar (x=4-5, y=3-12)
  for (let y = 3; y <= 12; y++) {
    setPixel(4, y, wr, wg, wb, a);
    setPixel(5, y, wr, wg, wb, a);
  }
  // Right vertical bar (x=10-11, y=3-12)
  for (let y = 3; y <= 12; y++) {
    setPixel(10, y, wr, wg, wb, a);
    setPixel(11, y, wr, wg, wb, a);
  }
  // Horizontal bar (x=4-11, y=7-8)
  for (let x = 4; x <= 11; x++) {
    setPixel(x, 7, wr, wg, wb, a);
    setPixel(x, 8, wr, wg, wb, a);
  }

  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

/**
 * Create the system tray with a context menu.
 * @param {Electron.BrowserWindow} mainWindow
 */
function createTray(mainWindow) {
  const icon = createTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('HTTP FreeKit');

  function updateContextMenu() {
    const isVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
    const contextMenu = Menu.buildFromTemplate([
      {
        label: isVisible ? 'Hide Window' : 'Show Window',
        click: () => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          if (mainWindow.isVisible()) {
            mainWindow.hide();
          } else {
            mainWindow.show();
            mainWindow.focus();
          }
          updateContextMenu();
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.quit();
        }
      }
    ]);
    tray.setContextMenu(contextMenu);
  }

  updateContextMenu();

  // Update menu label when window visibility changes
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.on('show', updateContextMenu);
    mainWindow.on('hide', updateContextMenu);
  }

  // Double-click on tray icon shows the window
  tray.on('double-click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

/**
 * Destroy the tray icon.
 */
function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

module.exports = { createTray, destroyTray };
