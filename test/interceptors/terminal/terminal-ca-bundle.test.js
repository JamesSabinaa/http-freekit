import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import vm from 'node:vm';

import {
  ExistingTerminalInterceptor,
  FreshTerminalInterceptor
} from '../../../src/interceptors/terminal-interceptors.js';
import { CertificateAuthority } from '../../../src/proxy/certificate-authority.js';
import {
  refreshTerminalCaBundle,
  terminalCaBundlePath
} from '../../../src/proxy/terminal-ca-bundle.js';

const REPLACING_TRUST_VARIABLES = [
  'SSL_CERT_FILE',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE'
];

function normalizePem(pem) {
  return `${String(pem).trim()}\n`;
}

function expectedBundle(publicRoots, freeKitCa) {
  return [...publicRoots, freeKitCa].map(normalizePem).join('\n');
}

function fakeLauncher(pid) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.killed = false;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.unref = () => {};
  proc.kill = (signal = 'SIGTERM') => {
    proc.killed = true;
    proc.signalCode = signal;
    queueMicrotask(() => proc.emit('exit', null, signal));
    return true;
  };
  return proc;
}

test('terminal CA bundle preserves every public root and appends FreeKit once', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-terminal-ca-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const freeKitCa = fs.readFileSync(ca.caCertPath, 'utf8');

  const bundlePath = ca.getTerminalCaBundlePath();
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  const certificates = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\n/g);

  assert.equal(bundlePath, path.join(dataDir, 'terminal-ca-bundle.pem'));
  assert.equal(bundlePath, terminalCaBundlePath(ca.caCertPath));
  assert.equal(bundle, expectedBundle(tls.rootCertificates, freeKitCa));
  assert.equal(certificates.length, tls.rootCertificates.length + 1);
  assert.deepEqual(certificates.slice(0, -1), tls.rootCertificates.map(normalizePem));
  assert.equal(certificates.at(-1), normalizePem(freeKitCa));
  assert.doesNotThrow(() => tls.createSecureContext({ ca: bundle }));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(bundlePath).mode & 0o777, 0o644);
  }
});

test('terminal CA bundle repairs an unchanged owner-only file for container readers', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-terminal-ca-mode-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const certificatePath = path.join(dataDir, 'ca.pem');
  const publicRoots = ['public root'];
  const freeKitCa = 'FreeKit root';
  fs.writeFileSync(certificatePath, freeKitCa);

  const bundlePath = terminalCaBundlePath(certificatePath);
  fs.writeFileSync(bundlePath, expectedBundle(publicRoots, freeKitCa), { mode: 0o600 });
  fs.chmodSync(bundlePath, 0o600);
  const chmodSync = fs.chmodSync;
  const chmodCalls = [];
  t.mock.method(fs, 'chmodSync', (filePath, mode) => {
    chmodCalls.push([filePath, mode]);
    return chmodSync(filePath, mode);
  });

  assert.equal(refreshTerminalCaBundle(certificatePath, { publicRoots }), bundlePath);
  assert.deepEqual(chmodCalls, [[bundlePath, 0o644]]);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(bundlePath).mode & 0o777, 0o644);
  }
});

test('terminal CA bundle refresh is atomic and preserves the last complete bundle on failure', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-terminal-ca-refresh-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const ca = new CertificateAuthority(dataDir);
  await ca.initialize();
  const bundlePath = ca.getTerminalCaBundlePath();
  const originalBundle = fs.readFileSync(bundlePath, 'utf8');
  const replacementCa = tls.rootCertificates.at(-1);
  fs.writeFileSync(ca.caCertPath, replacementCa);

  assert.throws(
    () => refreshTerminalCaBundle(ca.caCertPath, {
      renameFile: () => { throw new Error('simulated interrupted replacement'); }
    }),
    /simulated interrupted replacement/
  );
  assert.equal(fs.readFileSync(bundlePath, 'utf8'), originalBundle);
  assert.deepEqual(
    fs.readdirSync(dataDir).filter(name => name.includes('terminal-ca-bundle.pem.') && name.endsWith('.tmp')),
    []
  );

  assert.equal(refreshTerminalCaBundle(ca.caCertPath), bundlePath);
  assert.equal(
    fs.readFileSync(bundlePath, 'utf8'),
    expectedBundle(tls.rootCertificates, replacementCa)
  );
});

test('Fresh and Existing Terminal add the raw CA without replacing target trust roots', async t => {
  t.mock.method(console, 'log', () => {});
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-freekit-terminal-ca-shared-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const bundlePath = path.join(dataDir, 'terminal-ca-bundle.pem');
  fs.writeFileSync(bundlePath, 'shared public plus FreeKit bundle', { mode: 0o600 });
  const caPath = path.join(dataDir, 'ca.pem');
  fs.writeFileSync(caPath, 'raw FreeKit CA', { mode: 0o600 });
  let bundleRequests = 0;
  const ca = {
    getTerminalCaBundlePath: () => {
      bundleRequests += 1;
      return bundlePath;
    },
    getCertInfo: () => ({ certificatePath: caPath })
  };
  const inheritedTrust = {
    SSL_CERT_FILE: '/target/openssl-roots.pem',
    REQUESTS_CA_BUNDLE: '/target/python-roots.pem',
    CURL_CA_BUNDLE: '/target/curl-roots.pem',
    NODE_EXTRA_CA_CERTS: '/target/node-extra.pem'
  };

  for (const [index, platform] of ['win32', 'darwin', 'linux'].entries()) {
    const terminal = new FreshTerminalInterceptor();
    const launcher = fakeLauncher(9270 + index);
    let launch;
    terminal.ca = ca;
    terminal._platform = () => platform;
    terminal._environment = () => ({
      PATH: '/usr/bin:/bin',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      node_tls_reject_unauthorized: '0',
      Node_Tls_Reject_Unauthorized: '0',
      ...inheritedTrust
    });
    const sessionPid = 9370 + index;
    let sessionRunning = true;
    terminal._createPosixHandshake = () => ({
      directory: null,
      reportFile: path.join(dataDir, `${platform}.json`),
      acknowledgementFile: path.join(dataDir, `${platform}.ack`),
      nonce: `ca-bundle-${platform}`
    });
    terminal._waitForPosixShellReport = async () => sessionPid;
    terminal._acknowledgePosixShell = async () => {};
    terminal._cleanupTerminalHandshake = () => {};
    const identity = {
      pid: sessionPid,
      startTime: String(sessionPid),
      executable: platform === 'win32' ? 'c:\\windows\\powershell.exe' : '/bin/sh'
    };
    terminal._inspectSessionIdentity = async () => sessionRunning
      ? { state: 'running', identity }
      : { state: 'absent' };
    if (platform === 'win32') {
      terminal._waitForWindowsShellReport = async () => identity;
      terminal._acknowledgeWindowsShell = async () => {};
    }
    terminal._killSession = () => { sessionRunning = false; };
    terminal._startStatusMonitor = () => {};
    terminal._spawnDetached = async (command, args, options) => {
      launch = { command, args, options };
      return launcher;
    };

    await terminal.activate(8080);

    for (const variable of REPLACING_TRUST_VARIABLES) {
      assert.equal(launch.options.env[variable], inheritedTrust[variable], `${platform} ${variable}`);
    }
    assert.equal(
      launch.options.env.NODE_EXTRA_CA_CERTS,
      platform === 'win32' ? caPath : inheritedTrust.NODE_EXTRA_CA_CERTS,
      `${platform} NODE_EXTRA_CA_CERTS`
    );
    assert.equal('NODE_TLS_REJECT_UNAUTHORIZED' in launch.options.env, false, platform);
    for (const key of ['node_tls_reject_unauthorized', 'Node_Tls_Reject_Unauthorized']) {
      assert.equal(key in launch.options.env, platform !== 'win32', `${platform} ${key}`);
    }
    if (platform === 'win32' && process.platform === 'win32') {
      const child = spawnSync(process.execPath, [
        '-e', 'process.stdout.write(JSON.stringify(process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? null))'
      ], { env: launch.options.env, encoding: 'utf8', windowsHide: true });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, 'null');
    }
    if (platform !== 'win32') {
      const commandText = launch.args.join(' ').replace(/\\\\/g, '\\');
      assert.ok(commandText.includes('export NODE_EXTRA_CA_CERTS='), platform);
      assert.ok(commandText.includes(caPath), `${platform} raw CA path`);
      for (const variable of REPLACING_TRUST_VARIABLES) {
        assert.ok(!commandText.includes(`export ${variable}=`), `${platform} ${variable}`);
      }
    }

    await terminal.deactivate();
    assert.equal(fs.existsSync(bundlePath), true, `${platform} deactivation keeps shared bundle`);
  }

  const existing = new ExistingTerminalInterceptor();
  existing.ca = ca;
  const result = await existing.activate(8080);
  assert.equal(result.metadata.certPath, caPath);
  for (const instructions of Object.values(result.metadata.instructions)) {
    assert.ok(instructions.includes('NODE_EXTRA_CA_CERTS'));
    assert.ok(instructions.includes(caPath), caPath);
    for (const variable of REPLACING_TRUST_VARIABLES) {
      assert.ok(!instructions.includes(variable), variable);
    }
    assert.doesNotMatch(instructions, /NODE_TLS_REJECT_UNAUTHORIZED=['"]?0/);
  }
  assert.match(result.metadata.instructions.bash, /^unset NODE_TLS_REJECT_UNAUTHORIZED;/);
  assert.match(result.metadata.instructions.powershell, /^Remove-Item Env:NODE_TLS_REJECT_UNAUTHORIZED/);
  assert.match(result.metadata.instructions.cmd, /^set "NODE_TLS_REJECT_UNAUTHORIZED="/);
  assert.equal(bundleRequests, 0);
  await existing.deactivate();
  assert.equal(fs.existsSync(bundlePath), true);
});

test('renderer fallback adds only the FreeKit CA and restores normal TLS verification', () => {
  const source = fs.readFileSync(new URL('../../../src/ui/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function quoteTerminalBashValue(');
  const end = source.indexOf('function renderTerminalConfig(', start);
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}; globalThis.buildFallback = buildTerminalFallbackInstructions;`, context);
  const caPath = '/writable/data/ca.pem';
  const instructions = context.buildFallback('http://127.0.0.1:8080', caPath);

  for (const command of Object.values(instructions)) {
    assert.ok(command.includes('NODE_EXTRA_CA_CERTS'));
    assert.ok(command.includes(caPath), caPath);
    for (const variable of REPLACING_TRUST_VARIABLES) {
      assert.ok(!command.includes(variable), variable);
    }
    assert.doesNotMatch(command, /NODE_TLS_REJECT_UNAUTHORIZED=['"]?0/);
  }
});
