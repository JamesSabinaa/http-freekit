'use strict';

function isUsableWindow(window) {
  return window && (typeof window.isDestroyed !== 'function' || !window.isDestroyed());
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

  window.on('minimize', hideInTray);
  window.on('close', handleClose);

  return () => {
    window.removeListener?.('minimize', hideInTray);
    window.removeListener?.('close', handleClose);
  };
}

module.exports = { installWindowToTray, showTrayWindow };
