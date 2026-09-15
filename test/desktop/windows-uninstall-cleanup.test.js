import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { SystemProxyInterceptor } from '../../src/interceptors/system-proxy-interceptor.js';

import {
  cleanupWindowsInstallation,
  collectOwnedCaFingerprints
} from '../../src/windows-uninstall-cleanup.js';

function createDataDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-uninstall-'));
  const dataDir = path.join(root, 'http-freekit', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return dataDir;
}

async function interruptedProxyFixture(t) {
  const dataDir = createDataDirectory(t);
  const owner = { pid: process.pid, startedAt: '2026-01-02T03:04:05.000Z', executablePath: 'C:\\FreeKit\\node.exe' };
  const baseline = { enabled: true, server: 'corporate.proxy:8888', override: '<local>',
    autoConfigUrl: 'https://corporate.example/proxy.pac', autoDetect: true };
  const baselineHttp = { scope: 'user', proxy: '', proxyBypass: '', autoConfigUrl: '', autoDetect: true };
  const state = { winInet: { ...baseline }, winHttp: { ...baselineHttp }, live: true,
    failHttp: false, failNotify: false, writes: [], certificates: [] };
  function createInterceptor(directory) {
    const interceptor = new SystemProxyInterceptor({ dataDir: directory,
      ca: { systemTrustInstalled: true }, processIdentityLookup: () => state.live ? owner : null });
    interceptor._isWindows = () => true;
    interceptor._usesPerMachineProxyPolicy = () => false;
    interceptor._readCurrentSettings = () => ({ ...state.winInet });
    const fields = { ProxyEnable: 'enabled', ProxyServer: 'server', ProxyOverride: 'override',
      AutoConfigURL: 'autoConfigUrl', AutoDetect: 'autoDetect' };
    interceptor._setRegistryValue = (name, type, value) => {
      state.writes.push(name);
      state.winInet[fields[name]] = type === 'REG_DWORD' ? !!value : value;
    };
    interceptor._deleteRegistryValue = name => { state.writes.push(name); state.winInet[fields[name]] = null; };
    interceptor._notifyWinInet = () => { if (state.failNotify) throw new Error('notification failed'); };
    interceptor._readWinHttpSettings = () => ({ ...state.winHttp });
    interceptor._setWinHttpSettings = settings => {
      if (state.failHttp) throw new Error('WinHTTP restoration denied');
      state.writes.push('WinHTTP'); state.winHttp = { ...settings };
    };
    return interceptor;
  }
  const active = createInterceptor(dataDir);
  await active.activate(8081);
  state.live = false;
  state.writes.length = 0;
  fs.writeFileSync(path.join(dataDir, 'ca-active.json'), JSON.stringify({ version: 1, fingerprint: 'AB'.repeat(20) }));
  const options = { platform: 'win32', createSystemProxyInterceptor: createInterceptor,
    run: (executable, args) => {
      assert.equal(fs.existsSync(active.recoveryFile), false);
      assert.equal(fs.existsSync(active.winHttpRecoveryFile), false);
      state.certificates.push({ executable, args });
    } };
  return { dataDir, state, baseline, baselineHttp, options, active };
}

test('uninstall recovers interrupted WinINET and WinHTTP activation before removing trust and data', async t => {
  const fixture = await interruptedProxyFixture(t);
  const { dataDir, state, baseline, baselineHttp, options } = fixture;
  const result = await cleanupWindowsInstallation(dataDir, options);
  assert.equal(result.removed, true);
  assert.deepEqual(state.winInet, baseline);
  assert.deepEqual(state.winHttp, baselineHttp);
  assert.equal(state.certificates.length, 1);
  assert.equal(fs.existsSync(dataDir), false);
});

test('uninstall preserves newer external proxy settings without restoration writes', async t => {
  const { dataDir, state, options } = await interruptedProxyFixture(t);
  state.winInet.server = 'new-owner.example:9090';
  state.winHttp.proxy = 'new-owner.example:9091';
  const expected = { winInet: { ...state.winInet }, winHttp: { ...state.winHttp } };
  await cleanupWindowsInstallation(dataDir, options);
  assert.deepEqual(state.winInet, expected.winInet);
  assert.deepEqual(state.winHttp, expected.winHttp);
  assert.deepEqual(state.writes, []);
});

for (const failure of ['failHttp', 'failNotify', 'live']) {
  test(`uninstall retains recovery and certificates after ${failure}, then permits retry`, async t => {
    const { dataDir, state, baseline, baselineHttp, options } = await interruptedProxyFixture(t);
    state[failure] = true;
    await assert.rejects(cleanupWindowsInstallation(dataDir, options), /recovery is incomplete/);
    assert.equal(fs.existsSync(dataDir), true);
    assert.equal(state.certificates.length, 0);
    assert.ok(['system-proxy-recovery.json', 'winhttp-proxy-recovery.json']
      .some(name => fs.existsSync(path.join(dataDir, name))));
    if (failure === 'live') assert.deepEqual(state.writes, []);
    state[failure] = false;
    await cleanupWindowsInstallation(dataDir, options);
    assert.deepEqual(state.winInet, baseline);
    assert.deepEqual(state.winHttp, baselineHttp);
    assert.equal(fs.existsSync(dataDir), false);
  });
}

test('malformed proxy journals prevent deletion even when other recovery succeeds', async t => {
  const { dataDir, state, options, active } = await interruptedProxyFixture(t);
  fs.writeFileSync(active.recoveryFile, '{invalid');
  await assert.rejects(cleanupWindowsInstallation(dataDir, options), /recovery is incomplete/);
  assert.equal(fs.readFileSync(active.recoveryFile, 'utf8'), '{invalid');
  assert.equal(state.certificates.length, 0);
  assert.equal(fs.existsSync(dataDir), true);
});

test('uninstall CLI exits unsuccessfully and retains malformed proxy recovery data', {
  skip: process.platform !== 'win32'
}, t => {
  const dataDir = createDataDirectory(t);
  const journal = path.join(dataDir, 'system-proxy-recovery.json');
  fs.writeFileSync(journal, '{invalid');
  const result = spawnSync(process.execPath, ['src/windows-uninstall-cleanup.js', dataDir], {
    encoding: 'utf8', windowsHide: true, timeout: 10000
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\[Uninstall\].*recovery is incomplete/);
  assert.equal(fs.readFileSync(journal, 'utf8'), '{invalid');
});

test('Windows uninstall removes every exact owned fingerprint before deleting the private data', async t => {
  const dataDir = createDataDirectory(t);
  const activeFingerprint = 'AB'.repeat(20);
  const replacedFingerprint = 'CD'.repeat(20);
  const migratedFingerprint = '12'.repeat(20);
  fs.writeFileSync(path.join(dataDir, 'ca.key'), 'private-key-evidence');
  fs.writeFileSync(path.join(dataDir, 'ca-active.json'), JSON.stringify({
    version: 1,
    fingerprint: activeFingerprint
  }));
  fs.writeFileSync(path.join(dataDir, 'ca-replacements.json'), JSON.stringify({
    version: 2,
    fingerprints: [replacedFingerprint]
  }));
  fs.writeFileSync(path.join(dataDir, 'ca-migration.json'), JSON.stringify({
    version: 1,
    previousFingerprint: migratedFingerprint
  }));
  const calls = [];

  const result = await cleanupWindowsInstallation(dataDir, {
    platform: 'win32',
    run(executable, args) { calls.push({ executable, args }); }
  });

  assert.deepEqual(result.fingerprints, [activeFingerprint, replacedFingerprint, migratedFingerprint]);
  assert.deepEqual(calls.map(call => call.args), [
    ['-delstore', '-user', 'Root', activeFingerprint],
    ['-delstore', '-user', 'Root', replacedFingerprint],
    ['-delstore', '-user', 'Root', migratedFingerprint]
  ]);
  assert.equal(fs.existsSync(dataDir), false);
});

test('failed trust removal preserves the private data for recovery', async t => {
  const dataDir = createDataDirectory(t);
  const activeFingerprint = 'EF'.repeat(20);
  fs.writeFileSync(path.join(dataDir, 'ca.key'), 'private-key-evidence');
  fs.writeFileSync(path.join(dataDir, 'ca-active.json'), JSON.stringify({
    version: 1,
    fingerprint: activeFingerprint
  }));

  await assert.rejects(() => cleanupWindowsInstallation(dataDir, {
    platform: 'win32',
    run() { throw new Error('simulated certificate-store failure'); }
  }), /Could not remove 1 trusted CA certificate/);
  assert.equal(fs.existsSync(path.join(dataDir, 'ca.key')), true);
});

test('uninstall cleanup rejects broad paths and malformed ownership journals', async t => {
  const dataDir = createDataDirectory(t);
  fs.writeFileSync(path.join(dataDir, 'ca-active.json'), '{not-json');

  assert.throws(() => collectOwnedCaFingerprints(dataDir), SyntaxError);
  await assert.rejects(
    () => cleanupWindowsInstallation(path.dirname(dataDir), { platform: 'win32' }),
    /unexpected data directory/
  );
});

test('NSIS runs cleanup only for a true uninstall and retains updater replacements', () => {
  const config = fs.readFileSync('electron-builder.config.cjs', 'utf8');
  const include = fs.readFileSync('build/installer.nsh', 'utf8');

  assert.match(config, /include:\s*['"]build\/installer\.nsh['"]/);
  assert.match(include, /\$\{ifNot\}\s+\$\{isUpdated\}/);
  assert.match(include, /windows-uninstall-cleanup\.js/);
  assert.match(include, /\$APPDATA\\http-freekit\\data/);
  assert.match(include, /\$\{if\} \$0 != 0[\s\S]*Abort /);
  const template = fs.readFileSync('node_modules/app-builder-lib/templates/nsis/uninstaller.nsh', 'utf8');
  assert.match(template, /!insertmacro customUnInstall[\s\S]*# delete the installed files/);
});
