'use strict';

const UNSAVED_CHANGES_DIALOG = Object.freeze({
  type: 'warning',
  title: 'Unsaved Changes',
  message: 'Leave without saving?',
  detail: 'HTTP FreeKit has unsaved work. Leaving now will discard those changes.',
  buttons: ['Leave', 'Stay'],
  defaultId: 1,
  cancelId: 1,
  noLink: true
});

function installUnloadConfirmation(mainWindow, {
  dialog,
  shouldAllowPreparedUnload = () => false,
  logger = console
} = {}) {
  const webContents = mainWindow?.webContents;
  if (!webContents?.on || typeof dialog?.showMessageBoxSync !== 'function') return false;

  webContents.on('will-prevent-unload', (event) => {
    if (shouldAllowPreparedUnload()) {
      // Electron reverses the usual meaning here: preventing this event tells
      // Chromium to ignore the renderer's beforeunload cancellation and leave.
      event.preventDefault();
      return;
    }

    try {
      const response = dialog.showMessageBoxSync(mainWindow, UNSAVED_CHANGES_DIALOG);
      if (response === 0) event.preventDefault();
    } catch (error) {
      // Fail closed. Without preventDefault(), Electron keeps the current page.
      logger.error('[Electron] Could not show the unsaved-changes dialog:', error.message);
    }
  });
  return true;
}

module.exports = {
  UNSAVED_CHANGES_DIALOG,
  installUnloadConfirmation
};
