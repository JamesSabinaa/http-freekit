import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ElectronInterceptor } from '../../src/interceptors/electron-interceptor.js';

function createBundle(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-329-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundlePath = path.join(root, options.bundleName || 'Selected Electron.app');
  const contentsPath = path.join(bundlePath, 'Contents');
  const macOsPath = path.join(contentsPath, 'MacOS');
  const executableName = options.executableName || 'Selected Electron';
  fs.mkdirSync(macOsPath, { recursive: true });
  if (options.infoPlist !== false) {
    fs.writeFileSync(path.join(contentsPath, 'Info.plist'), '<plist></plist>');
  }
  const executablePath = path.join(macOsPath, executableName);
  if (options.executable !== false) {
    fs.writeFileSync(executablePath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(executablePath, 0o755);
  }
  return { root, bundlePath, contentsPath, macOsPath, executableName, executablePath };
}

function launchableInterceptor(executableName) {
  const interceptor = new ElectronInterceptor();
  interceptor._platform = () => 'darwin';
  interceptor._readMacBundleExecutable = () => executableName;
  interceptor.ca = {
    systemTrustInstalled: true,
    getTerminalCaBundlePath: () => process.execPath
  };
  return interceptor;
}

function fakeChild(pid = 329) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test('macOS bundle metadata is read with plutil using an argument array', async () => {
  const interceptor = new ElectronInterceptor();
  let invocation;
  interceptor._execFile = (command, args, options) => {
    invocation = { command, args, options };
    return Promise.resolve({ stdout: 'Electron Main\n', stderr: '' });
  };

  assert.equal(
    await interceptor._readMacBundleExecutable('/Applications/Test.app/Contents/Info.plist'),
    'Electron Main'
  );
  assert.equal(invocation.command, '/usr/bin/plutil');
  assert.deepEqual(invocation.args, [
    '-extract', 'CFBundleExecutable', 'raw', '-o', '-',
    '/Applications/Test.app/Contents/Info.plist'
  ]);
  assert.equal(invocation.options.shell, undefined);
});

test('macOS Electron bundle launch resolves and directly spawns its declared executable', async t => {
  const bundle = createBundle(t, {
    bundleName: 'Selected; $(unsafe).app',
    executableName: 'Electron Helper With Spaces'
  });
  const interceptor = launchableInterceptor(bundle.executableName);
  const child = fakeChild();
  let spawned;
  interceptor._spawn = (command, args, options) => {
    spawned = { command, args, options };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };

  const result = await interceptor.activate(8080, { appPath: bundle.bundlePath });

  assert.equal(result.pid, child.pid);
  assert.equal(spawned.command, fs.realpathSync(bundle.executablePath));
  assert.deepEqual(spawned.args, ['--proxy-server=http://127.0.0.1:8080']);
  assert.equal(spawned.options.detached, false);
  assert.equal(spawned.options.stdio, 'ignore');
  assert.equal(interceptor.active, true);
  assert.equal(interceptor.process, child);
});

test('ordinary executable commands and paths retain existing launch resolution', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-329-executable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executablePath = path.join(root, 'ordinary-electron');
  fs.writeFileSync(executablePath, 'binary');

  const interceptor = new ElectronInterceptor();
  interceptor._platform = () => 'darwin';
  assert.equal(await interceptor._resolveLaunchPath('electron-on-path'), 'electron-on-path');
  assert.equal(await interceptor._resolveLaunchPath('electron-on-path.app'), 'electron-on-path.app');
  assert.equal(await interceptor._resolveLaunchPath(executablePath), executablePath);

  const bundle = createBundle(t);
  interceptor._platform = () => 'win32';
  assert.equal(await interceptor._resolveLaunchPath(bundle.bundlePath), bundle.bundlePath);
});

test('macOS launch rejects non-bundle directories and .app files before spawning', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-329-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ordinaryDirectory = path.join(root, 'not-a-bundle');
  const appFile = path.join(root, 'fake.app');
  fs.mkdirSync(ordinaryDirectory);
  fs.writeFileSync(appFile, 'not a bundle');

  const interceptor = launchableInterceptor('Unused');
  let spawnCalls = 0;
  interceptor._spawn = () => {
    spawnCalls += 1;
    assert.fail('invalid paths must not spawn');
  };

  await assert.rejects(
    interceptor.activate(8080, { appPath: ordinaryDirectory }),
    /Failed to launch Electron app: Electron application path is a directory, not a macOS \.app bundle/
  );
  await assert.rejects(
    interceptor.activate(8080, { appPath: appFile }),
    /Failed to launch Electron app: macOS \.app selection is not an application bundle directory/
  );
  await assert.rejects(
    interceptor.activate(8080, { appPath: path.join(root, 'missing.app') }),
    /Failed to launch Electron app: macOS application bundle is unavailable/
  );
  assert.equal(spawnCalls, 0);
  assert.equal(interceptor.activating, false);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.process, null);
});

test('macOS bundle validation rejects missing structure, plist metadata, and executables', async t => {
  const missingMacOs = createBundle(t);
  fs.rmSync(missingMacOs.macOsPath, { recursive: true, force: true });
  const interceptor = launchableInterceptor(missingMacOs.executableName);
  await assert.rejects(
    interceptor._resolveLaunchPath(missingMacOs.bundlePath),
    /missing its Contents\/MacOS directory/
  );

  const missingPlist = createBundle(t, { infoPlist: false });
  interceptor._readMacBundleExecutable = () => missingPlist.executableName;
  await assert.rejects(
    interceptor._resolveLaunchPath(missingPlist.bundlePath),
    /missing Contents\/Info\.plist/
  );

  const missingExecutable = createBundle(t, { executable: false });
  interceptor._readMacBundleExecutable = () => missingExecutable.executableName;
  await assert.rejects(
    interceptor._resolveLaunchPath(missingExecutable.bundlePath),
    /bundle executable "Selected Electron" does not exist/
  );

  const unreadableMetadata = createBundle(t);
  interceptor._readMacBundleExecutable = () => {
    throw new Error('macOS application bundle has no readable CFBundleExecutable metadata');
  };
  await assert.rejects(
    interceptor._resolveLaunchPath(unreadableMetadata.bundlePath),
    /no readable CFBundleExecutable metadata/
  );
});

test('CFBundleExecutable cannot escape the bundle executable directory', async t => {
  const bundle = createBundle(t);
  const interceptor = launchableInterceptor('../outside-app');

  await assert.rejects(
    interceptor._resolveLaunchPath(bundle.bundlePath),
    /invalid CFBundleExecutable metadata/
  );

  interceptor._readMacBundleExecutable = () => '/tmp/outside-app';
  await assert.rejects(
    interceptor._resolveLaunchPath(bundle.bundlePath),
    /invalid CFBundleExecutable metadata/
  );
});
