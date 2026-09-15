'use strict';

// Keep the window and updater IPC alive until backend cleanup is confirmed.
// The native installer is irreversible on some platforms, so before-quit is
// too late to discover that interception state could not be restored.
function createUpdateInstallPreparation({
  prepareRenderer,
  shutdownServer,
  restoreBackend,
  setBusy,
  onPrepared
}) {
  let preparation = null;
  let recovery = null;

  const recover = () => {
    if (recovery) return recovery;
    recovery = (async () => {
      if (preparation) await preparation.catch(() => {});
      onPrepared(false);
      try {
        await restoreBackend();
      } finally {
        setBusy(false);
      }
    })().finally(() => { recovery = null; });
    return recovery;
  };

  const prepare = async () => {
    if (recovery) await recovery;
    if (preparation) return preparation;
    preparation = (async () => {
      onPrepared(false);
      if (!await prepareRenderer()) return false;
      setBusy(true);
      try {
        const result = await shutdownServer();
        if (!result?.cleanupComplete) {
          throw new Error('Backend exited without confirming managed interceptor cleanup. Installation was not started.');
        }
        onPrepared(true);
        return true;
      } catch (error) {
        // Shutdown can fail with the backend still running, or after it exits.
        // Restore only a missing backend; never spawn a competing instance.
        try {
          await restoreBackend();
        } catch (restoreError) {
          throw new Error(`${error.message} Backend recovery failed: ${restoreError.message}`, { cause: error });
        } finally {
          setBusy(false);
        }
        throw error;
      }
    })().finally(() => { preparation = null; });
    return preparation;
  };

  return { prepare, recover, get busy() { return !!(preparation || recovery); } };
}

module.exports = { createUpdateInstallPreparation };
