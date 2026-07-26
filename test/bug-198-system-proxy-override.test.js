import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SystemProxyInterceptor } from '../src/interceptors/system-proxy-interceptor.js';

function makeDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-proxy-override-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

test('registry snapshots distinguish missing, empty, and populated ProxyOverride values', () => {
  const interceptor = new SystemProxyInterceptor();

  interceptor._execRegistry = () => `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable      REG_DWORD    0x1
    ProxyServer      REG_SZ       corporate.proxy:8080
    ProxyOverride    REG_SZ       intranet.example;<local>
`;
  assert.deepEqual(interceptor._readCurrentSettings(), {
    enabled: true,
    server: 'corporate.proxy:8080',
    override: 'intranet.example;<local>'
  });

  interceptor._execRegistry = () => `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyOverride    REG_SZ
    MigrateProxy     REG_DWORD    0x1
`;
  assert.deepEqual(interceptor._readCurrentSettings(), {
    enabled: false,
    server: null,
    override: ''
  });

  interceptor._execRegistry = () => `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    MigrateProxy     REG_DWORD    0x1
`;
  assert.equal(interceptor._readCurrentSettings().override, null);
});

test('activation clears bypasses and normal Stop restores the exact populated value', async t => {
  const dataDir = makeDataDir(t);
  const settings = {
    enabled: true,
    server: 'corporate.proxy:8080',
    override: 'intranet.example;<local>'
  };
  const interceptor = new SystemProxyInterceptor({
    dataDir,
    ca: { systemTrustInstalled: true }
  });
  interceptor._isWindows = () => true;
  interceptor._usesPerMachineProxyPolicy = () => false;
  interceptor._readCurrentSettings = () => ({ ...settings });
  interceptor._setRegistryValue = (name, type, value) => {
    if (name === 'ProxyEnable') settings.enabled = Boolean(value);
    if (name === 'ProxyServer') settings.server = value;
    if (name === 'ProxyOverride') settings.override = value;
  };
  interceptor._notifyWinInet = () => {};

  await interceptor.activate(8080);
  assert.deepEqual(settings, {
    enabled: true,
    server: '127.0.0.1:8080',
    override: ''
  });

  const recovery = JSON.parse(fs.readFileSync(interceptor.recoveryFile, 'utf8'));
  assert.deepEqual(recovery.previousSettings, {
    enabled: true,
    server: 'corporate.proxy:8080',
    override: 'intranet.example;<local>'
  });

  await interceptor.deactivate();
  assert.deepEqual(settings, {
    enabled: true,
    server: 'corporate.proxy:8080',
    override: 'intranet.example;<local>'
  });
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});

test('restoration preserves the difference between absent and existing empty overrides', () => {
  const missing = new SystemProxyInterceptor();
  const missingOperations = [];
  missing.previousSettings = { enabled: false, server: 'old.proxy:8080', override: null };
  missing._setRegistryValue = (...args) => missingOperations.push(['set', ...args]);
  missing._deleteRegistryValue = name => missingOperations.push(['delete', name]);
  missing._notifyWinInet = () => {};
  missing._restorePreviousSettings();
  assert.deepEqual(missingOperations, [
    ['set', 'ProxyServer', 'REG_SZ', 'old.proxy:8080'],
    ['delete', 'ProxyOverride'],
    ['set', 'ProxyEnable', 'REG_DWORD', 0]
  ]);

  const empty = new SystemProxyInterceptor();
  const emptyOperations = [];
  empty.previousSettings = { enabled: false, server: 'old.proxy:8080', override: '' };
  empty._setRegistryValue = (...args) => emptyOperations.push(['set', ...args]);
  empty._deleteRegistryValue = name => emptyOperations.push(['delete', name]);
  empty._notifyWinInet = () => {};
  empty._restorePreviousSettings();
  assert.deepEqual(emptyOperations, [
    ['set', 'ProxyServer', 'REG_SZ', 'old.proxy:8080'],
    ['set', 'ProxyOverride', 'REG_SZ', ''],
    ['set', 'ProxyEnable', 'REG_DWORD', 0]
  ]);
});

test('missing override deletion is idempotent but real registry failures propagate', () => {
  const interceptor = new SystemProxyInterceptor();
  const denial = new Error('registry access denied');
  interceptor._execRegistry = () => { throw denial; };
  interceptor._readCurrentSettings = () => ({ enabled: false, server: null, override: null });
  assert.doesNotThrow(() => interceptor._deleteRegistryValue('ProxyOverride'));

  interceptor._readCurrentSettings = () => ({
    enabled: true,
    server: '127.0.0.1:8080',
    override: 'still-present.example'
  });
  assert.throws(() => interceptor._deleteRegistryValue('ProxyOverride'), /registry access denied/);
});

test('activation failure rolls back a previously missing bypass value', async t => {
  const dataDir = makeDataDir(t);
  const settings = { enabled: false, server: 'old.proxy:8080', override: null };
  let failed = false;
  const interceptor = new SystemProxyInterceptor({
    dataDir,
    ca: { systemTrustInstalled: true }
  });
  interceptor._isWindows = () => true;
  interceptor._usesPerMachineProxyPolicy = () => false;
  interceptor._readCurrentSettings = () => ({ ...settings });
  interceptor._setRegistryValue = (name, type, value) => {
    if (name === 'ProxyOverride' && value === '' && !failed) {
      failed = true;
      throw new Error('override write failed');
    }
    if (name === 'ProxyEnable') settings.enabled = Boolean(value);
    if (name === 'ProxyServer') settings.server = value;
    if (name === 'ProxyOverride') settings.override = value;
  };
  interceptor._deleteRegistryValue = name => {
    assert.equal(name, 'ProxyOverride');
    settings.override = null;
  };
  interceptor._notifyWinInet = () => {};

  await assert.rejects(interceptor.activate(8080), /override write failed/);
  assert.deepEqual(settings, { enabled: false, server: 'old.proxy:8080', override: null });
  assert.equal(interceptor.previousSettings, null);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});

test('Stop preserves an external ProxyOverride change even when the proxy endpoint is unchanged', async () => {
  const interceptor = new SystemProxyInterceptor();
  interceptor._isWindows = () => true;
  interceptor.active = true;
  interceptor.activeProxyServer = '127.0.0.1:8080';
  interceptor.previousSettings = {
    enabled: true,
    server: 'corporate.proxy:8080',
    override: 'old-bypass.example'
  };
  interceptor._readCurrentSettings = () => ({
    enabled: true,
    server: '127.0.0.1:8080',
    override: 'new-vpn-bypass.example'
  });
  interceptor._setRegistryValue = () => assert.fail('external settings must not be overwritten');

  await interceptor.deactivate();
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.previousSettings, null);
});

test('stale recovery restores complete and partial owned state but preserves external changes', t => {
  const ownedDataDir = makeDataDir(t);
  const ownedRecoveryFile = path.join(ownedDataDir, 'system-proxy-recovery.json');
  fs.writeFileSync(ownedRecoveryFile, JSON.stringify({
    pid: 1234,
    proxyServer: '127.0.0.1:8080',
    ownedSettings: { enabled: true, server: '127.0.0.1:8080', override: '' },
    previousSettings: {
      enabled: true,
      server: 'corporate.proxy:8080',
      override: 'intranet.example;<local>'
    }
  }));
  const ownedWrites = [];
  const owned = new SystemProxyInterceptor({ dataDir: ownedDataDir });
  owned._isWindows = () => true;
  owned._isProcessRunning = () => false;
  owned._readCurrentSettings = () => ({ enabled: true, server: '127.0.0.1:8080', override: '' });
  owned._setRegistryValue = (...args) => ownedWrites.push(args);
  owned._notifyWinInet = () => {};

  assert.equal(owned.recoverStaleSettings(), true);
  assert.deepEqual(ownedWrites, [
    ['ProxyServer', 'REG_SZ', 'corporate.proxy:8080'],
    ['ProxyOverride', 'REG_SZ', 'intranet.example;<local>'],
    ['ProxyEnable', 'REG_DWORD', 1]
  ]);

  const partialDataDir = makeDataDir(t);
  fs.writeFileSync(path.join(partialDataDir, 'system-proxy-recovery.json'), JSON.stringify({
    pid: 1234,
    proxyServer: '127.0.0.1:8080',
    ownedSettings: { enabled: true, server: '127.0.0.1:8080', override: '' },
    previousSettings: { enabled: false, server: 'old.proxy:8080', override: null }
  }));
  const partialOperations = [];
  const partial = new SystemProxyInterceptor({ dataDir: partialDataDir });
  partial._isWindows = () => true;
  partial._isProcessRunning = () => false;
  // Crash after ProxyEnable and ProxyServer changed, but before ProxyOverride.
  partial._readCurrentSettings = () => ({
    enabled: true,
    server: '127.0.0.1:8080',
    override: null
  });
  partial._setRegistryValue = (...args) => partialOperations.push(['set', ...args]);
  partial._deleteRegistryValue = name => partialOperations.push(['delete', name]);
  partial._notifyWinInet = () => {};

  assert.equal(partial.recoverStaleSettings(), true);
  assert.deepEqual(partialOperations, [
    ['set', 'ProxyServer', 'REG_SZ', 'old.proxy:8080'],
    ['delete', 'ProxyOverride'],
    ['set', 'ProxyEnable', 'REG_DWORD', 0]
  ]);

  const externalDataDir = makeDataDir(t);
  const externalRecoveryFile = path.join(externalDataDir, 'system-proxy-recovery.json');
  fs.writeFileSync(externalRecoveryFile, JSON.stringify({
    pid: 1234,
    proxyServer: '127.0.0.1:8080',
    ownedSettings: { enabled: true, server: '127.0.0.1:8080', override: '' },
    previousSettings: { enabled: false, server: null, override: null }
  }));
  const external = new SystemProxyInterceptor({ dataDir: externalDataDir });
  external._isWindows = () => true;
  external._isProcessRunning = () => false;
  external._readCurrentSettings = () => ({
    enabled: true,
    server: '127.0.0.1:8080',
    override: 'new-vpn-bypass.example'
  });
  external._setRegistryValue = () => assert.fail('external override must not be overwritten');

  assert.equal(external.recoverStaleSettings(), false);
  assert.equal(fs.existsSync(externalRecoveryFile), false);
});
