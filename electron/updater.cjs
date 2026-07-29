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
 * status objects: { status, eventId?, version?, url?, error? }.
 */

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LINUX_DOWNLOAD_URL = 'https://github.com/jamessabinaa/http-freekit/releases/latest';
let mainWindow = null;
let startupCheckTimer = null;
let checkInterval = null;
let activeCheck = null;
let activeDownload = null;
let activeUpdatePrompt = null;
let lastPromptedUpdate = null;
let validateIpcSender = () => false;
let currentStatus = { status: 'idle' };
let statusEventId = 0;
let configuredFeedUrl = null;
let activeInstallRequest = null;
let updaterLifecycle = 0;
let updaterRunning = false;
let registeredUpdaterEvents = [];
const UPDATER_IPC_CHANNELS = [
  'updater-check-now',
  'updater-get-status',
  'updater-install'
];

function isCurrentUpdaterLifecycle(lifecycle) {
  return updaterRunning && lifecycle === updaterLifecycle;
}

function removeUpdaterEventHandlers() {
  for (const [eventName, handler] of registeredUpdaterEvents) {
    autoUpdater.removeListener(eventName, handler);
  }
  registeredUpdaterEvents = [];
}

function registerUpdaterEvent(eventName, handler) {
  autoUpdater.on(eventName, handler);
  registeredUpdaterEvents.push([eventName, handler]);
}

function removeUpdaterIpcHandlers() {
  if (typeof ipcMain.removeHandler !== 'function') return;
  for (const channel of UPDATER_IPC_CHANNELS) ipcMain.removeHandler(channel);
}

function ownsInstallRequest(request) {
  return activeInstallRequest === request && isCurrentUpdaterLifecycle(request.lifecycle);
}

function releaseInstallRequest(request = activeInstallRequest) {
  if (!request || activeInstallRequest !== request) return false;
  activeInstallRequest = null;
  return true;
}

function cancelUpdateInstall() {
  const request = activeInstallRequest;
  if (!request || !releaseInstallRequest(request)) return false;
  if (!isCurrentUpdaterLifecycle(request.lifecycle)) return false;
  request.onPreparationFailed();
  sendStatus({
    status: 'install-canceled',
    version: currentStatus.version,
    manual: true
  }, request.lifecycle);
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
function sendStatus(data, lifecycle = null) {
  if (lifecycle !== null && !isCurrentUpdaterLifecycle(lifecycle)) return false;
  data = { ...data, eventId: ++statusEventId };
  currentStatus = { ...data };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater-status', data);
  }
  return true;
}

function completeCheckStatus(lifecycle = updaterLifecycle) {
  if (!activeCheck || activeCheck.lifecycle !== lifecycle) return false;
  const check = activeCheck;
  check.statusReported = true;
  if (check.promiseSettled) activeCheck = null;
  return check.manual;
}

function reportCheckError(check, error) {
  if (check.statusReported || !isCurrentUpdaterLifecycle(check.lifecycle)) return;
  check.statusReported = true;
  sendStatus({ status: 'error', error: error.message, manual: check.manual }, check.lifecycle);
}

function reportInstallError(request, error) {
  if (!ownsInstallRequest(request) || !releaseInstallRequest(request)) return false;
  request.onPreparationFailed();
  sendStatus({ status: 'error', error: error.message, manual: true }, request.lifecycle);
  return true;
}

function reportDownloadError(download, error) {
  if (activeDownload !== download || !isCurrentUpdaterLifecycle(download.lifecycle)) return false;
  activeDownload = null;
  sendStatus({ status: 'error', error: error.message, manual: download.manual }, download.lifecycle);
  return true;
}

function checkForUpdates(manual = false, lifecycle = updaterLifecycle) {
  if (!isCurrentUpdaterLifecycle(lifecycle)) return Promise.resolve(null);
  const requestedManual = manual === true;
  if (activeCheck && activeCheck.lifecycle !== lifecycle) activeCheck = null;
  if (activeCheck) {
    if (activeCheck.promiseSettled) {
      activeCheck = null;
      return checkForUpdates(requestedManual, lifecycle);
    }
    if (activeCheck.statusReported) {
      return activeCheck.promise.then(() => {
        if (!isCurrentUpdaterLifecycle(lifecycle)) return null;
        return checkForUpdates(requestedManual, lifecycle);
      });
    }
    if (requestedManual && !activeCheck.manual) {
      activeCheck.manual = true;
      if (activeCheck.checkingReported) {
        sendStatus({ status: 'checking', manual: true });
      }
    }
    return activeCheck.promise;
  }

  // electron-updater exposes one shared error event without operation metadata.
  // Keep its check/download/install operations disjoint so every error has one
  // unambiguous owner.
  if (activeInstallRequest?.lifecycle === lifecycle
      || activeUpdatePrompt?.lifecycle === lifecycle
      || activeDownload?.lifecycle === lifecycle) {
    return Promise.resolve(null);
  }

  const check = {
    manual: requestedManual,
    lifecycle,
    checkingReported: false,
    statusReported: false,
    promiseSettled: false,
    promise: null
  };
  activeCheck = check;
  let upstreamCheck;
  try {
    upstreamCheck = autoUpdater.checkForUpdates();
  } catch (err) {
    activeCheck = null;
    if (isCurrentUpdaterLifecycle(lifecycle)) {
      sendStatus({ status: 'error', error: err.message, manual: check.manual });
    }
    return Promise.resolve(null);
  }
  check.promise = Promise.resolve(upstreamCheck).catch((err) => {
    reportCheckError(check, err);
    return null;
  }).finally(() => {
    check.promiseSettled = true;
    if (activeCheck === check && check.statusReported) activeCheck = null;
  });
  return check.promise;
}

async function promptForUpdate(info, options = {}, lifecycle = updaterLifecycle) {
  if (!isCurrentUpdaterLifecycle(lifecycle)) return;
  const version = info.version;
  const manual = Boolean(options.manual);

  if (activeDownload?.lifecycle === lifecycle || activeUpdatePrompt?.lifecycle === lifecycle) return;
  if (!manual
      && lastPromptedUpdate?.lifecycle === lifecycle
      && lastPromptedUpdate.version === version) return;

  const prompt = { lifecycle, version };
  const promptWindow = mainWindow;
  let download = null;
  lastPromptedUpdate = { lifecycle, version };
  activeUpdatePrompt = prompt;

  try {
    if (process.platform === 'linux') {
      const url = options.url || getLinuxDownloadUrl(info);
      const result = await dialog.showMessageBox(promptWindow, {
        type: 'info',
        title: 'Update Available',
        message: `HTTP FreeKit ${version} is available`,
        detail: `You are running ${app.getVersion()}.\n\nDownload the latest Linux package from the release page.`,
        buttons: ['Open Download Page', 'Later'],
        defaultId: 0,
        cancelId: 1
      });
      if (!isCurrentUpdaterLifecycle(lifecycle) || activeUpdatePrompt !== prompt) return;
      if (result.response === 0) {
        await shell.openExternal(url);
      } else {
        sendStatus({ status: 'update-dismissed', version, manual }, lifecycle);
      }
      return;
    }

    const result = await dialog.showMessageBox(promptWindow, {
      type: 'info',
      title: 'Update Available',
      message: `HTTP FreeKit ${version} is available`,
      detail: `You are running ${app.getVersion()}.\n\nDownload the update now? It will be installed after it downloads and you choose to restart.`,
      buttons: ['Download Update', 'Later'],
      defaultId: 0,
      cancelId: 1
    });
    if (!isCurrentUpdaterLifecycle(lifecycle) || activeUpdatePrompt !== prompt) return;

    if (result.response !== 0) {
      sendStatus({ status: 'update-dismissed', version, manual }, lifecycle);
      return;
    }

    download = { lifecycle, version, manual };
    activeDownload = download;
    sendStatus({ status: 'download-started', version, manual }, lifecycle);
    await autoUpdater.downloadUpdate();
  } catch (err) {
    if (download) {
      reportDownloadError(download, err);
    } else if (isCurrentUpdaterLifecycle(lifecycle) && activeUpdatePrompt === prompt) {
      sendStatus({ status: 'error', error: err.message, manual }, lifecycle);
    }
  } finally {
    if (activeUpdatePrompt === prompt) activeUpdatePrompt = null;
  }
}

/**
 * Configure and start the auto-update system.
 * @param {Electron.BrowserWindow} win - The main application window
 * @param {{validateSender?: function, prepareForInstall?: function,
 *   onInstallPreparationFailed?: function}} options - IPC sender validation and quit preflight
 */
function initAutoUpdater(win, options = {}) {
  if (updaterRunning || startupCheckTimer !== null || checkInterval !== null) {
    stopAutoUpdater();
  }
  const lifecycle = ++updaterLifecycle;
  updaterRunning = true;
  mainWindow = win;
  validateIpcSender = typeof options.validateSender === 'function'
    ? options.validateSender
    : () => false;
  const lifecyclePrepareForInstall = typeof options.prepareForInstall === 'function'
    ? options.prepareForInstall
    : async () => true;
  const lifecycleOnInstallPreparationFailed = typeof options.onInstallPreparationFailed === 'function'
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

  removeUpdaterEventHandlers();
  removeUpdaterIpcHandlers();

  registerUpdaterEvent('checking-for-update', () => {
    if (!isCurrentUpdaterLifecycle(lifecycle)) return;
    const check = activeCheck?.lifecycle === lifecycle ? activeCheck : null;
    if (!check) return;
    check.checkingReported = true;
    sendStatus({
      status: 'checking',
      manual: check.manual === true
    }, lifecycle);
  });

  registerUpdaterEvent('update-available', (info) => {
    if (!isCurrentUpdaterLifecycle(lifecycle)) return;
    if (activeCheck?.lifecycle !== lifecycle) return;
    const version = info.version;
    const wasManual = completeCheckStatus(lifecycle);

    if (process.platform === 'linux') {
      // Linux: no auto-install, send download URL for manual update
      const downloadUrl = getLinuxDownloadUrl(info);
      sendStatus({ status: 'update-available-linux', version, url: downloadUrl, manual: wasManual }, lifecycle);
      promptForUpdate(info, { manual: wasManual, url: downloadUrl }, lifecycle);
    } else {
      sendStatus({ status: 'update-available', version, manual: wasManual }, lifecycle);
      promptForUpdate(info, { manual: wasManual }, lifecycle);
    }
  });

  registerUpdaterEvent('update-not-available', () => {
    if (!isCurrentUpdaterLifecycle(lifecycle)) return;
    if (activeCheck?.lifecycle !== lifecycle) return;
    const wasManual = completeCheckStatus(lifecycle);
    sendStatus({ status: 'up-to-date', manual: wasManual }, lifecycle);
  });

  registerUpdaterEvent('download-progress', (progress) => {
    if (!isCurrentUpdaterLifecycle(lifecycle)) return;
    if (activeDownload?.lifecycle !== lifecycle) return;
    sendStatus({
      status: 'downloading',
      percent: Math.round(progress.percent)
    }, lifecycle);
  });

  registerUpdaterEvent('update-downloaded', (info) => {
    if (!isCurrentUpdaterLifecycle(lifecycle)) return;
    if (activeDownload?.lifecycle !== lifecycle) return;
    activeDownload = null;
    sendStatus({ status: 'update-downloaded', version: info.version }, lifecycle);
  });

  registerUpdaterEvent('error', (err) => {
    if (!isCurrentUpdaterLifecycle(lifecycle)) return;
    const check = activeCheck?.lifecycle === lifecycle ? activeCheck : null;
    if (check && !check.statusReported) {
      reportCheckError(check, err);
      if (check.promiseSettled && activeCheck === check) activeCheck = null;
      return;
    }
    const installRequest = activeInstallRequest?.lifecycle === lifecycle
      ? activeInstallRequest
      : null;
    if (installRequest && ['handoff', 'started'].includes(installRequest.phase)) {
      reportInstallError(installRequest, err);
      return;
    }
    const download = activeDownload?.lifecycle === lifecycle ? activeDownload : null;
    if (download) reportDownloadError(download, err);
  });

  // --- IPC handlers ---

  ipcMain.handle('updater-check-now', (event) => {
    if (!validateIpcSender(event)) return null;
    if (!isCurrentUpdaterLifecycle(lifecycle)) return null;
    return checkForUpdates(true, lifecycle);
  });

  ipcMain.handle('updater-get-status', (event) => {
    if (!validateIpcSender(event)) return null;
    if (!isCurrentUpdaterLifecycle(lifecycle)) return null;
    return { ...currentStatus };
  });

  ipcMain.handle('updater-install', async (event) => {
    if (!validateIpcSender(event)) return null;
    if (!isCurrentUpdaterLifecycle(lifecycle)) return null;
    if (activeInstallRequest) return { started: false, inProgress: true };

    const request = {
      lifecycle,
      phase: 'waiting-for-check',
      prepareForInstall: lifecyclePrepareForInstall,
      onPreparationFailed: lifecycleOnInstallPreparationFailed
    };
    activeInstallRequest = request;
    try {
      const check = activeCheck?.lifecycle === lifecycle ? activeCheck : null;
      if (check && !check.promiseSettled) await check.promise;
      if (!ownsInstallRequest(request)) return { started: false, inProgress: false };
      if (activeCheck === check && check?.promiseSettled) activeCheck = null;

      request.phase = 'preparing';
      if (!await request.prepareForInstall()) {
        releaseInstallRequest(request);
        return { started: false, inProgress: false };
      }
      if (!ownsInstallRequest(request)) return { started: false, inProgress: false };
      // The renderer has explicitly accepted losing mock drafts and has safely
      // persisted Send state, so every platform can now follow its updater-
      // specific window-close sequence.
      request.phase = 'handoff';
      autoUpdater.quitAndInstall(false, true);
      if (!ownsInstallRequest(request)) return { started: false, inProgress: false };
      request.phase = 'started';
      return { started: true, inProgress: true };
    } catch (err) {
      reportInstallError(request, err);
      return { started: false, inProgress: false };
    }
  });

  // --- Schedule checks ---

  // Check on launch (with a short delay to let the window settle)
  startupCheckTimer = setTimeout(() => {
    if (!isCurrentUpdaterLifecycle(lifecycle)) return;
    startupCheckTimer = null;
    checkForUpdates(false, lifecycle);
  }, 10000);

  // Check every 6 hours
  checkInterval = setInterval(() => {
    if (isCurrentUpdaterLifecycle(lifecycle)) checkForUpdates(false, lifecycle);
  }, SIX_HOURS_MS);
}

/**
 * Stop periodic update checks and clean up.
 */
function stopAutoUpdater() {
  updaterRunning = false;
  updaterLifecycle++;
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
  releaseInstallRequest();
  activeCheck = null;
  activeDownload = null;
  activeUpdatePrompt = null;
  lastPromptedUpdate = null;
  configuredFeedUrl = null;
  removeUpdaterEventHandlers();
  removeUpdaterIpcHandlers();
}

module.exports = { initAutoUpdater, stopAutoUpdater, cancelUpdateInstall };
