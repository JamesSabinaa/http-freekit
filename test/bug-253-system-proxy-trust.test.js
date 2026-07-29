import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { InterceptorManager } from '../src/interceptors/interceptor-manager.js';
import { SystemProxyInterceptor } from '../src/interceptors/system-proxy-interceptor.js';

function createDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-system-trust-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function configureRegistry(interceptor, initialSettings) {
  const settings = { ...initialSettings };
  const operations = [];
  interceptor._isWindows = () => true;
  interceptor._usesPerMachineProxyPolicy = () => false;
  interceptor._processIdentityLookup = () => ({
    pid: process.pid,
    startedAt: '2026-01-02T03:04:05.000Z',
    executablePath: 'C:\\Program Files\\HTTP FreeKit\\freekit.exe'
  });
  interceptor._readCurrentSettings = () => ({ ...settings });
  interceptor._setRegistryValue = (name, type, value) => {
    operations.push(['set', name, type, value]);
    if (name === 'ProxyEnable') settings.enabled = Number(value) !== 0;
    if (name === 'ProxyServer') settings.server = String(value);
    if (name === 'ProxyOverride') settings.override = String(value);
  };
  interceptor._deleteRegistryValue = name => {
    operations.push(['delete', name]);
    if (name === 'ProxyServer') settings.server = null;
    if (name === 'ProxyOverride') settings.override = null;
  };
  interceptor._execRegistry = args => {
    const name = args[3];
    operations.push(['delete', name]);
    if (name === 'ProxyServer') settings.server = null;
    if (name === 'ProxyOverride') settings.override = null;
  };
  interceptor._notifyWinInet = () => operations.push(['notify']);
  return { operations, settings };
}

test('Windows System Proxy discovery and direct activation require confirmed CA trust', async t => {
  const untrusted = new SystemProxyInterceptor({ ca: { systemTrustInstalled: false } });
  untrusted._isWindows = () => true;
  const unsafeCalls = [];
  untrusted._usesPerMachineProxyPolicy = () => { unsafeCalls.push('policy'); return false; };
  untrusted._readCurrentSettings = () => { unsafeCalls.push('read'); return {}; };
  untrusted._persistRecoveryState = () => unsafeCalls.push('journal');
  untrusted._setRegistryValue = () => unsafeCalls.push('write');
  untrusted._notifyWinInet = () => unsafeCalls.push('notify');

  assert.equal(await untrusted.isActivable(), false);
  await assert.rejects(
    untrusted.activate(8080),
    /requires the HTTP FreeKit CA to be installed in the Windows trust store/
  );
  assert.deepEqual(unsafeCalls, []);
  assert.equal(untrusted.active, false);
  assert.equal(untrusted.previousSettings, null);

  const trusted = new SystemProxyInterceptor({
    dataDir: createDataDir(t),
    ca: { systemTrustInstalled: true }
  });
  const { operations } = configureRegistry(trusted, {
    enabled: false,
    server: null,
    override: 'intranet.example'
  });
  assert.equal(await trusted.isActivable(), true);
  assert.deepEqual(await trusted.activate(8080), { success: true });
  assert.equal(trusted.active, true);
  assert.deepEqual(operations.slice(0, 4), [
    ['set', 'ProxyEnable', 'REG_DWORD', 1],
    ['set', 'ProxyServer', 'REG_SZ', '127.0.0.1:8080'],
    ['set', 'ProxyOverride', 'REG_SZ', ''],
    ['notify']
  ]);
});

test('manager wires CA trust and keeps Stop available after trust becomes unavailable', async t => {
  const ca = { systemTrustInstalled: false };
  const manager = new InterceptorManager(ca, { dataDir: createDataDir(t) });
  const interceptor = manager.interceptors.get('system-proxy');
  manager.interceptors = new Map([[interceptor.id, interceptor]]);
  const { operations, settings } = configureRegistry(interceptor, {
    enabled: false,
    server: 'corporate.proxy:8888',
    override: 'intranet.example;<local>'
  });

  assert.equal(interceptor.ca, ca);
  assert.equal((await manager.getAll())[0].activable, false);
  await assert.rejects(
    manager.activate('system-proxy', 8080),
    /System Proxy is not available on this system/
  );
  assert.deepEqual(operations, []);

  ca.systemTrustInstalled = true;
  assert.equal((await manager.getAll())[0].activable, true);
  await manager.activate('system-proxy', 8080);
  assert.equal(interceptor.active, true);
  assert.deepEqual(settings, {
    enabled: true,
    server: '127.0.0.1:8080',
    override: ''
  });

  ca.systemTrustInstalled = false;
  assert.equal((await manager.getAll())[0].activable, false);
  assert.equal(await interceptor.needsDeactivation(), true);
  await manager.deactivate('system-proxy');
  assert.equal(interceptor.active, false);
  assert.deepEqual(settings, {
    enabled: false,
    server: 'corporate.proxy:8888',
    override: 'intranet.example;<local>'
  });
});

test('untrusted CA does not block stale recovery and non-Windows behavior is unchanged', async t => {
  const dataDir = createDataDir(t);
  const recoveryFile = path.join(dataDir, 'system-proxy-recovery.json');
  fs.writeFileSync(recoveryFile, JSON.stringify({
    pid: 1234,
    proxyServer: '127.0.0.1:8080',
    ownedSettings: { enabled: true, server: '127.0.0.1:8080', override: '' },
    previousSettings: { enabled: false, server: null, override: 'intranet.example' }
  }));
  const recovery = new SystemProxyInterceptor({
    dataDir,
    ca: { systemTrustInstalled: false }
  });
  const { settings } = configureRegistry(recovery, {
    enabled: true,
    server: '127.0.0.1:8080',
    override: ''
  });
  recovery._isProcessRunning = () => false;

  assert.equal(await recovery.recoverStaleSettings(), true);
  assert.deepEqual(settings, {
    enabled: false,
    server: null,
    override: 'intranet.example'
  });
  assert.equal(fs.existsSync(recoveryFile), false);

  const nonWindows = new SystemProxyInterceptor({ ca: { systemTrustInstalled: true } });
  nonWindows._isWindows = () => false;
  assert.equal(await nonWindows.isActivable(), false);
  await assert.rejects(
    nonWindows.activate(8080),
    /System proxy interception not supported on this platform/
  );
});
