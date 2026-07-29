import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SystemProxyInterceptor } from '../src/interceptors/system-proxy-interceptor.js';

const OWNER = {
  pid: 4305,
  startedAt: '2026-01-02T03:04:05.000Z',
  executablePath: 'c:\\program files\\http freekit\\freekit.exe'
};

const PREVIOUS_SETTINGS = {
  enabled: false,
  server: 'corporate.proxy:8888',
  override: 'intranet.example;<local>'
};

const OWNED_SETTINGS = {
  enabled: true,
  server: '127.0.0.1:8080',
  override: ''
};

function makeDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-bug-305-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function writeRecovery(t, recovery) {
  const dataDir = makeDataDir(t);
  const recoveryFile = path.join(dataDir, 'system-proxy-recovery.json');
  fs.writeFileSync(recoveryFile, JSON.stringify(recovery));
  return { dataDir, recoveryFile };
}

function strongRecovery(owner = OWNER) {
  return {
    owner,
    proxyServer: OWNED_SETTINGS.server,
    ownedSettings: { ...OWNED_SETTINGS },
    previousSettings: { ...PREVIOUS_SETTINGS }
  };
}

function configureRegistry(interceptor, currentSettings) {
  const operations = [];
  interceptor._isWindows = () => true;
  interceptor._readCurrentSettings = () => ({ ...currentSettings });
  interceptor._setRegistryValue = (name, type, value) => {
    operations.push(['set', name, type, value]);
  };
  interceptor._deleteRegistryValue = name => operations.push(['delete', name]);
  interceptor._notifyWinInet = () => operations.push(['notify']);
  return operations;
}

test('Windows process identity lookup is bounded and normalizes every strong field', async () => {
  const interceptor = new SystemProxyInterceptor();
  let invocation;
  interceptor._execPowerShell = (script, options) => {
    invocation = { script, options };
    return JSON.stringify({
      pid: OWNER.pid,
      startedAt: '2026-01-02T03:04:05+00:00',
      executablePath: 'C:\\Program Files\\HTTP FreeKit\\bin\\..\\FreeKit.exe'
    });
  };

  const identity = await interceptor._lookupValidatedProcessIdentity(OWNER.pid);

  assert.deepEqual(identity, OWNER);
  assert.match(invocation.script, /Get-CimInstance -ClassName Win32_Process/);
  assert.match(invocation.script, /ProcessId = 4305/);
  assert.deepEqual(invocation.options, { encoding: 'utf8', timeout: 5000 });
});

test('activation journals normalized strong ownership before its first registry mutation', async t => {
  const dataDir = makeDataDir(t);
  const rawOwner = {
    pid: process.pid,
    startedAt: '2026-01-02T03:04:05+00:00',
    executablePath: 'C:\\Program Files\\HTTP FreeKit\\bin\\..\\FreeKit.exe'
  };
  const interceptor = new SystemProxyInterceptor({
    dataDir,
    ca: { systemTrustInstalled: true },
    processIdentityLookup: () => rawOwner
  });
  interceptor._isWindows = () => true;
  interceptor._usesPerMachineProxyPolicy = () => false;
  interceptor._readCurrentSettings = () => ({ ...PREVIOUS_SETTINGS });
  let checkedJournalBeforeMutation = false;
  interceptor._setRegistryValue = () => {
    if (checkedJournalBeforeMutation) return;
    const recovery = JSON.parse(fs.readFileSync(interceptor.recoveryFile, 'utf8'));
    assert.deepEqual(Object.keys(recovery).sort(), [
      'ownedSettings',
      'owner',
      'previousSettings',
      'proxyServer'
    ]);
    assert.deepEqual(recovery.owner, {
      pid: process.pid,
      startedAt: '2026-01-02T03:04:05.000Z',
      executablePath: OWNER.executablePath
    });
    checkedJournalBeforeMutation = true;
  };
  interceptor._notifyWinInet = () => {};

  await interceptor.activate(8080);

  assert.equal(checkedJournalBeforeMutation, true);
});

test('stale recovery skips only the same live strong owner', async t => {
  const { dataDir, recoveryFile } = writeRecovery(t, strongRecovery({
    ...OWNER,
    executablePath: 'C:\\Program Files\\HTTP FreeKit\\FreeKit.exe'
  }));
  const interceptor = new SystemProxyInterceptor({
    dataDir,
    processIdentityLookup: () => ({ ...OWNER })
  });
  interceptor._isWindows = () => true;
  interceptor._readCurrentSettings = () => assert.fail('a live owner must skip registry inspection');
  interceptor._setRegistryValue = () => assert.fail('a live owner must skip registry writes');

  assert.equal(await interceptor.recoverStaleSettings(), false);
  assert.equal(fs.existsSync(recoveryFile), true);
});

test('a reused PID with a different start timestamp restores stale owned settings', async t => {
  const { dataDir, recoveryFile } = writeRecovery(t, strongRecovery());
  const interceptor = new SystemProxyInterceptor({
    dataDir,
    processIdentityLookup: () => ({
      ...OWNER,
      startedAt: '2026-01-02T03:05:05.000Z'
    })
  });
  const operations = configureRegistry(interceptor, OWNED_SETTINGS);

  assert.equal(await interceptor.recoverStaleSettings(), true);
  assert.deepEqual(operations, [
    ['set', 'ProxyServer', 'REG_SZ', PREVIOUS_SETTINGS.server],
    ['set', 'ProxyOverride', 'REG_SZ', PREVIOUS_SETTINGS.override],
    ['set', 'ProxyEnable', 'REG_DWORD', 0],
    ['notify']
  ]);
  assert.equal(fs.existsSync(recoveryFile), false);
});

test('a definitely absent strong owner restores partial activation state', async t => {
  const { dataDir, recoveryFile } = writeRecovery(t, strongRecovery({
    ...OWNER,
    executablePath: 'C:\\Program Files\\HTTP FreeKit\\FreeKit.exe'
  }));
  const interceptor = new SystemProxyInterceptor({
    dataDir,
    processIdentityLookup: () => null
  });
  const operations = configureRegistry(interceptor, {
    enabled: OWNED_SETTINGS.enabled,
    server: OWNED_SETTINGS.server,
    override: PREVIOUS_SETTINGS.override
  });

  assert.equal(await interceptor.recoverStaleSettings(), true);
  assert.equal(operations.length, 4);
  assert.equal(fs.existsSync(recoveryFile), false);
});

test('identity lookup failures and malformed results preserve registry state and journal', async t => {
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  const lookups = [
    () => { throw new Error('access denied'); },
    () => ({ pid: OWNER.pid, startedAt: OWNER.startedAt })
  ];

  for (const processIdentityLookup of lookups) {
    const { dataDir, recoveryFile } = writeRecovery(t, strongRecovery());
    const interceptor = new SystemProxyInterceptor({ dataDir, processIdentityLookup });
    interceptor._isWindows = () => true;
    interceptor._readCurrentSettings = () => assert.fail('ambiguous identity must skip registry inspection');
    interceptor._setRegistryValue = () => assert.fail('ambiguous identity must skip registry writes');

    assert.equal(await interceptor.recoverStaleSettings(), false);
    assert.equal(fs.existsSync(recoveryFile), true);
  }

  assert.equal(errors.length, 2);
  assert.ok(errors.every(message => message.includes('Recovery owner identity is ambiguous')));
});

test('activation identity failure occurs before snapshot, journal, or registry mutation', async t => {
  const dataDir = makeDataDir(t);
  const interceptor = new SystemProxyInterceptor({
    dataDir,
    ca: { systemTrustInstalled: true },
    processIdentityLookup: () => ({ pid: process.pid, startedAt: 'invalid', executablePath: 'relative.exe' })
  });
  interceptor._isWindows = () => true;
  interceptor._usesPerMachineProxyPolicy = () => false;
  const unsafeCalls = [];
  interceptor._readCurrentSettings = () => { unsafeCalls.push('read'); return {}; };
  interceptor._persistRecoveryState = () => unsafeCalls.push('journal');
  interceptor._setRegistryValue = () => unsafeCalls.push('write');
  interceptor._notifyWinInet = () => unsafeCalls.push('notify');

  await assert.rejects(
    interceptor.activate(8080),
    /Failed to set system proxy: Process identity start timestamp is missing or invalid/
  );

  assert.deepEqual(unsafeCalls, []);
  assert.equal(interceptor.previousSettings, null);
  assert.equal(interceptor.pendingRecovery, null);
  assert.equal(interceptor.active, false);
  assert.equal(fs.existsSync(interceptor.recoveryFile), false);
});

test('activation refuses registry mutation when durable journal storage is unavailable', async () => {
  const interceptor = new SystemProxyInterceptor({
    ca: { systemTrustInstalled: true },
    processIdentityLookup: () => ({
      pid: process.pid,
      startedAt: OWNER.startedAt,
      executablePath: OWNER.executablePath
    })
  });
  interceptor._isWindows = () => true;
  interceptor._usesPerMachineProxyPolicy = () => false;
  interceptor._readCurrentSettings = () => ({ ...PREVIOUS_SETTINGS });
  let writes = 0;
  interceptor._setRegistryValue = () => { writes += 1; };
  interceptor._notifyWinInet = () => { writes += 1; };

  await assert.rejects(
    interceptor.activate(8080),
    /Failed to set system proxy: System proxy recovery journal is not configured/
  );

  assert.equal(writes, 0);
  assert.equal(interceptor.previousSettings, null);
  assert.equal(interceptor.pendingRecovery, null);
  assert.equal(interceptor.active, false);
});

test('legacy journals restore only when their PID is definitely dead', async t => {
  const legacy = {
    pid: OWNER.pid,
    proxyServer: OWNED_SETTINGS.server,
    ownedSettings: { ...OWNED_SETTINGS },
    previousSettings: { ...PREVIOUS_SETTINGS }
  };
  const dead = writeRecovery(t, legacy);
  const deadOwner = new SystemProxyInterceptor({
    dataDir: dead.dataDir,
    processIdentityLookup: () => assert.fail('legacy journals do not have a comparable identity')
  });
  deadOwner._isProcessRunning = () => false;
  configureRegistry(deadOwner, OWNED_SETTINGS);

  assert.equal(await deadOwner.recoverStaleSettings(), true);
  assert.equal(fs.existsSync(dead.recoveryFile), false);

  const live = writeRecovery(t, legacy);
  const liveOwner = new SystemProxyInterceptor({
    dataDir: live.dataDir,
    processIdentityLookup: () => assert.fail('a raw live PID is never promoted to strong ownership')
  });
  liveOwner._isWindows = () => true;
  liveOwner._isProcessRunning = () => true;
  liveOwner._readCurrentSettings = () => assert.fail('ambiguous legacy ownership must skip registry inspection');
  liveOwner._setRegistryValue = () => assert.fail('ambiguous legacy ownership must skip registry writes');
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));

  assert.equal(await liveOwner.recoverStaleSettings(), false);
  assert.equal(fs.existsSync(live.recoveryFile), true);
  assert.match(errors.at(-1), /PID is live but the journal has no strong owner identity/);

  const unknown = writeRecovery(t, legacy);
  const unknownOwner = new SystemProxyInterceptor({ dataDir: unknown.dataDir });
  unknownOwner._isWindows = () => true;
  unknownOwner._isProcessRunning = () => { throw new Error('liveness query denied'); };
  unknownOwner._readCurrentSettings = () => assert.fail('unknown legacy liveness must skip registry inspection');
  unknownOwner._setRegistryValue = () => assert.fail('unknown legacy liveness must skip registry writes');

  assert.equal(await unknownOwner.recoverStaleSettings(), false);
  assert.equal(fs.existsSync(unknown.recoveryFile), true);
  assert.match(errors.at(-1), /Legacy recovery owner is ambiguous: liveness query denied/);
});
