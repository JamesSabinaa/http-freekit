import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  GENERATOR_LAUNCH_SCRIPT,
  getGeneratorLaunchExecutable,
  resolveGeneratorRuntime,
  waitForGeneratorWindow
} from '../../src/api/generator-launch.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'freekit-generator-launch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function childFixture(t, script, args = []) {
  const child = spawn(process.execPath, ['-e', script, ...args], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  return child;
}

test('windowed launch stays in the resolved interpreter directory', async t => {
  const root = await fixture(t);
  const consolePython = path.join(root, 'python.exe');
  const windowedPython = path.join(root, 'pythonw.exe');
  assert.equal(await getGeneratorLaunchExecutable(consolePython, 'win32'), consolePython);
  await fs.writeFile(windowedPython, 'fixture');
  assert.equal(await getGeneratorLaunchExecutable(consolePython, 'win32'), windowedPython);
  assert.equal(await getGeneratorLaunchExecutable(consolePython, 'linux'), consolePython);
});

test('spawning a process alone does not confirm a Generator window', async t => {
  const root = await fixture(t);
  const ready = path.join(root, 'ready.json');
  const log = path.join(root, 'startup.log');
  const child = childFixture(t, `
    const fs = require('fs');
    setTimeout(() => fs.writeFileSync(process.argv[1], JSON.stringify({ready:true,pid:process.pid})), 180);
    setInterval(() => {}, 1000);
  `, [ready]);
  let confirmed = false;
  const startup = waitForGeneratorWindow(child, ready, log, 3000).then(() => { confirmed = true; });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(confirmed, false);
  await startup;
  assert.equal(confirmed, true);
});

test('startup import failure is reported instead of successful spawn', async t => {
  const root = await fixture(t);
  const log = path.join(root, 'startup.log');
  const child = childFixture(t, `
    require('fs').writeFileSync(process.argv[1], "ModuleNotFoundError: No module named 'PySide6'");
    process.exit(1);
  `, [log]);
  await assert.rejects(
    waitForGeneratorWindow(child, path.join(root, 'ready.json'), log, 3000),
    /exited before opening.*\nModuleNotFoundError: No module named 'PySide6'/
  );
});

test('a startup without a window times out and terminates its owned process', async t => {
  const root = await fixture(t);
  const child = childFixture(t, 'setInterval(() => {}, 1000)');
  await assert.rejects(waitForGeneratorWindow(
    child, path.join(root, 'ready.json'), path.join(root, 'startup.log'), 120
  ), /did not open its window/);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('a readiness file from another process does not confirm startup', async t => {
  const root = await fixture(t);
  const ready = path.join(root, 'ready.json');
  await fs.writeFile(ready, JSON.stringify({ ready: true, pid: -1 }));
  const child = childFixture(t, 'setInterval(() => {}, 1000)');
  await assert.rejects(waitForGeneratorWindow(
    child, ready, path.join(root, 'startup.log'), 120
  ), /did not open its window/);
});

// Exercise the embedded Python against a tiny Qt-compatible application. The
// readiness protocol tests above run even on hosts without Python installed.
const python = ['python3', 'python', 'py'].find(command => {
  return spawnSync(command, ['-c', 'import sys'], { windowsHide: true, timeout: 2000 }).status === 0;
});

test('the Python wrapper acknowledges a shown window after the event loop starts', async t => {
  if (!python) return t.skip('Python is unavailable');
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'PySide6'));
  await fs.mkdir(path.join(root, 'bottingtools'));
  await fs.writeFile(path.join(root, 'PySide6', '__init__.py'), '');
  await fs.writeFile(path.join(root, 'bottingtools', '__init__.py'), '');
  await fs.writeFile(path.join(root, 'PySide6', 'QtCore.py'), `
callbacks = []
class QTimer:
    @staticmethod
    def singleShot(delay, callback): callbacks.append(callback)
`);
  await fs.writeFile(path.join(root, 'PySide6', 'QtWidgets.py'), `
from .QtCore import callbacks
class Window:
    def isVisible(self): return True
    def isWindow(self): return True
    def raise_(self): pass
    def activateWindow(self): pass
class QApplication:
    @staticmethod
    def topLevelWidgets(): return [Window()]
    @staticmethod
    def exec():
        for callback in callbacks: callback()
        return 0
`);
  await fs.writeFile(path.join(root, 'config.py'), 'HARS_BASE_DIR = "hars"\ndef load_config(): pass\n');
  await fs.writeFile(path.join(root, 'main_app.py'), `
from PySide6.QtWidgets import QApplication
assert __name__ == '__main__'
assert __import__('sys').argv[1:] == ['--session', 'test-session']
QApplication().exec()
`);
  const runtime = await resolveGeneratorRuntime([
    { command: path.join(root, 'missing-python'), args: [] },
    { command: python, args: ['-I', '-S'] }, // A runtime without Generator's dependencies.
    { command: python, args: [] }
  ], { cwd: root });
  assert.equal(runtime.harsBaseDir, 'hars');
  assert.ok(path.isAbsolute(runtime.executable));
  const ready = path.join(root, 'ready.json');
  const log = path.join(root, 'startup.log');
  const result = spawnSync(runtime.executable, [
    '-c', GENERATOR_LAUNCH_SCRIPT, ready, log, path.join(root, 'main_app.py'), '--session', 'test-session'
  ], { cwd: root, windowsHide: true, timeout: 3000 });
  assert.equal(result.status, 0, await fs.readFile(log, 'utf8'));
  assert.equal(JSON.parse(await fs.readFile(ready, 'utf8')).ready, true);
});
