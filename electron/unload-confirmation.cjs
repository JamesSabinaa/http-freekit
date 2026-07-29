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
  shouldAllowUnload = () => false,
  onUnloadCanceled = () => {},
  logger = console
} = {}) {
  const webContents = mainWindow?.webContents;
  if (!webContents?.on || typeof dialog?.showMessageBoxSync !== 'function') return false;

  function notifyUnloadCanceled() {
    try {
      onUnloadCanceled();
    } catch (error) {
      logger.error('[Electron] Could not cancel the pending unload:', error.message);
    }
  }

  webContents.on('will-prevent-unload', (event) => {
    try {
      if (shouldAllowUnload()) {
        event.preventDefault();
        return;
      }
    } catch (error) {
      logger.error('[Electron] Could not inspect the pending unload:', error.message);
    }

    try {
      const response = dialog.showMessageBoxSync(mainWindow, UNSAVED_CHANGES_DIALOG);
      // Electron reverses the usual meaning here: preventing this event tells
      // Chromium to ignore the renderer's beforeunload cancellation and leave.
      if (response === 0) {
        event.preventDefault();
      } else {
        notifyUnloadCanceled();
      }
    } catch (error) {
      // Fail closed. Without preventDefault(), Electron keeps the current page.
      logger.error('[Electron] Could not show the unsaved-changes dialog:', error.message);
      notifyUnloadCanceled();
    }
  });
  return true;
}

module.exports = {
  UNSAVED_CHANGES_DIALOG,
  installUnloadConfirmation
};
