const { autoUpdater } = require('electron-updater');
const { app, dialog, ipcMain, shell } = require('electron');

/**
 * Auto-update module for HTTP FreeKit.
 *
 * - Windows/macOS: downloads and installs updates via electron-updater (NSIS / DMG).
 * - Linux: checks GitHub releases and notifies the renderer to show a download link.
 * - Update feed URL is configurable via the UPDATE_URL environment variable.
 *
 * The module communicates with the renderer through IPC events prefixed with
 * 'updater-'. The renderer listens on the 'updater-status' channel for
 * status objects: { status, version?, url?, error? }.
 */

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
let mainWindow = null;
let checkInterval = null;
let currentCheckIsManual = false;
let isDownloading = false;
let updatePromptOpen = false;
let lastPromptedVersion = null;
let validateIpcSender = () => false;

/**
 * Send an updater status event to the renderer.
 */
function sendStatus(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater-status', data);
  }
}

function checkForUpdates(manual = false) {
  currentCheckIsManual = manual;
  return autoUpdater.checkForUpdates().catch((err) => {
    const wasManual = currentCheckIsManual;
    currentCheckIsManual = false;
    sendStatus({ status: 'error', error: err.message, manual: wasManual });
    return null;
  });
}

async function promptForUpdate(info, options = {}) {
  const version = info.version;
  const manual = Boolean(options.manual);

  if (isDownloading || updatePromptOpen) return;
  if (!manual && lastPromptedVersion === version) return;

  lastPromptedVersion = version;
  updatePromptOpen = true;

  try {
    if (process.platform === 'linux') {
      const url = options.url || getGitHubReleasesUrl(info);
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Available',
        message: `HTTP FreeKit ${version} is available`,
        detail: `You are running ${app.getVersion()}.\n\nDownload the latest Linux package from GitHub Releases.`,
        buttons: ['Open Download Page', 'Later'],
        defaultId: 0,
        cancelId: 1
      });
      if (result.response === 0) {
        shell.openExternal(url);
      } else {
        sendStatus({ status: 'update-dismissed', version, manual });
      }
      return;
    }

    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Available',
      message: `HTTP FreeKit ${version} is available`,
      detail: `You are running ${app.getVersion()}.\n\nDownload the update now? It will be installed after it downloads and you choose to restart.`,
      buttons: ['Download Update', 'Later'],
      defaultId: 0,
      cancelId: 1
    });

    if (result.response !== 0) {
      sendStatus({ status: 'update-dismissed', version, manual });
      return;
    }

    isDownloading = true;
    sendStatus({ status: 'download-started', version, manual });
    await autoUpdater.downloadUpdate();
  } catch (err) {
    sendStatus({ status: 'error', error: err.message, manual });
  } finally {
    updatePromptOpen = false;
  }
}

/**
 * Configure and start the auto-update system.
 * @param {Electron.BrowserWindow} win - The main application window
 * @param {{validateSender?: function}} options - IPC sender validation
 */
function initAutoUpdater(win, options = {}) {
  mainWindow = win;
  validateIpcSender = typeof options.validateSender === 'function'
    ? options.validateSender
    : () => false;

  // Allow configurable update feed URL via environment variable
  if (process.env.UPDATE_URL) {
    autoUpdater.setFeedURL(process.env.UPDATE_URL);
  }

  // Don't auto-download — we notify the user first
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // --- Events ---

  autoUpdater.on('checking-for-update', () => {
    sendStatus({ status: 'checking', manual: currentCheckIsManual });
  });

  autoUpdater.on('update-available', (info) => {
    const version = info.version;
    const wasManual = currentCheckIsManual;
    currentCheckIsManual = false;

    if (process.platform === 'linux') {
      // Linux: no auto-install, send download URL for manual update
      const repoUrl = getGitHubReleasesUrl(info);
      sendStatus({ status: 'update-available-linux', version, url: repoUrl, manual: wasManual });
      promptForUpdate(info, { manual: wasManual, url: repoUrl });
    } else {
      sendStatus({ status: 'update-available', version, manual: wasManual });
      promptForUpdate(info, { manual: wasManual });
    }
  });

  autoUpdater.on('update-not-available', () => {
    const wasManual = currentCheckIsManual;
    currentCheckIsManual = false;
    sendStatus({ status: 'up-to-date', manual: wasManual });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendStatus({
      status: 'downloading',
      percent: Math.round(progress.percent)
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    isDownloading = false;
    sendStatus({ status: 'update-downloaded', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    const wasManual = currentCheckIsManual;
    currentCheckIsManual = false;
    isDownloading = false;
    sendStatus({ status: 'error', error: err.message, manual: wasManual });
  });

  // --- IPC handlers ---

  ipcMain.handle('updater-check-now', (event) => {
    if (!validateIpcSender(event)) return null;
    return checkForUpdates(true);
  });

  ipcMain.handle('updater-install', (event) => {
    if (!validateIpcSender(event)) return null;
    // Quit and install the downloaded update
    autoUpdater.quitAndInstall(false, true);
    return null;
  });

  // --- Schedule checks ---

  // Check on launch (with a short delay to let the window settle)
  setTimeout(() => {
    checkForUpdates(false);
  }, 10000);

  // Check every 6 hours
  checkInterval = setInterval(() => {
    checkForUpdates(false);
  }, SIX_HOURS_MS);
}

/**
 * Build a GitHub releases URL from update info.
 * Falls back to the package.json repository or a default.
 */
function getGitHubReleasesUrl(info) {
  // If a releaseNotes URL or path is provided, try to use it
  if (info.releaseNotes && typeof info.releaseNotes === 'string' && info.releaseNotes.startsWith('http')) {
    return info.releaseNotes;
  }
  // Try to derive from the configured feed URL
  try {
    const feedUrl = autoUpdater.getFeedURL();
    if (feedUrl) {
      const url = new URL(feedUrl);
      // GitHub releases API: https://github.com/owner/repo/releases
      if (url.hostname === 'github.com' || url.hostname === 'api.github.com') {
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length >= 2) {
          return `https://github.com/${parts[0]}/${parts[1]}/releases/latest`;
        }
      }
      return feedUrl;
    }
  } catch {
    // ignore
  }
  // Fallback: generic releases page
  return `https://github.com/jamessabinaa/http-freekit/releases/latest`;
}

/**
 * Stop periodic update checks and clean up.
 */
function stopAutoUpdater() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  mainWindow = null;
  validateIpcSender = () => false;
}

module.exports = { initAutoUpdater, stopAutoUpdater };
