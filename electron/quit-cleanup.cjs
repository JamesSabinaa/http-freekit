'use strict';

const PREPARE_RENDERER_FOR_QUIT_SCRIPT = `(() => {
  const prepare = globalThis.prepareRendererForQuit ||
    globalThis.prepareSendTabPersistenceForQuit;
  return typeof prepare === 'function' && prepare() === true;
})()`;

async function prepareRendererForQuit(mainWindow, logger = console) {
  if (!mainWindow || mainWindow.isDestroyed?.()) return true;
  const webContents = mainWindow.webContents;
  if (!webContents || webContents.isDestroyed?.()) return true;

  try {
    return await webContents.executeJavaScript(PREPARE_RENDERER_FOR_QUIT_SCRIPT, true) === true;
  } catch (error) {
    logger.error('[Electron] Could not prepare renderer persistence for Quit:', error.message);
    return false;
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
  logger = console
}) {
  const prepared = await prepare(mainWindow, logger);
  if (!prepared) return false;

  try {
    onPrepared?.();
    if (mainWindow && !mainWindow.isDestroyed?.()) mainWindow.destroy();
  } catch (error) {
    logger.error('[Electron] Could not close the prepared renderer:', error.message);
    return false;
  }

  try {
    relaunch?.();
  } catch (error) {
    logger.error('[Electron] Could not schedule application relaunch:', error.message);
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
  }
  return true;
}

module.exports = {
  PREPARE_RENDERER_FOR_QUIT_SCRIPT,
  prepareRendererForQuit,
  runQuitCleanup
};
