import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SystemProxyInterceptor } from '../src/interceptors/system-proxy-interceptor.js';

const uiSource = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');

const OWNER = {
  pid: process.pid,
  startedAt: '2026-01-02T03:04:05.000Z',
  executablePath: 'C:\\Program Files\\HTTP FreeKit\\freekit.exe'
};

const PREVIOUS_WININET = {
  enabled: true,
  server: 'corporate.proxy:8888',
  override: 'intranet.example;<local>'
};

const PREVIOUS_WINHTTP = {
  scope: 'user',
  proxy: 'http=legacy.proxy:8080;https=legacy.proxy:8443',
  proxyBypass: '*.internal.example',
  autoConfigUrl: 'https://config.example/proxy.pac',
  autoDetect: true
};

function makeDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-winhttp-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function configureInterceptor(t) {
  const winInet = { ...PREVIOUS_WININET };
  let winHttp = { ...PREVIOUS_WINHTTP };
  const operations = [];
  const interceptor = new SystemProxyInterceptor({
    dataDir: makeDataDir(t),
    ca: { systemTrustInstalled: true },
    processIdentityLookup: () => OWNER
  });
  interceptor._isWindows = () => true;
  interceptor._usesPerMachineProxyPolicy = async () => false;
  interceptor._readCurrentSettings = async () => ({ ...winInet });
  interceptor._setRegistryValue = async (name, type, value) => {
    operations.push(['wininet-set', name, type, value]);
    if (name === 'ProxyEnable') winInet.enabled = Boolean(value);
    if (name === 'ProxyServer') winInet.server = value;
    if (name === 'ProxyOverride') winInet.override = value;
  };
  interceptor._deleteRegistryValue = async name => {
    operations.push(['wininet-delete', name]);
    if (name === 'ProxyServer') winInet.server = null;
    if (name === 'ProxyOverride') winInet.override = null;
  };
  interceptor._notifyWinInet = async () => operations.push(['wininet-notify']);
  interceptor._readWinHttpSettings = async () => ({ ...winHttp });
  interceptor._setWinHttpSettings = async settings => {
    operations.push(['winhttp-set', { ...settings }]);
    winHttp = { ...settings };
  };
  return {
    interceptor,
    operations,
    getWinInet: () => ({ ...winInet }),
    setWinInet: settings => Object.assign(winInet, settings),
    getWinHttp: () => ({ ...winHttp }),
    setWinHttp: settings => { winHttp = { ...settings }; }
  };
}

test('System Proxy configures machine WinHTTP and restores both proxy stores exactly', async t => {
  const harness = configureInterceptor(t);
  const { interceptor } = harness;

  await interceptor.activate(8080);

  assert.deepEqual(harness.getWinInet(), {
    enabled: true,
    server: '127.0.0.1:8080',
    override: ''
  });
  assert.deepEqual(harness.getWinHttp(), {
    scope: 'machine',
    proxy: '127.0.0.1:8080',
    proxyBypass: '',
    autoConfigUrl: '',
    autoDetect: false
  });
  assert.equal(fs.existsSync(interceptor.recoveryFile), true);
  assert.equal(fs.existsSync(interceptor.winHttpRecoveryFile), true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(interceptor.winHttpRecoveryFile, 'utf8')),
    {
      owner: { ...OWNER, executablePath: OWNER.executablePath.toLowerCase() },
      previousSettings: PREVIOUS_WINHTTP,
      ownedSettings: harness.getWinHttp()
    }
  );

  await interceptor.deactivate();

  assert.deepEqual(harness.getWinInet(), PREVIOUS_WININET);
  assert.deepEqual(harness.getWinHttp(), PREVIOUS_WINHTTP);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
  assert.equal(fs.existsSync(interceptor.winHttpRecoveryFile), false);
  assert.equal(await interceptor.needsDeactivation(), false);
  assert.equal(interceptor.active, false);
});

test('Stop restores each owned proxy store while preserving independent external changes', async t => {
  const changedWinInet = configureInterceptor(t);
  await changedWinInet.interceptor.activate(8081);
  changedWinInet.operations.length = 0;
  changedWinInet.setWinInet({
    enabled: true,
    server: 'vpn.proxy:3128',
    override: '<local>'
  });

  await changedWinInet.interceptor.deactivate();

  assert.deepEqual(changedWinInet.getWinInet(), {
    enabled: true,
    server: 'vpn.proxy:3128',
    override: '<local>'
  });
  assert.deepEqual(changedWinInet.getWinHttp(), PREVIOUS_WINHTTP);
  assert.equal(
    changedWinInet.operations.some(([operation]) => operation.startsWith('wininet-')),
    false
  );

  const changedWinHttp = configureInterceptor(t);
  await changedWinHttp.interceptor.activate(8082);
  changedWinHttp.operations.length = 0;
  const externalWinHttp = {
    scope: 'machine',
    proxy: 'security.proxy:9000',
    proxyBypass: 'updates.example',
    autoConfigUrl: '',
    autoDetect: false
  };
  changedWinHttp.setWinHttp(externalWinHttp);

  await changedWinHttp.interceptor.deactivate();

  assert.deepEqual(changedWinHttp.getWinInet(), PREVIOUS_WININET);
  assert.deepEqual(changedWinHttp.getWinHttp(), externalWinHttp);
  assert.equal(
    changedWinHttp.operations.some(([operation]) => operation === 'winhttp-set'),
    false
  );
});

test('a failed WinHTTP activation rolls both stores back and clears both journals', async t => {
  const harness = configureInterceptor(t);
  const { interceptor } = harness;
  let winHttpWrites = 0;
  interceptor._setWinHttpSettings = async settings => {
    winHttpWrites += 1;
    harness.setWinHttp(settings);
    if (winHttpWrites === 1) throw new Error('machine WinHTTP access denied');
  };

  await assert.rejects(interceptor.activate(8080), /machine WinHTTP access denied/);

  assert.deepEqual(harness.getWinInet(), PREVIOUS_WININET);
  assert.deepEqual(harness.getWinHttp(), PREVIOUS_WINHTTP);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
  assert.equal(fs.existsSync(interceptor.winHttpRecoveryFile), false);
  assert.equal(await interceptor.needsDeactivation(), false);
  assert.equal(interceptor.active, false);
});

test('a WinHTTP journal cleanup failure retains exact retry ownership', async t => {
  const harness = configureInterceptor(t);
  const { interceptor } = harness;
  await interceptor.activate(8080);
  const removeJournal = interceptor._removeWinHttpRecoveryState.bind(interceptor);
  let removals = 0;
  interceptor._removeWinHttpRecoveryState = () => {
    if (++removals === 1) throw new Error('WinHTTP journal unlink denied');
    removeJournal();
  };

  await assert.rejects(interceptor.deactivate(), /WinHTTP journal unlink denied/);

  assert.deepEqual(harness.getWinInet(), PREVIOUS_WININET);
  assert.deepEqual(harness.getWinHttp(), PREVIOUS_WINHTTP);
  assert.equal(interceptor.winHttpRestorePending, true);
  assert.equal(await interceptor.needsDeactivation(), true);
  assert.equal(fs.existsSync(interceptor.winHttpRecoveryFile), true);

  await interceptor.deactivate();

  assert.deepEqual(harness.getWinHttp(), PREVIOUS_WINHTTP);
  assert.equal(fs.existsSync(interceptor.winHttpRecoveryFile), false);
  assert.equal(interceptor.winHttpRestorePending, false);
  assert.equal(await interceptor.needsDeactivation(), false);
});

test('stale WinHTTP ownership is restored, while external WinHTTP changes are preserved', async t => {
  const restoredDataDir = makeDataDir(t);
  const restored = new SystemProxyInterceptor({
    dataDir: restoredDataDir,
    processIdentityLookup: () => null
  });
  restored._isWindows = () => true;
  const owned = {
    scope: 'machine',
    proxy: '127.0.0.1:8080',
    proxyBypass: '',
    autoConfigUrl: '',
    autoDetect: false
  };
  fs.writeFileSync(restored.winHttpRecoveryFile, JSON.stringify({
    owner: { ...OWNER, executablePath: OWNER.executablePath.toLowerCase() },
    previousSettings: PREVIOUS_WINHTTP,
    ownedSettings: owned
  }));
  let current = { ...owned };
  restored._readWinHttpSettings = async () => ({ ...current });
  restored._setWinHttpSettings = async settings => { current = { ...settings }; };

  assert.equal(await restored.recoverStaleSettings(), true);
  assert.deepEqual(current, PREVIOUS_WINHTTP);
  assert.equal(fs.existsSync(restored.winHttpRecoveryFile), false);

  const externalDataDir = makeDataDir(t);
  const external = new SystemProxyInterceptor({
    dataDir: externalDataDir,
    processIdentityLookup: () => null
  });
  external._isWindows = () => true;
  fs.writeFileSync(external.winHttpRecoveryFile, JSON.stringify({
    owner: { ...OWNER, executablePath: OWNER.executablePath.toLowerCase() },
    previousSettings: PREVIOUS_WINHTTP,
    ownedSettings: owned
  }));
  external._readWinHttpSettings = async () => ({
    scope: 'machine',
    proxy: 'newer.proxy:9443',
    proxyBypass: '',
    autoConfigUrl: '',
    autoDetect: false
  });
  external._setWinHttpSettings = async () => assert.fail('external settings must not be overwritten');

  assert.equal(await external.recoverStaleSettings(), false);
  assert.equal(fs.existsSync(external.winHttpRecoveryFile), false);
  assert.equal(external.winHttpRecoveryBlockedReason, null);
});

test('malformed WinHTTP recovery blocks activation without overwriting its only journal', async t => {
  const dataDir = makeDataDir(t);
  const interceptor = new SystemProxyInterceptor({
    dataDir,
    ca: { systemTrustInstalled: true }
  });
  interceptor._isWindows = () => true;
  fs.writeFileSync(interceptor.winHttpRecoveryFile, '{malformed');

  assert.equal(await interceptor.recoverStaleSettings(), false);
  await assert.rejects(
    interceptor.activate(8080),
    /blocked by an unresolved WinHTTP recovery journal/
  );
  assert.equal(fs.readFileSync(interceptor.winHttpRecoveryFile, 'utf8'), '{malformed');
});

test('live strong owners block activation for both recovery journals until ownership is released', async t => {
  const harness = configureInterceptor(t);
  const { interceptor } = harness;
  const owner = {
    ...OWNER,
    pid: OWNER.pid + 100000,
    executablePath: OWNER.executablePath.toLowerCase()
  };
  interceptor._processIdentityLookup = pid => pid === owner.pid ? owner : OWNER;
  const ownedWinInet = {
    enabled: true,
    server: '127.0.0.1:8080',
    override: ''
  };
  const ownedWinHttp = {
    scope: 'machine',
    proxy: '127.0.0.1:8080',
    proxyBypass: '',
    autoConfigUrl: '',
    autoDetect: false
  };
  const winInetJournal = JSON.stringify({
    owner,
    proxyServer: ownedWinInet.server,
    previousSettings: PREVIOUS_WININET,
    ownedSettings: ownedWinInet
  });
  const winHttpJournal = JSON.stringify({
    owner,
    previousSettings: PREVIOUS_WINHTTP,
    ownedSettings: ownedWinHttp
  });
  fs.writeFileSync(interceptor.recoveryFile, winInetJournal);
  fs.writeFileSync(interceptor.winHttpRecoveryFile, winHttpJournal);

  assert.equal(await interceptor.recoverStaleSettings(), false);
  assert.match(interceptor.recoveryBlockedReason, /active FreeKit process/);
  assert.match(interceptor.winHttpRecoveryBlockedReason, /active FreeKit process/);
  assert.equal(await interceptor.needsDeactivation(), true);
  await assert.rejects(interceptor.activate(8081), /unresolved recovery journal/);
  assert.equal(fs.readFileSync(interceptor.recoveryFile, 'utf8'), winInetJournal);
  assert.equal(fs.readFileSync(interceptor.winHttpRecoveryFile, 'utf8'), winHttpJournal);

  fs.unlinkSync(interceptor.recoveryFile);
  fs.unlinkSync(interceptor.winHttpRecoveryFile);
  await interceptor.activate(8081);
  assert.equal(interceptor.recoveryBlockedReason, null);
  assert.equal(interceptor.winHttpRecoveryBlockedReason, null);
  assert.equal(interceptor.active, true);
  await interceptor.deactivate();
  assert.equal(await interceptor.needsDeactivation(), false);
});

test('activation retries exact-owner recovery after the prior process exits', async t => {
  const harness = configureInterceptor(t);
  const { interceptor } = harness;
  const owner = {
    ...OWNER,
    pid: OWNER.pid + 100001,
    executablePath: OWNER.executablePath.toLowerCase()
  };
  interceptor._processIdentityLookup = pid => pid === owner.pid ? owner : OWNER;
  const ownedWinInet = { enabled: true, server: '127.0.0.1:8080', override: '' };
  const ownedWinHttp = {
    scope: 'machine', proxy: '127.0.0.1:8080', proxyBypass: '', autoConfigUrl: '', autoDetect: false
  };
  harness.setWinInet(ownedWinInet);
  harness.setWinHttp(ownedWinHttp);
  fs.writeFileSync(interceptor.recoveryFile, JSON.stringify({
    owner,
    proxyServer: ownedWinInet.server,
    previousSettings: PREVIOUS_WININET,
    ownedSettings: ownedWinInet
  }));
  fs.writeFileSync(interceptor.winHttpRecoveryFile, JSON.stringify({
    owner,
    previousSettings: PREVIOUS_WINHTTP,
    ownedSettings: ownedWinHttp
  }));

  assert.equal(await interceptor.recoverStaleSettings(), false);
  interceptor._processIdentityLookup = pid => pid === owner.pid ? null : OWNER;

  await interceptor.activate(8083);

  assert.equal(interceptor.active, true);
  assert.deepEqual(interceptor.previousSettings, PREVIOUS_WININET);
  assert.deepEqual(interceptor.previousWinHttpSettings, PREVIOUS_WINHTTP);
  assert.deepEqual(harness.getWinInet(), {
    enabled: true, server: '127.0.0.1:8083', override: ''
  });
  assert.deepEqual(harness.getWinHttp(), {
    scope: 'machine', proxy: '127.0.0.1:8083', proxyBypass: '', autoConfigUrl: '', autoDetect: false
  });
  await interceptor.deactivate();
});

test('exclusive journal publication never replaces a concurrently owned proxy baseline', async t => {
  for (const occupiedStore of ['wininet', 'winhttp']) {
    await t.test(occupiedStore, async t => {
      const harness = configureInterceptor(t);
      const { interceptor } = harness;
      const occupiedFile = occupiedStore === 'wininet'
        ? interceptor.recoveryFile
        : interceptor.winHttpRecoveryFile;
      const existingJournal = JSON.stringify({ owner: 'another-process', baseline: 'must-survive' });
      fs.writeFileSync(occupiedFile, existingJournal);

      await assert.rejects(interceptor.activate(8082), /Failed to set system proxy/);

      assert.equal(fs.readFileSync(occupiedFile, 'utf8'), existingJournal);
      assert.equal(fs.existsSync(interceptor.recoveryFile), occupiedStore === 'wininet');
      assert.equal(fs.existsSync(interceptor.winHttpRecoveryFile), occupiedStore === 'winhttp');
      assert.deepEqual(harness.getWinInet(), PREVIOUS_WININET);
      assert.deepEqual(harness.getWinHttp(), PREVIOUS_WINHTTP);
      assert.equal(harness.operations.length, 0);
    });
  }
});

test('temp-link cleanup failure cannot hide successfully published recovery journals', async t => {
  const harness = configureInterceptor(t);
  const { interceptor } = harness;
  const unlinkSync = fs.unlinkSync.bind(fs);
  t.mock.method(fs, 'unlinkSync', target => {
    if (String(target).endsWith('.tmp')) throw new Error('temp unlink denied');
    return unlinkSync(target);
  });

  await interceptor.activate(8084);

  assert.equal(interceptor.active, true);
  assert.equal(fs.existsSync(interceptor.recoveryFile), true);
  assert.equal(fs.existsSync(interceptor.winHttpRecoveryFile), true);
  assert.equal(
    fs.readdirSync(path.dirname(interceptor.recoveryFile)).filter(name => name.endsWith('.tmp')).length,
    2
  );
  await interceptor.deactivate();
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
  assert.equal(fs.existsSync(interceptor.winHttpRecoveryFile), false);
});

test('WinHTTP netsh helpers parse localized prefixes and verify the applied machine settings', async () => {
  const interceptor = new SystemProxyInterceptor();
  const expected = {
    scope: 'machine',
    proxy: '127.0.0.1:8080',
    proxyBypass: '',
    autoConfigUrl: '',
    autoDetect: false
  };
  const calls = [];
  interceptor._execFile = async (command, args) => {
    calls.push([command, args]);
    if (args[1] === 'show') {
      return `Localized heading\n${JSON.stringify({
        ProxyIsEnabled: true,
        Proxy: expected.proxy,
        ProxyBypass: expected.proxyBypass,
        AutoConfigIsEnabled: false,
        AutoDetect: false,
        PerUserProxySettings: false
      })}\n`;
    }
    return 'OK';
  };

  await interceptor._setWinHttpSettings(expected);

  assert.deepEqual(calls[0][0], 'netsh.exe');
  assert.deepEqual(calls[0][1].slice(0, 4), [
    'winhttp',
    'set',
    'advproxy',
    'setting-scope=machine'
  ]);
  assert.deepEqual(JSON.parse(calls[0][1][4].slice('settings='.length)), {
    Proxy: '127.0.0.1:8080',
    ProxyBypass: '',
    AutoconfigUrl: '',
    AutoDetect: false
  });
  assert.deepEqual(calls[1][1], ['winhttp', 'show', 'advproxy']);
});

test('System Proxy UI states its WinINet and WinHTTP scope without promising all traffic', () => {
  const description = uiSource.match(/'system-proxy': \[(.*?)\],/)?.[1] || '';
  assert.match(description, /current-user WinINet/);
  assert.match(description, /machine WinHTTP/);
  assert.match(description, /custom proxy settings may bypass it/);
  assert.doesNotMatch(description, /all (?:HTTP|system) traffic/i);
});
