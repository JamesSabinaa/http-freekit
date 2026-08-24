import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FreshTerminalInterceptor } from '../../../src/interceptors/terminal-interceptors.js';

function fakeLauncher(pid = 9501) {
  const launcher = new EventEmitter();
  launcher.pid = pid;
  launcher.exitCode = null;
  launcher.signalCode = null;
  launcher.unref = () => {};
  launcher.kill = signal => {
    launcher.signalCode = signal;
    queueMicrotask(() => launcher.emit('exit', null, signal));
    return true;
  };
  return launcher;
}

test('POSIX handshakes are private, bounded, nonce-bound, and do not follow links', async t => {
  const interceptor = new FreshTerminalInterceptor();
  const handshake = interceptor._createPosixHandshake();
  t.after(() => interceptor._cleanupTerminalHandshake(handshake));

  assert.equal(path.dirname(handshake.reportFile), handshake.directory);
  assert.equal(path.dirname(handshake.acknowledgementFile), handshake.directory);
  assert.equal(path.dirname(handshake.ownershipMarkerFile), handshake.directory);
  assert.equal(path.basename(handshake.ownershipMarkerFile), 'ownership.marker');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(handshake.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(handshake.ownershipMarkerFile).mode & 0o777, 0o600);
  }
  assert.match(handshake.nonce, /^[a-f0-9]{64}$/);

  fs.writeFileSync(handshake.reportFile, JSON.stringify({
    nonce: handshake.nonce,
    pid: 9511
  }), { flag: 'wx', mode: 0o600 });
  assert.equal(await interceptor._waitForPosixShellReport(handshake), 9511);

  const linkedReport = path.join(handshake.directory, 'linked.json');
  fs.linkSync(handshake.reportFile, linkedReport);
  assert.throws(
    () => interceptor._readTerminalHandshakeReport(handshake.reportFile),
    /bounded regular file/
  );
  fs.unlinkSync(linkedReport);
  fs.unlinkSync(handshake.reportFile);

  const symlinkTarget = path.join(handshake.directory, 'target.json');
  fs.writeFileSync(symlinkTarget, JSON.stringify({ nonce: handshake.nonce, pid: 9511 }));
  try {
    fs.symlinkSync(symlinkTarget, handshake.reportFile, 'file');
    assert.throws(
      () => interceptor._readTerminalHandshakeReport(handshake.reportFile),
      /bounded regular file/
    );
    fs.unlinkSync(handshake.reportFile);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error;
  }
  fs.unlinkSync(symlinkTarget);

  fs.writeFileSync(handshake.reportFile, JSON.stringify({
    nonce: 'wrong-nonce',
    pid: 9511
  }), { flag: 'wx', mode: 0o600 });
  await assert.rejects(
    interceptor._waitForPosixShellReport(handshake, 10),
    /nonce-bound process ID/
  );
  fs.unlinkSync(handshake.reportFile);

  fs.writeFileSync(handshake.reportFile, 'x'.repeat(4097), { flag: 'wx', mode: 0o600 });
  assert.throws(
    () => interceptor._readTerminalHandshakeReport(handshake.reportFile),
    /bounded regular file/
  );
});

test('a persisted macOS ownership marker survives handshake cleanup until session cleanup', t => {
  const interceptor = new FreshTerminalInterceptor({ platform: 'darwin' });
  const handshake = interceptor._createPosixHandshake();
  t.after(() => interceptor._cleanupTerminalHandshake(handshake));

  interceptor._cleanupTerminalHandshake(handshake, { preserveOwnershipMarker: true });

  assert.equal(fs.existsSync(handshake.directory), true);
  assert.equal(fs.existsSync(handshake.ownershipMarkerFile), true);
  assert.equal(fs.existsSync(handshake.reportFile), false);
  assert.equal(fs.existsSync(handshake.acknowledgementFile), false);

  interceptor._cleanupOwnershipMarker({ ownershipMarkerFile: handshake.ownershipMarkerFile });
  assert.equal(fs.existsSync(handshake.directory), false);
});

test('a POSIX spawn rejection removes its private handshake directory', async () => {
  const interceptor = new FreshTerminalInterceptor({ platform: 'linux' });
  const handshake = interceptor._createPosixHandshake();
  interceptor._spawnDetached = async () => {
    const error = new Error('spawn terminal ENOENT');
    error.code = 'ENOENT';
    throw error;
  };

  await assert.rejects(
    interceptor._launchTrackedPosixTerminal('missing-terminal', [], {}, handshake),
    error => error?.code === 'ENOENT'
  );

  assert.equal(fs.existsSync(handshake.directory), false);
});

test('POSIX acknowledgement is exclusive and waits for the child to consume its nonce', async t => {
  const interceptor = new FreshTerminalInterceptor();
  const handshake = interceptor._createPosixHandshake();
  t.after(() => interceptor._cleanupTerminalHandshake(handshake));
  let observedAcknowledgement;
  interceptor._sleep = async () => {
    if (!fs.existsSync(handshake.acknowledgementFile)) return;
    observedAcknowledgement = fs.readFileSync(handshake.acknowledgementFile, 'utf8');
    fs.unlinkSync(handshake.acknowledgementFile);
  };

  await interceptor._acknowledgePosixShell(handshake);
  assert.equal(observedAcknowledgement, handshake.nonce);

  fs.writeFileSync(handshake.acknowledgementFile, 'stale', { flag: 'wx', mode: 0o600 });
  await assert.rejects(
    interceptor._acknowledgePosixShell(handshake),
    error => error?.code === 'EEXIST'
  );
});

test('POSIX activation journals verified ownership before releasing proxy environment', async () => {
  const interceptor = new FreshTerminalInterceptor({ platform: 'linux' });
  const launcher = fakeLauncher();
  const handshake = {
    directory: null,
    reportFile: '/private/freekit/identity.json',
    acknowledgementFile: '/private/freekit/acknowledgement.txt',
    nonce: 'a'.repeat(64)
  };
  const owner = { pid: 9512, startTime: '9512', executable: '/bin/sh' };
  const order = [];
  let running = true;
  let launch;

  interceptor.ca = { getTerminalCaBundlePath: () => '/tmp/freekit-ca-bundle.pem' };
  interceptor._environment = () => ({ PATH: '/usr/bin:/bin' });
  interceptor._createPosixHandshake = () => handshake;
  interceptor._waitForPosixShellReport = async () => owner.pid;
  interceptor._inspectSessionIdentity = async () => running
    ? { state: 'running', identity: owner }
    : { state: 'absent' };
  interceptor._writeSessionJournal = sessions => {
    if (sessions.size > 0) {
      assert.equal(sessions.has(owner.pid), true);
      order.push('journal');
    }
  };
  interceptor._acknowledgePosixShell = async received => {
    assert.equal(received, handshake);
    order.push('acknowledge');
  };
  interceptor._cleanupTerminalHandshake = () => { order.push('cleanup-handshake'); };
  interceptor._spawnDetached = async (command, args, options) => {
    launch = { command, args, options };
    return launcher;
  };
  interceptor._killSession = () => {
    running = false;
    return true;
  };
  interceptor._startStatusMonitor = () => {};

  const result = await interceptor.activate(8080);

  assert.equal(result.pid, owner.pid);
  assert.deepEqual(order.slice(0, 3), ['journal', 'acknowledge', 'cleanup-handshake']);
  assert.equal(launch.options.env.HTTP_PROXY, undefined);
  assert.equal(launch.options.env.SSL_CERT_FILE, undefined);
  const command = launch.args.at(-1);
  assert.ok(command.indexOf('freeKitAcknowledged') < command.indexOf('export HTTP_PROXY='));
  assert.match(command, /\[ "\$freeKitAcknowledged" -eq 1 \] \|\| exit 1/);

  await interceptor.deactivate();
});
