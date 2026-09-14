import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const mainSource = fs.readFileSync('electron/main.cjs', 'utf8');
const menuSource = fs.readFileSync('electron/menu.cjs', 'utf8');
const start = mainSource.indexOf('function restoreWindowAfterFailedQuit(');
const end = mainSource.indexOf('function createWindow(', start);
assert.ok(start >= 0 && end > start);

for (const platform of ['win32', 'linux', 'darwin']) {
  for (const destroyed of [true, false]) {
    test(`${platform}: menu actions target the ${destroyed ? 'replacement' : 'surviving'} window after failed quit`, async () => {
      const calls = { reload: [], close: [], dialogs: [], errors: [], created: 0 };
      function makeWindow(isDestroyed) {
        const window = {
          isDestroyed: () => isDestroyed,
          close() {
            assert.equal(isDestroyed, false, 'must not close a destroyed window');
            calls.close.push(window);
          },
          webContents: {
            reload() {
              assert.equal(isDestroyed, false, 'must not reload a destroyed window');
              calls.reload.push(window);
            }
          }
        };
        return window;
      }
      let installedMenu;
      const electron = {
        Menu: {
          buildFromTemplate: template => template,
          setApplicationMenu: menu => { installedMenu = menu; }
        },
        app: { name: 'HTTP FreeKit', getVersion: () => '1.0.0' },
        shell: { openExternal: async () => { throw new Error('Browser unavailable'); } },
        dialog: {
          showMessageBox: async (window, options) => {
            assert.equal(window.isDestroyed(), false);
            calls.dialogs.push({ window, options });
          },
          showErrorBox: (...args) => calls.errors.push(args)
        }
      };
      const context = vm.createContext({
        require: name => { assert.equal(name, 'electron'); return electron; },
        module: { exports: {} },
        process: { platform, arch: process.arch, versions: process.versions },
        mainWindow: makeWindow(destroyed),
        Menu: electron.Menu,
        dialog: electron.dialog,
        createWindow() { calls.created++; context.mainWindow = makeWindow(false); },
        showMainWindow() {},
        destroyTray() {},
        createTray() {},
        initAutoUpdater() {},
        validateSender() {}
      });
      vm.runInContext(menuSource, context);
      vm.runInContext(mainSource.slice(start, end), context);
      electron.Menu.setApplicationMenu(context.buildAppMenu(context.mainWindow));
      context.restoreWindowAfterFailedQuit(new Error('Cleanup failed'));

      const action = (menu, label) => installedMenu.find(item => item.label === menu)
        .submenu.find(item => item.label === label);
      action('View', 'Reload').click();
      await action('Help', 'About HTTP FreeKit').click();
      await action('Help', 'Documentation').click();
      if (platform === 'darwin') {
        action('File', 'Close Window').click();
        assert.deepEqual(calls.close, [context.mainWindow]);
      }
      assert.deepEqual(calls.reload, [context.mainWindow]);
      assert.equal(calls.dialogs.length, 2);
      assert.ok(calls.dialogs.every(call => call.window === context.mainWindow));
      assert.equal(calls.created, destroyed ? 1 : 0);
      assert.equal(calls.errors.length, 1);
      assert.match(calls.errors[0][1], /Cleanup failed/);
    });
  }
}
