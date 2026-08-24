'use strict';

const DEFAULT_RENDERER_PREPARE_TIMEOUT_MS = 5_000;
const RENDERER_PREPARE_TIMED_OUT = Symbol('renderer-prepare-timed-out');
const RENDERER_PREPARE_UNAVAILABLE = 'http-freekit:renderer-prepare-unavailable';

const PREPARE_RENDERER_FOR_QUIT_SCRIPT = `(() => {
  const prepare = globalThis.prepareRendererForQuit ||
    globalThis.prepareSendTabPersistenceForQuit;
  if (typeof prepare !== 'function') return ${JSON.stringify(RENDERER_PREPARE_UNAVAILABLE)};
  return prepare() === true;
})()`;

async function prepareRendererForQuit(mainWindow, logger = console, {
  timeoutMs = DEFAULT_RENDERER_PREPARE_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  if (!mainWindow || mainWindow.isDestroyed?.()) return true;
  const webContents = mainWindow.webContents;
  if (!webContents || webContents.isDestroyed?.()) return true;

  let timeout = null;
  try {
    const execution = webContents.executeJavaScript(PREPARE_RENDERER_FOR_QUIT_SCRIPT, true);
    const result = await Promise.race([
      execution,
      new Promise(resolve => {
        timeout = setTimeoutFn(() => resolve(RENDERER_PREPARE_TIMED_OUT), timeoutMs);
      })
    ]);
    if (result === RENDERER_PREPARE_TIMED_OUT) {
      // A renderer that cannot answer must not prevent interceptor and proxy
      // restoration. The backend starts its own deadline after this preflight.
      logger.error(
        `[Electron] Renderer Quit preparation did not complete within ${timeoutMs}ms; continuing cleanup.`
      );
      return true;
    }
    if (result === RENDERER_PREPARE_UNAVAILABLE) {
      logger.error(
        '[Electron] Renderer Quit preparation helper is unavailable; continuing cleanup.'
      );
      return true;
    }
    return result === true;
  } catch (error) {
    logger.error(
      '[Electron] Could not prepare renderer persistence for Quit; continuing cleanup:',
      error?.message || String(error)
    );
    return true;
  } finally {
    if (timeout !== null) clearTimeoutFn(timeout);
  }
}

async function runQuitCleanup({
  mainWindow,
  prepare = prepareRendererForQuit,
  onPrepared,
  relaunch,
  stopAutoUpdater,
  destroyTray,
  shutdownServer,
  rendererPrepareTimeoutMs = DEFAULT_RENDERER_PREPARE_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console
}) {
  const prepared = await prepare(mainWindow, logger, {
    timeoutMs: rendererPrepareTimeoutMs,
    setTimeoutFn,
    clearTimeoutFn
  });
  if (!prepared) return false;

  try {
    onPrepared?.();
    if (mainWindow && !mainWindow.isDestroyed?.()) mainWindow.destroy();
  } catch (error) {
    logger.error('[Electron] Could not close the prepared renderer:', error.message);
    return false;
  }

  try {
    stopAutoUpdater?.();
  } catch (error) {
    logger.error('[Electron] Auto-updater shutdown failed:', error.message);
  }
  try {
    destroyTray?.();
  } catch (error) {
    logger.error('[Electron] Tray shutdown failed:', error.message);
  }
  try {
    await shutdownServer?.();
  } catch (error) {
    logger.error('[Electron] Server shutdown failed:', error.message);
    throw error;
  }
  try {
    relaunch?.();
  } catch (error) {
    logger.error('[Electron] Could not schedule application relaunch:', error.message);
  }
  return true;
}

module.exports = {
  DEFAULT_RENDERER_PREPARE_TIMEOUT_MS,
  PREPARE_RENDERER_FOR_QUIT_SCRIPT,
  RENDERER_PREPARE_UNAVAILABLE,
  prepareRendererForQuit,
  runQuitCleanup
};
