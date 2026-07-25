const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
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

let mainWindow = null;
let serverProcess = null;
let apiPort = null;
let isShuttingDown = false;
let serverReady = false;
let quitCleanupComplete = false;
let quitCleanupPromise = null;
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
 * Poll the server until it responds to HTTP requests.
 */
function waitForServer(port, proc, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let done = false;

    // If the server process exits before responding, fail immediately
    proc.on('exit', (code) => {
      if (!done) {
        done = true;
        reject(new Error(`Server process exited with code ${code} before becoming ready`));
      }
    });

    function poll() {
      if (done) return;
      if (Date.now() - start > timeoutMs) {
        done = true;
        return reject(new Error(`Server did not start within ${timeoutMs}ms`));
      }
      const req = http.get(`http://127.0.0.1:${port}/api/config`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
      }, (res) => {
        res.resume();
        if (!done) { done = true; resolve(); }
      });
      req.on('error', () => { if (!done) setTimeout(poll, 200); });
      req.setTimeout(2000, () => {
        req.destroy();
        if (!done) setTimeout(poll, 200);
      });
    }
    poll();
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
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n--- Server starting at ${new Date().toISOString()} (port ${apiPort}) ---\n`);

  // Server files are in app.asar.unpacked (via asarUnpack config)
  let serverScript = path.join(__dirname, '..', 'src', 'index.js');
  if (serverScript.includes('app.asar')) {
    serverScript = serverScript.replace('app.asar', 'app.asar.unpacked');
  }

  serverProcess = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      API_PORT: String(apiPort),
      AUTH_TOKEN: authToken,
      ELECTRON: '1',
      HTTP_FREEKIT_MCP_EXECUTABLE: resolveDesktopMcpExecutable({ isPackaged: app.isPackaged }),
      HTTP_FREEKIT_MCP_PACKAGED_APP: app.isPackaged ? '1' : '0',
      HTTP_FREEKIT_MCP_DESCRIPTOR_PATH: path.join(app.getPath('userData'), 'mcp-runtime.json')
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.dirname(serverScript)
  });

  serverProcess.stdout.pipe(logStream);
  serverProcess.stderr.pipe(logStream);

  serverProcess.on('error', (err) => {
    logStream.write(`--- Server error: ${err.message} ---\n`);
  });

  serverProcess.on('exit', (code, signal) => {
    const msg = `Server exited (code=${code}, signal=${signal})`;
    logStream.write(`--- ${msg} at ${new Date().toISOString()} ---\n`);
    serverProcess = null;
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

  await waitForServer(apiPort, serverProcess);
  serverReady = true;
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
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function reportDeepLinkError(err) {
  const message = err?.message || String(err);
  if (app.isReady()) {
    dialog.showErrorBox('HTTP FreeKit — Could Not Open Link', message);
  } else {
    console.error('[Deep Link]', message);
  }
}

function requestOpenInProxiedChrome(url) {
  return new Promise((resolve, reject) => {
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
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const responseText = Buffer.concat(chunks).toString('utf8');
        let response = {};
        try { response = responseText ? JSON.parse(responseText) : {}; } catch {}

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(response);
        } else {
          reject(new Error(response.error || `Server returned HTTP ${res.statusCode}`));
        }
      });
    });

    req.once('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Timed out opening the link')));
    req.end(body);
  });
}

function scheduleDeepLink(targetUrl) {
  deepLinkProcessing = deepLinkProcessing
    .then(() => requestOpenInProxiedChrome(targetUrl))
    .catch(reportDeepLinkError);
}

function handleDeepLink(value) {
  let targetUrl;
  try {
    targetUrl = parseOpenDeepLink(value);
  } catch (err) {
    reportDeepLinkError(err);
    return;
  }

  if (!serverReady) {
    pendingDeepLinks.push(targetUrl);
    return;
  }
  scheduleDeepLink(targetUrl);
}

function flushPendingDeepLinks() {
  for (const targetUrl of pendingDeepLinks.splice(0)) {
    scheduleDeepLink(targetUrl);
  }
}

/**
 * Gracefully shut down the server process.
 * Sends POST /api/shutdown, then force-kills after 3 seconds.
 */
function shutdownServer() {
  return new Promise((resolve) => {
    if (!serverProcess) return resolve();

    isShuttingDown = true;
    const proc = serverProcess;

    // Force-kill after 3 seconds
    const timeout = setTimeout(() => {
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
      }
      resolve();
    }, 3000);

    // Resolve when the process exits
    proc.on('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    // Send POST /api/shutdown to trigger graceful exit
    const req = http.request({
      hostname: '127.0.0.1',
      port: apiPort,
      path: '/api/shutdown',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      }
    });
    req.on('error', () => {
      // Server may already be down — force-kill timeout will handle it
    });
    req.end();
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

  windowState.manage(mainWindow);

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

  mainWindow.loadURL(`http://127.0.0.1:${apiPort}/?authToken=${authToken}`);

  if (showOnReady) {
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
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
  app.relaunch();
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

if (hasSingleInstanceLock) app.on('before-quit', (event) => {
  if (quitCleanupComplete) return;
  event.preventDefault();
  if (quitCleanupPromise) return;

  isShuttingDown = true;
  quitCleanupPromise = Promise.resolve()
    .then(() => {
      stopAutoUpdater();
      destroyTray();
      return shutdownServer();
    })
    .catch(err => {
      console.error('[Electron] Shutdown cleanup failed:', err.message);
    })
    .finally(() => {
      quitCleanupComplete = true;
      app.quit();
    });
});

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  try {
    registerProtocolHandler();
    await startServer();

    const startupDeepLink = findDeepLinkArg(process.argv);
    const launchedFromDeepLink = !!startupDeepLink || pendingDeepLinks.length > 0;
    createWindow({ showOnReady: !launchedFromDeepLink });
    if (startupDeepLink) handleDeepLink(startupDeepLink);
    flushPendingDeepLinks();

    // Set up application menu
    const appMenu = buildAppMenu(mainWindow);
    Menu.setApplicationMenu(appMenu);

    // Set up system tray
    createTray(mainWindow);

    // Set up auto-updater
    initAutoUpdater(mainWindow, { validateSender });
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
