const { Menu, shell, app, dialog } = require('electron');

/**
 * Build and return the application menu template.
 * @param {Electron.BrowserWindow} mainWindow
 * @returns {Electron.Menu}
 */
function buildAppMenu(mainWindow) {
  const isMac = process.platform === 'darwin';

  const macAppMenu = {
    label: app.name,
    submenu: [
      { role: 'about', label: `About ${app.name}` },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  };

  const fileMenu = {
    label: 'File',
    submenu: [
      {
        label: 'New Session',
        accelerator: 'CmdOrCtrl+Shift+N',
        click: () => {
          if (mainWindow) mainWindow.webContents.reload();
        }
      },
      { type: 'separator' },
      isMac
        ? { role: 'close' }
        : { role: 'quit', label: 'Quit', accelerator: 'Ctrl+Q' }
    ]
  };

  const editMenu = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'delete' },
      { type: 'separator' },
      { role: 'selectAll' }
    ]
  };

  const viewMenu = {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { type: 'separator' },
      { role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
      { role: 'zoomOut' },
      { role: 'resetZoom' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      { role: 'toggleDevTools' }
    ]
  };

  const helpMenu = {
    label: 'Help',
    submenu: [
      {
        label: 'Documentation',
        click: () => {
          shell.openExternal('https://github.com/nickthecook/http-freekit#readme');
        }
      },
      { type: 'separator' },
      {
        label: 'About HTTP FreeKit',
        click: () => {
          dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'About HTTP FreeKit',
            message: 'HTTP FreeKit',
            detail: `Version: ${app.getVersion()}\nElectron: ${process.versions.electron}\nChromium: ${process.versions.chrome}\nNode.js: ${process.versions.node}\nPlatform: ${process.platform} ${process.arch}`
          });
        }
      }
    ]
  };

  const template = [
    ...(isMac ? [macAppMenu] : []),
    fileMenu,
    editMenu,
    viewMenu,
    helpMenu
  ];

  return Menu.buildFromTemplate(template);
}

module.exports = { buildAppMenu };
