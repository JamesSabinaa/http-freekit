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

  let pendingHide = null;
  const cancelPendingHide = () => {
    if (pendingHide === null) return;
    clearImmediate(pendingHide);
    pendingHide = null;
  };
  const hideAfterNativeTransition = () => {
    if (pendingHide !== null) return;
    // Windows is still dispatching the native minimize/close transition while
    // these Electron events run. Hiding synchronously can strand Chromium's
    // input routing even though the restored window continues to paint.
    pendingHide = setImmediate(() => {
      pendingHide = null;
      if (!isUsableWindow(window)) return;
      window.hide();
    });
  };

  const handleClose = event => {
    if (shouldAllowClose()) {
      cancelPendingHide();
      return;
    }
    event?.preventDefault?.();
    if (shouldQuitOnClose()) {
      cancelPendingHide();
      onQuitRequested();
      return;
    }
    hideAfterNativeTransition();
  };
  const handleFocus = () => focusWindowContents(window);

  window.on('close', handleClose);
  window.on('focus', handleFocus);

  return () => {
    cancelPendingHide();
    window.removeListener?.('close', handleClose);
    window.removeListener?.('focus', handleFocus);
  };
}

module.exports = { installWindowToTray, showTrayWindow };
