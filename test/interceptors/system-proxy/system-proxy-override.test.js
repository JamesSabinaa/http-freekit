import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SystemProxyInterceptor } from '../../../src/interceptors/system-proxy-interceptor.js';

function makeDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-proxy-override-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function configureProcessIdentity(interceptor) {
  interceptor._processIdentityLookup = () => ({
    pid: process.pid,
    startedAt: '2026-01-02T03:04:05.000Z',
    executablePath: 'C:\\Program Files\\HTTP FreeKit\\freekit.exe'
  });
}

function configureWinHttp(interceptor) {
  let settings = {
    scope: 'user', proxy: '', proxyBypass: '', autoConfigUrl: '', autoDetect: true
  };
  interceptor._readWinHttpSettings = () => ({ ...settings });
  interceptor._setWinHttpSettings = next => { settings = { ...next }; };
}

test('registry snapshots distinguish missing, empty, and populated ProxyOverride values', async () => {
  const interceptor = new SystemProxyInterceptor();

  interceptor._execRegistry = () => `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable      REG_DWORD    0x1
    ProxyServer      REG_SZ       corporate.proxy:8080
    ProxyOverride    REG_SZ       intranet.example;<local>
    AutoConfigURL    REG_SZ       https://proxy.example.test/config.pac
    AutoDetect       REG_DWORD    0x1
`;
  assert.deepEqual(await interceptor._readCurrentSettings(), {
    enabled: true,
    server: 'corporate.proxy:8080',
    override: 'intranet.example;<local>',
    autoConfigUrl: 'https://proxy.example.test/config.pac',
    autoDetect: true
  });

  interceptor._execRegistry = () => `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyOverride    REG_SZ
    AutoConfigURL    REG_SZ
    AutoDetect       REG_DWORD    0x0
    MigrateProxy     REG_DWORD    0x1
`;
  assert.deepEqual(await interceptor._readCurrentSettings(), {
    enabled: false,
    server: null,
    override: '',
    autoConfigUrl: '',
    autoDetect: false
  });

  interceptor._execRegistry = () => `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    MigrateProxy     REG_DWORD    0x1
`;
  assert.equal((await interceptor._readCurrentSettings()).override, null);
});

test('registry snapshots keep empty ProxyServer values within their CRLF or LF row', async () => {
  const interceptor = new SystemProxyInterceptor();

  for (const lineEnding of ['\r\n', '\n']) {
    interceptor._execRegistry = () => [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '    ProxyEnable      REG_DWORD    0x1',
      '    ProxyServer      REG_SZ',
      '    ProxyOverride    REG_SZ       intranet.example;<local>',
      '    MigrateProxy     REG_DWORD    0x1',
      ''
    ].join(lineEnding);

    assert.deepEqual(await interceptor._readCurrentSettings(), {
      enabled: true,
      server: '',
      override: 'intranet.example;<local>',
      autoConfigUrl: null,
      autoDetect: null
    });
  }
});

test('registry snapshots still parse populated ProxyServer values with realistic spacing', async () => {
  const interceptor = new SystemProxyInterceptor();
  interceptor._execRegistry = () => [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    '\tProxyServer\tREG_SZ\tproxy.example.test:3128',
    '\tProxyOverride\tREG_SZ\t<local>',
    ''
  ].join('\r\n');

  assert.deepEqual(await interceptor._readCurrentSettings(), {
    enabled: false,
    server: 'proxy.example.test:3128',
    override: '<local>',
    autoConfigUrl: null,
    autoDetect: null
  });
});

test('activation disables WinINet automatic proxy discovery and Stop restores it exactly', async t => {
  const dataDir = makeDataDir(t);
  const previousSettings = {
    enabled: false,
    server: null,
    override: null,
    autoConfigUrl: 'https://corp.example.test/config.pac',
    autoDetect: true
  };
  const settings = { ...previousSettings };
  const operations = [];
  const interceptor = new SystemProxyInterceptor({
    dataDir,
    ca: { systemTrustInstalled: true }
  });
  interceptor._isWindows = () => true;
  interceptor._usesPerMachineProxyPolicy = () => false;
  configureProcessIdentity(interceptor);
  interceptor._readCurrentSettings = () => ({ ...settings });
  interceptor._setRegistryValue = (name, type, value) => {
    operations.push(['set', name, type, value]);
    if (name === 'ProxyEnable') settings.enabled = Boolean(value);
    if (name === 'ProxyServer') settings.server = value;
    if (name === 'ProxyOverride') settings.override = value;
    if (name === 'AutoConfigURL') settings.autoConfigUrl = value;
    if (name === 'AutoDetect') settings.autoDetect = Boolean(value);
  };
  interceptor._deleteRegistryValue = name => {
    operations.push(['delete', name]);
    if (name === 'ProxyServer') settings.server = null;
    if (name === 'ProxyOverride') settings.override = null;
    if (name === 'AutoConfigURL') settings.autoConfigUrl = null;
    if (name === 'AutoDetect') settings.autoDetect = null;
  };
  interceptor._notifyWinInet = () => operations.push(['notify']);
  configureWinHttp(interceptor);

  await interceptor.activate(8080);
  assert.deepEqual(settings, {
    enabled: true,
    server: '127.0.0.1:8080',
    override: '',
    autoConfigUrl: null,
    autoDetect: false
  });
  assert.deepEqual(operations, [
    ['delete', 'AutoConfigURL'],
    ['set', 'AutoDetect', 'REG_DWORD', 0],
    ['set', 'ProxyEnable', 'REG_DWORD', 1],
    ['set', 'ProxyServer', 'REG_SZ', '127.0.0.1:8080'],
    ['set', 'ProxyOverride', 'REG_SZ', ''],
    ['notify']
  ]);

  operations.length = 0;
  await interceptor.deactivate();
  assert.deepEqual(settings, previousSettings);
  assert.deepEqual(operations, [
    ['delete', 'ProxyServer'],
    ['delete', 'ProxyOverride'],
    ['set', 'ProxyEnable', 'REG_DWORD', 0],
    ['set', 'AutoConfigURL', 'REG_SZ', 'https://corp.example.test/config.pac'],
    ['set', 'AutoDetect', 'REG_DWORD', 1],
    ['notify']
  ]);
});

test('Stop restores an owned manual proxy while preserving newer PAC/WPAD settings', async t => {
  const dataDir = makeDataDir(t);
  const interceptor = new SystemProxyInterceptor({ dataDir });
  interceptor._isWindows = () => true;
  interceptor.active = true;
  interceptor.activeProxyServer = '127.0.0.1:8080';
  interceptor.previousSettings = {
    enabled: false,
    server: null,
    override: null,
    autoConfigUrl: 'https://old.example.test/config.pac',
    autoDetect: true
  };
  interceptor.pendingRecovery = {
    ownedSettings: {
      enabled: true,
      server: '127.0.0.1:8080',
      override: '',
      autoConfigUrl: null,
      autoDetect: false
    },
    previousSettings: interceptor.previousSettings
  };
  interceptor._persistRecoveryState(interceptor.pendingRecovery);
  const settings = {
    ...interceptor.pendingRecovery.ownedSettings,
    autoConfigUrl: 'https://new.example.test/config.pac'
  };
  const automaticOperations = [];
  interceptor._readCurrentSettings = () => ({ ...settings });
  interceptor._setRegistryValue = (name, _type, value) => {
    if (name === 'ProxyEnable') settings.enabled = Boolean(value);
    if (name === 'ProxyServer') settings.server = value;
    if (name === 'ProxyOverride') settings.override = value;
    if (name === 'AutoConfigURL') {
      automaticOperations.push(name);
      settings.autoConfigUrl = value;
    }
    if (name === 'AutoDetect') {
      automaticOperations.push(name);
      settings.autoDetect = Boolean(value);
    }
  };
  interceptor._deleteRegistryValue = name => {
    if (name === 'ProxyServer') settings.server = null;
    if (name === 'ProxyOverride') settings.override = null;
    if (name === 'AutoConfigURL' || name === 'AutoDetect') automaticOperations.push(name);
  };
  interceptor._notifyWinInet = () => {};

  await interceptor.deactivate();
  assert.deepEqual(settings, {
    enabled: false,
    server: null,
    override: null,
    autoConfigUrl: 'https://new.example.test/config.pac',
    autoDetect: false
  });
  assert.deepEqual(automaticOperations, []);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
  assert.equal(interceptor.active, false);
  assert.equal(interceptor.previousSettings, null);
  assert.equal(interceptor.pendingRecovery, null);
});

test('stale recovery narrows ownership before preserving later PAC/WPAD changes', async t => {
  const dataDir = makeDataDir(t);
  const previousSettings = {
    enabled: false,
    server: null,
    override: null,
    autoConfigUrl: 'https://old.example.test/config.pac',
    autoDetect: true
  };
  const ownedSettings = {
    enabled: true,
    server: '127.0.0.1:8080',
    override: '',
    autoConfigUrl: null,
    autoDetect: false
  };
  fs.writeFileSync(path.join(dataDir, 'system-proxy-recovery.json'), JSON.stringify({
    pid: 1234,
    proxyServer: ownedSettings.server,
    ownedSettings,
    previousSettings
  }));
  const settings = {
    ...ownedSettings,
    server: null,
    autoConfigUrl: 'https://newer.example.test/config.pac',
    autoDetect: false
  };
  const interceptor = new SystemProxyInterceptor({ dataDir });
  interceptor._isWindows = () => true;
  interceptor._isProcessRunning = () => false;
  interceptor._readCurrentSettings = () => ({ ...settings });
  const operations = [];
  const persistRecoveryState = interceptor._persistRecoveryState.bind(interceptor);
  interceptor._persistRecoveryState = (recovery, options) => {
    operations.push(['persist', recovery.preserveAutomaticSettings]);
    return persistRecoveryState(recovery, options);
  };
  interceptor._setRegistryValue = (name, _type, value) => {
    operations.push(['set', name]);
    if (name === 'ProxyEnable') settings.enabled = Boolean(value);
    if (name === 'ProxyServer') settings.server = value;
    if (name === 'ProxyOverride') settings.override = value;
    if (name === 'AutoConfigURL' || name === 'AutoDetect') {
      assert.fail('manual-only recovery must not write automatic settings');
    }
  };
  interceptor._deleteRegistryValue = name => {
    operations.push(['delete', name]);
    if (name === 'ProxyServer') settings.server = null;
    else if (name === 'ProxyOverride') settings.override = null;
    else assert.fail('manual-only recovery must not delete automatic settings');
  };
  interceptor._notifyWinInet = () => {};

  assert.equal(await interceptor.recoverStaleSettings(), true);
  assert.deepEqual(operations[0], ['persist', true]);
  assert.deepEqual(settings, {
    enabled: false,
    server: null,
    override: null,
    autoConfigUrl: 'https://newer.example.test/config.pac',
    autoDetect: false
  });
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
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
  configureProcessIdentity(interceptor);
  interceptor._readCurrentSettings = () => ({ ...settings });
  interceptor._setRegistryValue = (name, type, value) => {
    if (name === 'ProxyEnable') settings.enabled = Boolean(value);
    if (name === 'ProxyServer') settings.server = value;
    if (name === 'ProxyOverride') settings.override = value;
  };
  interceptor._notifyWinInet = () => {};
  configureWinHttp(interceptor);

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

test('restoration preserves the difference between absent and existing empty overrides', async () => {
  const missing = new SystemProxyInterceptor();
  const missingOperations = [];
  missing.previousSettings = { enabled: false, server: 'old.proxy:8080', override: null };
  missing._setRegistryValue = (...args) => missingOperations.push(['set', ...args]);
  missing._deleteRegistryValue = name => missingOperations.push(['delete', name]);
  missing._notifyWinInet = () => {};
  await missing._restorePreviousSettings();
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
  await empty._restorePreviousSettings();
  assert.deepEqual(emptyOperations, [
    ['set', 'ProxyServer', 'REG_SZ', 'old.proxy:8080'],
    ['set', 'ProxyOverride', 'REG_SZ', ''],
    ['set', 'ProxyEnable', 'REG_DWORD', 0]
  ]);
});

test('missing override deletion is idempotent but real registry failures propagate', async () => {
  const interceptor = new SystemProxyInterceptor();
  const denial = new Error('registry access denied');
  interceptor._execRegistry = () => { throw denial; };
  interceptor._readCurrentSettings = () => ({ enabled: false, server: null, override: null });
  await assert.doesNotReject(interceptor._deleteRegistryValue('ProxyOverride'));

  interceptor._readCurrentSettings = () => ({
    enabled: true,
    server: '127.0.0.1:8080',
    override: 'still-present.example'
  });
  await assert.rejects(interceptor._deleteRegistryValue('ProxyOverride'), /registry access denied/);
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
  configureProcessIdentity(interceptor);
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
  configureWinHttp(interceptor);

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

test('stale recovery restores complete and partial owned state but preserves external changes', async t => {
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

  assert.equal(await owned.recoverStaleSettings(), true);
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

  assert.equal(await partial.recoverStaleSettings(), true);
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

  assert.equal(await external.recoverStaleSettings(), false);
  assert.equal(fs.existsSync(externalRecoveryFile), false);
});

test('stale recovery rejects old-owned mixtures outside every write-order prefix', async t => {
  const dataDir = makeDataDir(t);
  const recoveryFile = path.join(dataDir, 'system-proxy-recovery.json');
  fs.writeFileSync(recoveryFile, JSON.stringify({
    pid: 1234,
    proxyServer: '127.0.0.1:8080',
    ownedSettings: { enabled: true, server: '127.0.0.1:8080', override: '' },
    previousSettings: { enabled: false, server: 'old.proxy:8080', override: null }
  }));
  const interceptor = new SystemProxyInterceptor({ dataDir });
  interceptor._isWindows = () => true;
  interceptor._isProcessRunning = () => false;
  interceptor._readCurrentSettings = () => ({
    enabled: false,
    server: '127.0.0.1:8080',
    override: ''
  });
  interceptor._setRegistryValue = () => assert.fail('an impossible mixed state must be preserved');
  interceptor._deleteRegistryValue = () => assert.fail('an impossible mixed state must be preserved');
  interceptor._notifyWinInet = () => assert.fail('an impossible mixed state must not be announced');

  assert.equal(await interceptor.recoverStaleSettings(), false);
  assert.equal(fs.existsSync(recoveryFile), false);
});

test('stale recovery restores reachable PAC/WPAD prefixes and preserves external divergence', async t => {
  const previousSettings = {
    enabled: false,
    server: null,
    override: null,
    autoConfigUrl: 'https://corp.example.test/config.pac',
    autoDetect: true
  };
  const ownedSettings = {
    enabled: true,
    server: '127.0.0.1:8080',
    override: '',
    autoConfigUrl: null,
    autoDetect: false
  };
  const createRecovery = dataDir => fs.writeFileSync(
    path.join(dataDir, 'system-proxy-recovery.json'),
    JSON.stringify({
      pid: 1234,
      proxyServer: ownedSettings.server,
      ownedSettings,
      previousSettings
    })
  );

  const partialDataDir = makeDataDir(t);
  createRecovery(partialDataDir);
  const partialSettings = {
    ...previousSettings,
    autoConfigUrl: null
  };
  const partial = new SystemProxyInterceptor({ dataDir: partialDataDir });
  partial._isWindows = () => true;
  partial._isProcessRunning = () => false;
  partial._readCurrentSettings = () => ({ ...partialSettings });
  partial._setRegistryValue = (name, type, value) => {
    if (name === 'ProxyEnable') partialSettings.enabled = Boolean(value);
    if (name === 'ProxyServer') partialSettings.server = value;
    if (name === 'ProxyOverride') partialSettings.override = value;
    if (name === 'AutoConfigURL') partialSettings.autoConfigUrl = value;
    if (name === 'AutoDetect') partialSettings.autoDetect = Boolean(value);
  };
  partial._deleteRegistryValue = name => {
    if (name === 'ProxyServer') partialSettings.server = null;
    if (name === 'ProxyOverride') partialSettings.override = null;
    if (name === 'AutoConfigURL') partialSettings.autoConfigUrl = null;
    if (name === 'AutoDetect') partialSettings.autoDetect = null;
  };
  partial._notifyWinInet = () => {};

  assert.equal(await partial.recoverStaleSettings(), true);
  assert.deepEqual(partialSettings, previousSettings);

  const divergentDataDir = makeDataDir(t);
  const divergentRecoveryFile = path.join(divergentDataDir, 'system-proxy-recovery.json');
  createRecovery(divergentDataDir);
  const divergentSettings = {
    ...ownedSettings,
    autoConfigUrl: previousSettings.autoConfigUrl
  };
  const divergent = new SystemProxyInterceptor({ dataDir: divergentDataDir });
  divergent._isWindows = () => true;
  divergent._isProcessRunning = () => false;
  divergent._readCurrentSettings = () => ({ ...divergentSettings });
  divergent._setRegistryValue = (name, _type, value) => {
    if (name === 'ProxyEnable') divergentSettings.enabled = Boolean(value);
    else if (name === 'ProxyServer') divergentSettings.server = value;
    else if (name === 'ProxyOverride') divergentSettings.override = value;
    else assert.fail('external PAC/WPAD settings must not be replaced');
  };
  divergent._deleteRegistryValue = name => {
    if (name === 'ProxyServer') divergentSettings.server = null;
    else if (name === 'ProxyOverride') divergentSettings.override = null;
    else assert.fail('external PAC/WPAD settings must not be deleted');
  };
  divergent._notifyWinInet = () => {};

  assert.equal(await divergent.recoverStaleSettings(), true);
  assert.deepEqual(divergentSettings, {
    ...previousSettings,
    autoDetect: false
  });
  assert.equal(fs.existsSync(divergentRecoveryFile), false);
});
