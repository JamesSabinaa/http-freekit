import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ElectronInterceptor } from '../../../src/interceptors/electron-interceptor.js';
import { JvmInterceptor } from '../../../src/interceptors/jvm-interceptor.js';

const PID = 424242;
const BOOT_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const BOOT_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const TARGET = { pid: String(PID), name: 'Example', mainClass: 'example.Main' };

class LinuxJvmInterceptor extends JvmInterceptor {
  _platform() { return 'linux'; }
}

class LinuxElectronInterceptor extends ElectronInterceptor {
  _platform() { return 'linux'; }
}

function identity(bootId = BOOT_A) {
  return { pid: PID, startTime: '1000', executable: '/opt/example/app', bootId };
}

function fixture(t, kind, owner = identity()) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-boot-ownership-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const recoveryFile = path.join(dataDir, 'ownership.json');
  if (owner) {
    const journal = kind === 'JVM'
      ? { version: 1, processes: [{ ...TARGET, state: 'active', identity: owner }] }
      : { version: 1, platform: 'linux', ...owner };
    fs.writeFileSync(recoveryFile, JSON.stringify(journal));
  }
  let currentIdentity = identity();
  let actionCount = 0;
  const Interceptor = kind === 'JVM' ? LinuxJvmInterceptor : LinuxElectronInterceptor;
  const interceptor = new Interceptor({
    recoveryFile,
    processIdentityLookup: async () => currentIdentity
      ? { state: 'running', identity: currentIdentity }
      : { state: 'absent' }
  });
  interceptor._getRunningProcesses = async () => [TARGET];
  interceptor._attachAgent = async () => { actionCount++; return { success: true }; };
  interceptor._killOwnedPid = pid => {
    assert.equal(pid, PID);
    actionCount++;
    currentIdentity = null;
    return true;
  };
  interceptor.deactivationTimeoutMs = 10;
  interceptor.processExitPollIntervalMs = 1;
  return {
    interceptor,
    recoveryFile,
    setIdentity: value => { currentIdentity = value; },
    actions: () => actionCount
  };
}

for (const kind of ['JVM', 'Electron']) {
  test(`${kind} Linux recovery authorizes the same boot and canonicalizes its ID`, async t => {
    const f = fixture(t, kind, identity(BOOT_A.toUpperCase()));
    assert.equal(f.interceptor.recoveryJournalError, null);
    assert.equal(await f.interceptor.isActive(), true);
    await f.interceptor.deactivate();
    assert.equal(f.actions(), 1);
    assert.equal(f.interceptor.active, false);
    assert.equal(fs.existsSync(f.recoveryFile), false);
  });

  test(`${kind} Linux recovery refuses a cross-boot collision in PID, ticks and executable`, async t => {
    const f = fixture(t, kind);
    f.setIdentity(identity(BOOT_B));
    await f.interceptor.deactivate();
    assert.equal(f.actions(), 0);
    assert.equal(f.interceptor.active, false);
    assert.equal(fs.existsSync(f.recoveryFile), false);
  });

  for (const bootId of [undefined, '', 'not-a-boot-id']) {
    test(`${kind} Linux legacy or invalid boot identity ${String(bootId)} cannot authorize recovery`, async t => {
      t.mock.method(console, 'warn', () => {});
      const f = fixture(t, kind, { ...identity(), bootId });
      const contents = fs.readFileSync(f.recoveryFile, 'utf8');
      assert.ok(f.interceptor.recoveryJournalError);
      assert.equal(await f.interceptor.isActive(), false);
      if (kind === 'JVM') {
        await f.interceptor.deactivate();
        const result = await f.interceptor.activate(8080, { pid: String(PID) });
        assert.equal(result.success, false);
        assert.match(result.error, /recovery journal is invalid/i);
      } else {
        await assert.rejects(f.interceptor.deactivate(), /ownership journal is invalid/);
        await assert.rejects(
          f.interceptor.activate(8080, { appPath: '/opt/example/app' }),
          /ownership journal is invalid/
        );
      }
      assert.equal(f.actions(), 0);
      assert.equal(fs.readFileSync(f.recoveryFile, 'utf8'), contents);
    });

    test(`${kind} Linux missing or invalid current boot ${String(bootId)} retains recovery for retry`, async t => {
      const f = fixture(t, kind);
      f.setIdentity({ ...identity(), bootId });
      await assert.rejects(f.interceptor.deactivate(), /Stop can be retried/);
      assert.equal(f.actions(), 0);
      assert.equal(f.interceptor.active, true);
      assert.equal(fs.existsSync(f.recoveryFile), true);
      f.setIdentity(identity());
      await f.interceptor.deactivate();
      assert.equal(f.actions(), 1);
      assert.equal(fs.existsSync(f.recoveryFile), false);
    });
  }

  test(`${kind} native Linux inspection reads boot identity around process metadata`, async t => {
    const f = fixture(t, kind, null);
    const reads = [];
    const statFields = Array(20).fill('0');
    statFields[0] = 'S';
    statFields[19] = '1000';
    t.mock.method(fs.promises, 'readFile', async filename => {
      reads.push(filename);
      if (filename === '/proc/sys/kernel/random/boot_id') return `${BOOT_A.toUpperCase()}\n`;
      assert.equal(filename, path.join(`/proc/${PID}`, 'stat'));
      return `${PID} (example app) ${statFields.join(' ')}`;
    });
    t.mock.method(fs.promises, 'readlink', async filename => {
      assert.equal(filename, path.join(`/proc/${PID}`, 'exe'));
      return identity().executable;
    });
    t.mock.method(process, 'kill', () => assert.fail('native identity inspection must use only stubbed reads'));
    const observed = kind === 'JVM'
      ? await f.interceptor._inspectTargetIdentity(PID)
      : await f.interceptor._inspectProcessIdentity(PID);
    assert.deepEqual(observed, { state: 'running', identity: identity() });
    assert.deepEqual(reads, [
      '/proc/sys/kernel/random/boot_id',
      path.join(`/proc/${PID}`, 'stat'),
      path.join(`/proc/${PID}`, 'stat'),
      '/proc/sys/kernel/random/boot_id'
    ]);
  });
}

test('JVM journals the Linux boot before attachment and rechecks it after helper preparation', async t => {
  const f = fixture(t, 'JVM', null);
  f.interceptor._attachAgent = async () => {
    const pending = JSON.parse(fs.readFileSync(f.recoveryFile, 'utf8')).processes[0];
    assert.equal(pending.state, 'pending');
    assert.equal(pending.identity.bootId, BOOT_A);
    return { success: true };
  };
  assert.equal((await f.interceptor.activate(8080, { pid: String(PID) })).success, true);
  f.interceptor._attachAgent = JvmInterceptor.prototype._attachAgent;
  f.interceptor._getAgentJarPath = async () => 'stub-agent.jar';
  f.interceptor._ensureAttachHelper = async () => {
    f.setIdentity(identity(BOOT_B));
    return 'stub-helper';
  };
  f.interceptor._runAttachHelper = async () => assert.fail('changed boot must not receive a restore attach');
  await f.interceptor.deactivate();
  assert.equal(f.interceptor.active, false);
  assert.equal(fs.existsSync(f.recoveryFile), false);
});

test('Electron records Linux boot at launch and rechecks it immediately before a recovered signal', async t => {
  const f = fixture(t, 'Electron', null);
  const child = new EventEmitter();
  Object.assign(child, { pid: PID, exitCode: null, signalCode: null });
  child.kill = () => assert.fail('the live child must not be signalled in this test');
  f.interceptor.startupConfirmationMs = 0;
  f.interceptor.ca = { systemTrustInstalled: true, getTerminalCaBundlePath: () => process.execPath };
  f.interceptor._spawn = () => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  await f.interceptor.activate(8080, { appPath: '/opt/example/app' });
  assert.equal(JSON.parse(fs.readFileSync(f.recoveryFile, 'utf8')).bootId, BOOT_A);
  let observations = 0;
  const recovered = new LinuxElectronInterceptor({
    recoveryFile: f.recoveryFile,
    processIdentityLookup: async () => ({
      state: 'running', identity: identity(++observations === 1 ? BOOT_A : BOOT_B)
    })
  });
  recovered._killOwnedPid = () => assert.fail('changed boot must not receive a signal');
  await recovered.deactivate();
  assert.equal(observations, 2);
  assert.equal(recovered.active, false);
  assert.equal(fs.existsSync(f.recoveryFile), false);
});
