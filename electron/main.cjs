const { app, BrowserWindow } = require('electron');
const path = require('path');
const windowStateKeeper = require('electron-window-state');

const API_PORT = parseInt(process.env.API_PORT) || 8001;

let mainWindow = null;

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
      contextIsolation: true
    }
  });

  windowState.manage(mainWindow);

  mainWindow.loadURL(`http://127.0.0.1:${API_PORT}/`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
