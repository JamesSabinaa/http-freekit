const {
  app,
  autoUpdater: nativeAutoUpdater,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell
} = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const http = require('http');
const windowStateKeeper = require('electron-window-state');
const { buildAppMenu } = require('./menu.cjs');
const { createTray, destroyTray } = require('./tray.cjs');
const { initAutoUpdater, stopAutoUpdater } = require('./updater.cjs');
const { PROTOCOL_SCHEME, parseOpenDeepLink, findDeepLinkArg } = require('./deep-link.cjs');
const { isAllowedRendererUrl, isSafeExternalUrl } = require('./security.cjs');
const { resolveDesktopMcpExecutable } = require('./mcp-launch.cjs');
const { createServerLogLifecycle } = require('./server-log.cjs');
const { waitForServer } = require('./server-readiness.cjs');
const { shutdownServerProcess } = require('./server-shutdown.cjs');
const { prepareRendererForQuit, runQuitCleanup } = require('./quit-cleanup.cjs');
const { installUnloadConfirmation } = require('./unload-confirmation.cjs');

let mainWindow = null;
let mainWindowReadyToShow = false;
let showMainWindowWhenReady = false;
let serverProcess = null;
let updateInstallPrepared = false;
let updateInstallQuitStarted = false;
let apiPort = null;
let isShuttingDown = false;
let serverReady = false;
let quitCleanupComplete = false;
let quitCleanupPromise = null;
let relaunchRequested = false;
let deepLinkProcessing = Promise.resolve();
const pendingDeepLinks = [];
const authToken = crypto.randomBytes(32).toString('hex');
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

/**
 * Find a free TCP port by temporarily binding to port 0.
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * Spawn the HTTP FreeKit server as a child process.
 */
async function startServer() {
  apiPort = await findFreePort();

  const logsDir = app.getPath('logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const logPath = path.join(logsDir, 'server.log');
  const serverLog = createServerLogLifecycle({
    logPath,
    initialMessage: `\n--- Server starting at ${new Date().toISOString()} (port ${apiPort}) ---\n`
  });
  await serverLog.ready;

  // Server files are in app.asar.unpacked (via asarUnpack config)
  let serverScript = path.join(__dirname, '..', 'src', 'index.js');
  if (serverScript.includes('app.asar')) {
    serverScript = serverScript.replace('app.asar', 'app.asar.unpacked');
  }

  let proc = null;
  let processStartupComplete = false;
  let rejectProcessStartup;
  const processStartupFailure = new Promise((_, reject) => {
    rejectProcessStartup = reject;
  });
  processStartupFailure.catch(() => {});

  try {
    proc = spawn(process.execPath, [serverScript], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        API_PORT: String(apiPort),
        AUTH_TOKEN: authToken,
        ELECTRON: '1',
        HTTP_FREEKIT_MCP_EXECUTABLE: resolveDesktopMcpExecutable({ isPackaged: app.isPackaged }),
        HTTP_FREEKIT_MCP_PACKAGED_APP: app.isPackaged ? '1' : '0',
        HTTP_FREEKIT_MCP_REMOUNTING_APP: app.isPackaged && process.platform === 'linux' && process.env.APPIMAGE ? '1' : '0',
        HTTP_FREEKIT_MCP_DESCRIPTOR_PATH: path.join(app.getPath('userData'), 'mcp-runtime.json')
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      cwd: path.dirname(serverScript)
    });
    serverProcess = proc;
    serverLog.attachProcess(proc);

    proc.on('error', (err) => {
      serverLog.write(`--- Server error: ${err.message} ---\n`);
      if (!processStartupComplete) rejectProcessStartup(err);
      else console.error('[Electron] Server process error:', err.message);
    });

    proc.on('exit', (code, signal) => {
      const msg = `Server exited (code=${code}, signal=${signal})`;
      serverLog.write(`--- ${msg} at ${new Date().toISOString()} ---\n`);
      if (serverProcess === proc) serverProcess = null;
      serverReady = false;

      // If server exits unexpectedly, notify and quit
      if (!isShuttingDown && mainWindow) {
        dialog.showErrorBox(
          'HTTP FreeKit',
          'The server process has unexpectedly exited. The application will now close.'
        );
        app.quit();
      }
    });

    await Promise.race([
      waitForServer(apiPort, proc),
      serverLog.startupFailure,
      processStartupFailure
    ]);
    processStartupComplete = true;
    serverLog.completeStartup();
    serverReady = true;
  } catch (error) {
    serverLog.close();
    let terminationRequested = false;
    if (proc && !proc.killed) {
      try { terminationRequested = proc.kill('SIGKILL'); } catch {}
    }
    if (serverProcess === proc && (!proc || proc.killed || terminationRequested)) {
      serverProcess = null;
    }
    serverReady = false;
    throw error;
  }
}

function registerProtocolHandler() {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindowReadyToShow) {
    showMainWindowWhenReady = true;
    return;
  }
  showMainWindowWhenReady = false;
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function handleMainWindowReady(windowForReady, showOnReady) {
  if (mainWindow !== windowForReady || windowForReady.isDestroyed()) return;
  mainWindowReadyToShow = true;
  if (showMainWindowWhenReady) showMainWindow();
  else if (showOnReady) windowForReady.show();
}

function reportDeepLinkError(err, { revealWindow = false } = {}) {
  const message = err?.message || String(err);
  if (app.isReady()) {
    dialog.showErrorBox('HTTP FreeKit — Could Not Open Link', message);
  } else {
    console.error('[Deep Link]', message);
  }
  if (revealWindow) showMainWindow();
}

function requestOpenInProxiedChrome(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const resolveOnce = value => settle(resolve, value);
    const rejectOnce = err => settle(reject, err);
    const body = JSON.stringify({ url });
    const req = http.request({
      hostname: '127.0.0.1',
      port: apiPort,
      path: '/api/interceptors/chrome/open',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      const chunks = [];
      let responseEnded = false;
      res.on('data', chunk => chunks.push(chunk));
      res.once('aborted', () => {
        rejectOnce(new Error('Server response was aborted before completion'));
      });
      res.once('error', rejectOnce);
      res.once('close', () => {
        if (!responseEnded) {
          rejectOnce(new Error('Server response closed before completion'));
        }
      });
      res.on('end', () => {
        responseEnded = true;
        if (!res.complete) {
          rejectOnce(new Error('Server response ended before completion'));
          return;
        }
        const responseText = Buffer.concat(chunks).toString('utf8');
        let response = {};
        try { response = responseText ? JSON.parse(responseText) : {}; } catch {}

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolveOnce(response);
        } else {
          rejectOnce(new Error(response.error || `Server returned HTTP ${res.statusCode}`));
        }
      });
    });

    req.once('error', rejectOnce);
    req.setTimeout(15000, () => req.destroy(new Error('Timed out opening the link')));
    req.end(body);
  });
}

function scheduleDeepLink(targetUrl, { revealWindowOnFailure = false } = {}) {
  deepLinkProcessing = deepLinkProcessing
    .then(() => requestOpenInProxiedChrome(targetUrl))
    .catch(err => reportDeepLinkError(err, { revealWindow: revealWindowOnFailure }));
}

function handleDeepLink(value, { revealWindowOnFailure = false } = {}) {
  let targetUrl;
  try {
    targetUrl = parseOpenDeepLink(value);
  } catch (err) {
    reportDeepLinkError(err, { revealWindow: revealWindowOnFailure });
    return;
  }

  if (!serverReady) {
    pendingDeepLinks.push(targetUrl);
    return;
  }
  scheduleDeepLink(targetUrl, { revealWindowOnFailure });
}

function flushPendingDeepLinks({ revealWindowOnFailure = false } = {}) {
  for (const targetUrl of pendingDeepLinks.splice(0)) {
    scheduleDeepLink(targetUrl, { revealWindowOnFailure });
  }
}

/**
 * Gracefully shut down the server process.
 * The child reports completed cleanup over IPC. A single overall deadline
 * keeps desktop exit bounded if cleanup hangs.
 */
function shutdownServer() {
  if (!serverProcess) return Promise.resolve();

  isShuttingDown = true;
  return shutdownServerProcess({
    proc: serverProcess,
    apiPort,
    authToken
  });
}

function createWindow({ showOnReady = true } = {}) {
  const windowState = windowStateKeeper({
    defaultWidth: 1366,
    defaultHeight: 768
  });

  // Validate saved window state is on-screen
  const { screen } = require('electron');
  const displays = screen.getAllDisplays();
  const isOnScreen = displays.some(d => {
    const b = d.bounds;
    return windowState.x >= b.x && windowState.y >= b.y &&
           windowState.x < b.x + b.width && windowState.y < b.y + b.height;
  });
  if (!isOnScreen) {
    // Reset to center of primary display
    delete windowState.x;
    delete windowState.y;
  }

  // Load window icon from build directory
  let windowIcon;
  try {
    const { nativeImage } = require('electron');
    const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
    windowIcon = nativeImage.createFromPath(iconPath);
    if (windowIcon.isEmpty()) windowIcon = undefined;
  } catch {}

  mainWindow = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: 700,
    minHeight: 600,
    show: false,
    title: 'HTTP FreeKit',
    icon: windowIcon,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  mainWindowReadyToShow = false;
  showMainWindowWhenReady = false;
  const windowForReady = mainWindow;

  windowState.manage(mainWindow);

  installUnloadConfirmation(mainWindow, { dialog });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedRendererUrl(url, apiPort)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch(() => {});
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedRendererUrl(url, apiPort)) {
      try {
        if (new URL(url).pathname === '/api/certificate') {
          mainWindow.webContents.downloadURL(url);
        }
      } catch {}
    } else if (isSafeExternalUrl(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    handleMainWindowReady(windowForReady, showOnReady);
  });

  mainWindow.loadURL(`http://127.0.0.1:${apiPort}/?authToken=${authToken}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
    mainWindowReadyToShow = false;
    showMainWindowWhenReady = false;
  });
}

// ---------------------------------------------------------------------------
// IPC handlers — invoked from the renderer via the preload contextBridge
// ---------------------------------------------------------------------------

/** Validate that the IPC call originates from the expected local server URL. */
function validateSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    return false;
  }
  return isAllowedRendererUrl(event.senderFrame?.url, apiPort);
}

ipcMain.handle('get-desktop-version', (event) => {
  if (!validateSender(event)) return null;
  return app.getVersion();
});

ipcMain.handle('get-server-auth-token', (event) => {
  if (!validateSender(event)) return null;
  return authToken;
});

ipcMain.handle('get-device-info', (event) => {
  if (!validateSender(event)) return null;
  return {
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
    osVersion: process.getSystemVersion()
  };
});

ipcMain.handle('select-file-path', async (event, options) => {
  if (!validateSender(event)) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || 'Select File',
    filters: options.filters || [],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('select-save-file-path', async (event, options) => {
  if (!validateSender(event)) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title || 'Save File',
    defaultPath: options.defaultPath || undefined,
    filters: options.filters || []
  });
  if (result.canceled) return null;
  return result.filePath;
});

ipcMain.handle('open-context-menu', (event, items) => {
  if (!validateSender(event)) return null;
  const { Menu: ElectronMenu } = require('electron');
  return new Promise((resolve) => {
    const template = items.map((item) => {
      if (item.type === 'separator') return { type: 'separator' };
      return {
        label: item.label || '',
        enabled: item.enabled !== false,
        click: () => resolve(item.id || null)
      };
    });
    const menu = ElectronMenu.buildFromTemplate(template);
    menu.popup({
      window: mainWindow,
      callback: () => resolve(null) // menu dismissed without selection
    });
  });
});

ipcMain.handle('restart-app', (event) => {
  if (!validateSender(event)) return;
  relaunchRequested = true;
  app.quit();
});

if (hasSingleInstanceLock) app.on('second-instance', (_event, argv) => {
  const deepLink = findDeepLinkArg(argv);
  if (deepLink) {
    handleDeepLink(deepLink);
  } else {
    showMainWindow();
  }
});

if (hasSingleInstanceLock) app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

if (hasSingleInstanceLock) nativeAutoUpdater.on('before-quit-for-update', () => {
  // electron-updater can wait for Squirrel.Mac after the renderer accepts the
  // preflight. Only skip duplicate preparation once the native updater has
  // actually started its quit sequence, never during that waiting period.
  updateInstallQuitStarted = updateInstallPrepared;
});

if (hasSingleInstanceLock) app.on('before-quit', (event) => {
  if (quitCleanupComplete) return;
  event.preventDefault();
  if (quitCleanupPromise) return;

  const windowForQuit = mainWindow;
  quitCleanupPromise = runQuitCleanup({
    mainWindow: windowForQuit,
    prepare: updateInstallQuitStarted ? async () => true : undefined,
    onPrepared: () => { isShuttingDown = true; },
    relaunch: relaunchRequested ? () => app.relaunch() : null,
    stopAutoUpdater,
    destroyTray,
    shutdownServer
  }).then(shouldQuit => {
    quitCleanupPromise = null;
    if (shouldQuit) {
      quitCleanupComplete = true;
      app.quit();
      return;
    }
    isShuttingDown = false;
    relaunchRequested = false;
    showMainWindow();
  }).catch(err => {
    quitCleanupPromise = null;
    isShuttingDown = false;
    relaunchRequested = false;
    console.error('[Electron] Quit preparation failed:', err.message);
    showMainWindow();
  });
});

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  try {
    registerProtocolHandler();
    await startServer();

    const startupDeepLink = findDeepLinkArg(process.argv);
    const launchedFromDeepLink = !!startupDeepLink || pendingDeepLinks.length > 0;
    createWindow({ showOnReady: !launchedFromDeepLink });
    if (startupDeepLink) {
      handleDeepLink(startupDeepLink, { revealWindowOnFailure: launchedFromDeepLink });
    }
    flushPendingDeepLinks({ revealWindowOnFailure: launchedFromDeepLink });

    // Set up application menu
    const appMenu = buildAppMenu(mainWindow);
    Menu.setApplicationMenu(appMenu);

    // Set up system tray
    createTray(mainWindow);

    // Set up auto-updater
    initAutoUpdater(mainWindow, {
      validateSender,
      prepareForInstall: async () => {
        updateInstallQuitStarted = false;
        updateInstallPrepared = await prepareRendererForQuit(mainWindow);
        return updateInstallPrepared;
      },
      onInstallPreparationFailed: () => {
        updateInstallPrepared = false;
        updateInstallQuitStarted = false;
      }
    });
  } catch (err) {
    dialog.showErrorBox('HTTP FreeKit — Startup Error', err.message);
    app.quit();
  }
});

if (hasSingleInstanceLock) app.on('window-all-closed', () => {
  app.quit();
});

if (hasSingleInstanceLock) app.on('activate', () => {
  if (mainWindow === null && apiPort) {
    createWindow();
  }
});
