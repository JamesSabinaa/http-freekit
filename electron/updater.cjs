const { autoUpdater } = require('electron-updater');
const { app, ipcMain } = require('electron');

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

/**
 * Send an updater status event to the renderer.
 */
function sendStatus(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater-status', data);
  }
}

/**
 * Configure and start the auto-update system.
 * @param {Electron.BrowserWindow} win - The main application window
 */
function initAutoUpdater(win) {
  mainWindow = win;

  // Allow configurable update feed URL via environment variable
  if (process.env.UPDATE_URL) {
    autoUpdater.setFeedURL(process.env.UPDATE_URL);
  }

  // Don't auto-download — we notify the user first
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // --- Events ---

  autoUpdater.on('checking-for-update', () => {
    sendStatus({ status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    const version = info.version;

    if (process.platform === 'linux') {
      // Linux: no auto-install, send download URL for manual update
      const repoUrl = getGitHubReleasesUrl(info);
      sendStatus({ status: 'update-available-linux', version, url: repoUrl });
    } else {
      sendStatus({ status: 'update-available', version });
      // Auto-download on Windows/macOS
      autoUpdater.downloadUpdate();
    }
  });

  autoUpdater.on('update-not-available', () => {
    sendStatus({ status: 'up-to-date' });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendStatus({
      status: 'downloading',
      percent: Math.round(progress.percent)
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendStatus({ status: 'update-downloaded', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    sendStatus({ status: 'error', error: err.message });
  });

  // --- IPC handlers ---

  ipcMain.handle('updater-check-now', () => {
    return autoUpdater.checkForUpdates().catch(() => null);
  });

  ipcMain.handle('updater-install', () => {
    // Quit and install the downloaded update
    autoUpdater.quitAndInstall(false, true);
  });

  // --- Schedule checks ---

  // Check on launch (with a short delay to let the window settle)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 10000);

  // Check every 6 hours
  checkInterval = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
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
  return `https://github.com/AmenRa/http-freekit/releases/latest`;
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
}

module.exports = { initAutoUpdater, stopAutoUpdater };
