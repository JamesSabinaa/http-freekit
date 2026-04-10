const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script for HTTP FreeKit Electron app.
 *
 * Exposes a safe subset of native APIs to the renderer via contextBridge.
 * Context isolation is enabled and nodeIntegration is disabled — all
 * communication with the main process goes through validated IPC channels.
 */

// Whitelist of allowed IPC channels the renderer may invoke
const ALLOWED_INVOKE_CHANNELS = [
  'get-desktop-version',
  'get-server-auth-token',
  'get-device-info',
  'select-file-path',
  'select-save-file-path',
  'open-context-menu',
  'restart-app',
  'updater-check-now',
  'updater-install'
];

// Whitelist of allowed IPC channels the renderer may listen on
const ALLOWED_ON_CHANNELS = [
  'updater-status'
];

/**
 * Safe wrapper around ipcRenderer.invoke that only permits whitelisted channels.
 */
function safeInvoke(channel, ...args) {
  if (!ALLOWED_INVOKE_CHANNELS.includes(channel)) {
    throw new Error(`IPC channel "${channel}" is not allowed`);
  }
  return ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld('electronApi', {
  /**
   * Returns the desktop app version string (from package.json).
   * @returns {Promise<string>}
   */
  getDesktopVersion: () => safeInvoke('get-desktop-version'),

  /**
   * Returns the auth token used to authenticate UI requests to the server.
   * @returns {Promise<string>}
   */
  getServerAuthToken: () => safeInvoke('get-server-auth-token'),

  /**
   * Returns device information: platform, arch, electron version, OS version.
   * @returns {Promise<{platform: string, arch: string, electronVersion: string, osVersion: string}>}
   */
  getDeviceInfo: () => safeInvoke('get-device-info'),

  /**
   * Opens a native file-open dialog. Returns the selected file path or null.
   * @param {object} [options]
   * @param {string} [options.title] - Dialog title
   * @param {Array<{name: string, extensions: string[]}>} [options.filters] - File type filters
   * @returns {Promise<string|null>}
   */
  selectFilePath: (options) => safeInvoke('select-file-path', options || {}),

  /**
   * Opens a native file-save dialog. Returns the selected path or null.
   * @param {object} [options]
   * @param {string} [options.title] - Dialog title
   * @param {string} [options.defaultPath] - Default file name / path
   * @param {Array<{name: string, extensions: string[]}>} [options.filters] - File type filters
   * @returns {Promise<string|null>}
   */
  selectSaveFilePath: (options) => safeInvoke('select-save-file-path', options || {}),

  /**
   * Opens a native context menu at the current cursor position.
   * @param {Array<{label: string, id: string, enabled?: boolean, type?: string}>} items
   * @returns {Promise<string|null>} The id of the clicked item, or null if dismissed
   */
  openContextMenu: (items) => safeInvoke('open-context-menu', items || []),

  /**
   * Restarts the Electron app (relaunches and quits current instance).
   * @returns {Promise<void>}
   */
  restartApp: () => safeInvoke('restart-app'),

  /**
   * Manually trigger an update check.
   * @returns {Promise<void>}
   */
  checkForUpdates: () => safeInvoke('updater-check-now'),

  /**
   * Quit and install a downloaded update.
   * @returns {Promise<void>}
   */
  installUpdate: () => safeInvoke('updater-install'),

  /**
   * Listen for auto-updater status events from the main process.
   * @param {(data: {status: string, version?: string, url?: string, percent?: number, error?: string}) => void} callback
   * @returns {() => void} Unsubscribe function
   */
  onUpdaterStatus: (callback) => {
    const channel = 'updater-status';
    if (!ALLOWED_ON_CHANNELS.includes(channel)) {
      throw new Error(`IPC channel "${channel}" is not allowed`);
    }
    const handler = (_event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
});
