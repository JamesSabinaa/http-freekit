'use strict';

function isUsableWindow(window) {
  return window && (typeof window.isDestroyed !== 'function' || !window.isDestroyed());
}

function focusWindowContents(window) {
  const contents = window.webContents;
  if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) return;
  contents.focus?.();
}

function showTrayWindow(window) {
  if (!isUsableWindow(window)) return false;
  if (typeof window.isMinimized === 'function' && window.isMinimized()) {
    window.restore();
  }
  if (typeof window.isVisible !== 'function' || !window.isVisible()) {
    window.show();
  }
  window.focus();
  focusWindowContents(window);
  return true;
}

function installWindowToTray(window, {
  shouldAllowClose = () => false,
  shouldQuitOnClose = () => false,
  onQuitRequested = () => {}
} = {}) {
  if (!isUsableWindow(window) || typeof window.on !== 'function') {
    throw new TypeError('A live BrowserWindow is required');
  }

  const hideInTray = event => {
    event?.preventDefault?.();
    if (isUsableWindow(window)) window.hide();
  };

  const handleClose = event => {
    if (shouldAllowClose()) return;
    event?.preventDefault?.();
    if (shouldQuitOnClose()) {
      onQuitRequested();
      return;
    }
    if (isUsableWindow(window)) window.hide();
  };
  const handleFocus = () => focusWindowContents(window);

  window.on('minimize', hideInTray);
  window.on('close', handleClose);
  window.on('focus', handleFocus);

  return () => {
    window.removeListener?.('minimize', hideInTray);
    window.removeListener?.('close', handleClose);
    window.removeListener?.('focus', handleFocus);
  };
}

module.exports = { installWindowToTray, showTrayWindow };
