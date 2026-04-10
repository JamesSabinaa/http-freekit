const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
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

let mainWindow = null;
let serverProcess = null;
let apiPort = null;
let isShuttingDown = false;
const authToken = crypto.randomBytes(32).toString('hex');

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
function waitForServer(port, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function poll() {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Server did not start within ${timeoutMs}ms`));
      }
      const req = http.get(`http://127.0.0.1:${port}/api/config`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => setTimeout(poll, 200));
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(poll, 200);
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

  const serverScript = path.join(__dirname, '..', 'src', 'index.js');

  serverProcess = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      API_PORT: String(apiPort),
      AUTH_TOKEN: authToken,
      ELECTRON: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
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

    // If server exits unexpectedly, notify and quit
    if (!isShuttingDown && mainWindow) {
      dialog.showErrorBox(
        'HTTP FreeKit',
        'The server process has unexpectedly exited. The application will now close.'
      );
      app.quit();
    }
  });

  await waitForServer(apiPort);
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
      headers: { 'Content-Type': 'application/json' }
    });
    req.on('error', () => {
      // Server may already be down — force-kill timeout will handle it
    });
    req.end();
  });
}

function createWindow() {
  const windowState = windowStateKeeper({
    defaultWidth: 1366,
    defaultHeight: 768
  });

  mainWindow = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: 700,
    minHeight: 600,
    show: false,
    title: 'HTTP FreeKit',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  windowState.manage(mainWindow);

  mainWindow.loadURL(`http://127.0.0.1:${apiPort}/?authToken=${authToken}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// IPC handlers — invoked from the renderer via the preload contextBridge
// ---------------------------------------------------------------------------

/** Validate that the IPC call originates from the expected local server URL. */
function validateSender(event) {
  const url = event.senderFrame?.url || '';
  return url.startsWith(`http://127.0.0.1:${apiPort}`);
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
  app.exit(0);
});

app.whenReady().then(async () => {
  try {
    await startServer();
    createWindow();

    // Set up application menu
    const appMenu = buildAppMenu(mainWindow);
    Menu.setApplicationMenu(appMenu);

    // Set up system tray
    createTray(mainWindow);

    // Set up auto-updater
    initAutoUpdater(mainWindow);
  } catch (err) {
    dialog.showErrorBox('HTTP FreeKit — Startup Error', err.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  stopAutoUpdater();
  destroyTray();
  shutdownServer().then(() => app.quit());
});

app.on('activate', () => {
  if (mainWindow === null && apiPort) {
    createWindow();
  }
});
