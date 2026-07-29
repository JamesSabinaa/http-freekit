const { autoUpdater } = require('electron-updater');
const { app, dialog, ipcMain, shell } = require('electron');
const { shouldForceLinuxUpdateChecks } = require('./update-platform.cjs');

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
const DEFAULT_LINUX_DOWNLOAD_URL = 'https://github.com/jamessabinaa/http-freekit/releases/latest';
let mainWindow = null;
let startupCheckTimer = null;
let checkInterval = null;
let currentCheckIsManual = false;
let isDownloading = false;
let updatePromptOpen = false;
let lastPromptedVersion = null;
let validateIpcSender = () => false;
let currentStatus = { status: 'idle' };
let configuredFeedUrl = null;
let prepareForInstall = async () => true;
let onInstallPreparationFailed = () => {};
let installRequestInFlight = false;
let installRequestGeneration = 0;

function releaseInstallRequest() {
  const wasInFlight = installRequestInFlight;
  installRequestInFlight = false;
  if (wasInFlight) installRequestGeneration++;
  return wasInFlight;
}

function cancelUpdateInstall() {
  if (!releaseInstallRequest()) return false;
  onInstallPreparationFailed();
  sendStatus({
    status: 'install-canceled',
    version: currentStatus.version,
    manual: true
  });
  return true;
}

function getWebUrl(value) {
  if (typeof value !== 'string') return null;
  const source = value.trim();
  if (!source) return null;

  try {
    const parsed = new URL(source);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? { source, parsed }
      : null;
  } catch {
    return null;
  }
}

function getGitHubDownloadUrl(parsedUrl) {
  const parts = parsedUrl.pathname.split('/').filter(Boolean);
  let owner;
  let repo;

  if (parsedUrl.hostname.toLowerCase() === 'github.com') {
    [owner, repo] = parts;
  } else if (parsedUrl.hostname.toLowerCase() === 'api.github.com' && parts[0] === 'repos') {
    [, owner, repo] = parts;
  }

  if (!owner || !repo) return null;
  return `https://github.com/${owner}/${repo.replace(/\.git$/i, '')}/releases/latest`;
}

function getLinuxDownloadUrl(info = {}) {
  const releaseNotesUrl = getWebUrl(info.releaseNotes);
  if (releaseNotesUrl) return releaseNotesUrl.source;

  const configuredSource = getWebUrl(configuredFeedUrl);
  if (configuredSource) {
    return getGitHubDownloadUrl(configuredSource.parsed) || configuredSource.source;
  }

  return DEFAULT_LINUX_DOWNLOAD_URL;
}

/**
 * Send an updater status event to the renderer.
 */
function sendStatus(data) {
  currentStatus = { ...data };
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
      const url = options.url || getLinuxDownloadUrl(info);
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Available',
        message: `HTTP FreeKit ${version} is available`,
        detail: `You are running ${app.getVersion()}.\n\nDownload the latest Linux package from the release page.`,
        buttons: ['Open Download Page', 'Later'],
        defaultId: 0,
        cancelId: 1
      });
      if (result.response === 0) {
        await shell.openExternal(url);
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
 * @param {{validateSender?: function, prepareForInstall?: function,
 *   onInstallPreparationFailed?: function}} options - IPC sender validation and quit preflight
 */
function initAutoUpdater(win, options = {}) {
  mainWindow = win;
  validateIpcSender = typeof options.validateSender === 'function'
    ? options.validateSender
    : () => false;
  prepareForInstall = typeof options.prepareForInstall === 'function'
    ? options.prepareForInstall
    : async () => true;
  onInstallPreparationFailed = typeof options.onInstallPreparationFailed === 'function'
    ? options.onInstallPreparationFailed
    : () => {};

  // Retain the validated source instead of reading it back through electron-
  // updater's deprecated getFeedURL() API when building Linux download links.
  const configuredSource = getWebUrl(process.env.UPDATE_URL);
  configuredFeedUrl = configuredSource?.source || null;
  if (configuredFeedUrl) {
    autoUpdater.setFeedURL(configuredFeedUrl);
  }

  // Don't auto-download — we notify the user first
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // electron-updater selects AppImageUpdater for every Linux package and its
  // normal activity check returns false without APPIMAGE. DEB/RPM only use the
  // check/notification path below, so enable checks without enabling downloads.
  if (shouldForceLinuxUpdateChecks(process.platform, app.isPackaged, process.env)) {
    autoUpdater.forceDevUpdateConfig = true;
  }

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
      const downloadUrl = getLinuxDownloadUrl(info);
      sendStatus({ status: 'update-available-linux', version, url: downloadUrl, manual: wasManual });
      promptForUpdate(info, { manual: wasManual, url: downloadUrl });
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
    releaseInstallRequest();
    onInstallPreparationFailed();
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

  ipcMain.handle('updater-get-status', (event) => {
    if (!validateIpcSender(event)) return null;
    return { ...currentStatus };
  });

  ipcMain.handle('updater-install', async (event) => {
    if (!validateIpcSender(event)) return null;
    if (installRequestInFlight) return { started: false, inProgress: true };

    installRequestInFlight = true;
    const requestGeneration = ++installRequestGeneration;
    try {
      if (!await prepareForInstall()) {
        releaseInstallRequest();
        return { started: false, inProgress: false };
      }
      if (!installRequestInFlight || requestGeneration !== installRequestGeneration) {
        return { started: false, inProgress: false };
      }
      // The renderer has explicitly accepted losing mock drafts and has safely
      // persisted Send state, so every platform can now follow its updater-
      // specific window-close sequence.
      autoUpdater.quitAndInstall(false, true);
      if (!installRequestInFlight || requestGeneration !== installRequestGeneration) {
        return { started: false, inProgress: false };
      }
      return { started: true, inProgress: true };
    } catch (err) {
      if (releaseInstallRequest()) onInstallPreparationFailed();
      sendStatus({ status: 'error', error: err.message, manual: true });
      return { started: false, inProgress: false };
    }
  });

  // --- Schedule checks ---

  // Check on launch (with a short delay to let the window settle)
  startupCheckTimer = setTimeout(() => {
    startupCheckTimer = null;
    checkForUpdates(false);
  }, 10000);

  // Check every 6 hours
  checkInterval = setInterval(() => {
    checkForUpdates(false);
  }, SIX_HOURS_MS);
}

/**
 * Stop periodic update checks and clean up.
 */
function stopAutoUpdater() {
  if (startupCheckTimer !== null) {
    clearTimeout(startupCheckTimer);
    startupCheckTimer = null;
  }
  if (checkInterval !== null) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  mainWindow = null;
  validateIpcSender = () => false;
  prepareForInstall = async () => true;
  onInstallPreparationFailed = () => {};
  releaseInstallRequest();
  configuredFeedUrl = null;
}

module.exports = { initAutoUpdater, stopAutoUpdater, cancelUpdateInstall };
